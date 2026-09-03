"""Boundary tests for the Crossref citation auditor."""

from __future__ import annotations

import os

import httpx
import pytest

from zotero_research_mcp.citations import (
    CitationAuditor,
    CitationRequest,
    NetworkAccessDisabledError,
    normalize_doi,
)

TARGET_DOI = "10.5555/example.2020"
TARGET_TITLE = "A Reproducible Example"


def _work_message(**overrides: object) -> dict[str, object]:
    message: dict[str, object] = {
        "DOI": TARGET_DOI,
        "title": [TARGET_TITLE],
        "published": {"date-parts": [[2020, 1, 2]]},
        "URL": "https://publisher.example/articles/example",
        "update-to": [],
    }
    message.update(overrides)
    return message


def _empty_updates_response() -> httpx.Response:
    return httpx.Response(200, json={"message": {"total-results": 0, "items": []}})


def _transport(
    *,
    work_response: httpx.Response | None = None,
    updates_response: httpx.Response | None = None,
) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert request.method == "GET"
        assert request.url.scheme == "https"
        assert request.url.host == "api.crossref.org"
        if request.url.path == "/v1/works":
            return updates_response or _empty_updates_response()
        if request.url.path.startswith("/v1/works/"):
            return work_response or httpx.Response(
                200,
                json={"message": _work_message()},
            )
        raise AssertionError(f"unexpected Crossref path: {request.url}")

    return httpx.MockTransport(handler), calls


def test_normalize_doi_and_doi_org_url() -> None:
    assert normalize_doi("  DOI:10.5555/EXAMPLE.2020  ") == TARGET_DOI
    assert normalize_doi("https://doi.org/10.5555/EXAMPLE.2020") == TARGET_DOI
    assert normalize_doi("http://doi.org/10.5555/example.2020") == TARGET_DOI


@pytest.mark.parametrize(
    "value",
    [
        "https://example.org/10.5555/example.2020",
        "doi.org/10.5555/example.2020",
        "https://doi.org/10.5555/example.2020?download=1",
        "10.555/example.2020",
        "10.5555/example with spaces",
        "10.5555/" + "x" * 256,
    ],
)
def test_normalize_doi_rejects_fake_or_invalid_values(value: str) -> None:
    with pytest.raises((TypeError, ValueError)):
        normalize_doi(value)


def test_network_is_denied_before_transport_is_used() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        raise AssertionError("network must not be attempted")

    auditor = CitationAuditor(transport=httpx.MockTransport(handler))
    with pytest.raises(NetworkAccessDisabledError):
        auditor.audit([CitationRequest(doi=TARGET_DOI)])
    assert calls == []


def test_audit_matches_metadata_and_reports_no_notice_without_clean_status() -> None:
    transport, calls = _transport()
    report = CitationAuditor(transport=transport).audit(
        [CitationRequest(doi=f"https://doi.org/{TARGET_DOI}", title=TARGET_TITLE, year=2020)],
        allow_network=True,
    )

    result = report.results[0]
    assert len(calls) == 2
    assert calls[0].url.path == f"/v1/works/{TARGET_DOI}"
    assert "select" not in calls[0].url.params
    assert calls[1].url.path == "/v1/works"
    assert calls[1].url.params["filter"] == f"updates:{TARGET_DOI}"
    assert calls[1].url.params["rows"] == "20"
    assert result.status == "no_notice_found"
    assert result.doi_exists is True
    assert result.title_match is True
    assert result.year_match is True
    assert result.updates == []
    assert result.source_doi == TARGET_DOI
    assert result.source_url.startswith("https://api.crossref.org/v1/works/")
    assert result.landing_url == "https://publisher.example/articles/example"
    assert result.checked_at.tzinfo is not None
    assert "not a clean" in " ".join(report.warnings)
    assert any("does not establish" in issue for issue in result.issues)


def test_different_crossref_doi_is_identity_mismatch_not_target_existence() -> None:
    transport, calls = _transport(
        work_response=httpx.Response(
            200,
            json={"message": _work_message(DOI="10.5555/other.2020")},
        )
    )
    result = (
        CitationAuditor(transport=transport)
        .audit(
            [CitationRequest(doi=TARGET_DOI)],
            allow_network=True,
        )
        .results[0]
    )

    assert len(calls) == 1
    assert result.status == "identity_mismatch"
    assert result.doi_exists is None
    assert result.title_match is None
    assert result.year_match is None
    assert result.crossref_doi == "10.5555/other.2020"
    assert any("unreliable" in issue for issue in result.issues)


def test_title_and_year_mismatches_are_explicit() -> None:
    transport, _calls = _transport(
        work_response=httpx.Response(
            200,
            json={
                "message": _work_message(
                    **{
                        "title": ["Different title"],
                        "published": {"date-parts": [[2019]]},
                    }
                )
            },
        )
    )
    result = (
        CitationAuditor(transport=transport)
        .audit(
            [CitationRequest(doi=TARGET_DOI, title=TARGET_TITLE, year=2020)],
            allow_network=True,
        )
        .results[0]
    )

    assert result.status == "metadata_mismatch"
    assert result.doi_exists is True
    assert result.title_match is False
    assert result.year_match is False
    assert any("title does not match" in issue.casefold() for issue in result.issues)
    assert any("year does not match" in issue.casefold() for issue in result.issues)


def test_direct_update_to_retraction_is_reported_as_a_signal() -> None:
    transport, _calls = _transport(
        work_response=httpx.Response(
            200,
            json={
                "message": _work_message(
                    **{
                        "update-to": [
                            {
                                "DOI": "10.5555/retraction.2021",
                                "type": "retraction",
                                "label": "Retraction",
                                "source": "publisher",
                                "updated": {"date-parts": [[2021, 3, 4]]},
                            }
                        ]
                    }
                )
            },
        )
    )
    result = (
        CitationAuditor(transport=transport)
        .audit(
            [CitationRequest(doi=TARGET_DOI)],
            allow_network=True,
        )
        .results[0]
    )

    assert result.status == "retraction_signal"
    assert len(result.updates) == 1
    assert result.updates[0].doi == "10.5555/retraction.2021"
    assert result.updates[0].target_doi == TARGET_DOI
    assert result.updates[0].source == "publisher"
    assert result.updates[0].updated_at is not None


def test_inverse_updates_query_finds_typed_correction() -> None:
    transport, calls = _transport(
        updates_response=httpx.Response(
            200,
            json={
                "message": {
                    "total-results": 1,
                    "items": [
                        {
                            "DOI": "10.5555/correction.2021",
                            "update-to": [
                                {
                                    "DOI": TARGET_DOI,
                                    "type": "correction",
                                    "label": "Correction",
                                    "source": "publisher",
                                }
                            ],
                        }
                    ],
                }
            },
        )
    )
    result = (
        CitationAuditor(transport=transport)
        .audit(
            [CitationRequest(doi=TARGET_DOI)],
            allow_network=True,
        )
        .results[0]
    )

    assert calls[1].url.params["filter"] == f"updates:{TARGET_DOI}"
    assert result.status == "correction_signal"
    assert result.updates[0].doi == "10.5555/correction.2021"
    assert result.updates[0].target_doi == TARGET_DOI


def test_malformed_inverse_item_forces_unknown_without_generic_update() -> None:
    transport, _calls = _transport(
        updates_response=httpx.Response(
            200,
            json={
                "message": {
                    "total-results": 1,
                    "items": [
                        {
                            "DOI": "10.5555/broken.2021",
                            "update-to": "not-a-list",
                        }
                    ],
                }
            },
        )
    )
    result = (
        CitationAuditor(transport=transport)
        .audit(
            [CitationRequest(doi=TARGET_DOI)],
            allow_network=True,
        )
        .results[0]
    )

    assert result.status == "unknown"
    assert result.updates == []
    assert any("malformed update-to" in issue for issue in result.issues)


def test_explicit_inverse_retraction_survives_another_malformed_relation() -> None:
    transport, _calls = _transport(
        updates_response=httpx.Response(
            200,
            json={
                "message": {
                    "total-results": 1,
                    "items": [
                        {
                            "DOI": "10.5555/retraction.2021",
                            "update-to": [
                                {
                                    "DOI": TARGET_DOI,
                                    "type": "retraction",
                                },
                                "malformed",
                            ],
                        }
                    ],
                }
            },
        )
    )
    result = (
        CitationAuditor(transport=transport)
        .audit(
            [CitationRequest(doi=TARGET_DOI)],
            allow_network=True,
        )
        .results[0]
    )

    assert result.status == "retraction_signal"
    assert result.updates[0].type == "retraction"
    assert any("non-object entry" in issue for issue in result.issues)


def test_created_date_is_not_used_as_publication_year() -> None:
    message = _work_message()
    message.pop("published")
    message["created"] = {"date-parts": [[2020, 1, 2]]}
    transport, _calls = _transport(work_response=httpx.Response(200, json={"message": message}))
    result = (
        CitationAuditor(transport=transport)
        .audit(
            [CitationRequest(doi=TARGET_DOI, year=2020)],
            allow_network=True,
        )
        .results[0]
    )

    assert result.crossref_year is None
    assert result.year_match is None
    assert any("registration dates" in issue for issue in result.issues)
    assert any("publication year" in issue for issue in result.issues)


def test_doi_is_encoded_as_one_path_segment_without_traversal() -> None:
    traversal_doi = "10.5555/a/../b"
    transport, calls = _transport(
        work_response=httpx.Response(
            200,
            json={"message": _work_message(DOI=traversal_doi)},
        )
    )
    result = (
        CitationAuditor(transport=transport)
        .audit(
            [CitationRequest(doi=traversal_doi)],
            allow_network=True,
        )
        .results[0]
    )

    assert result.doi == traversal_doi
    raw_path = calls[0].url.raw_path.decode("ascii")
    assert raw_path == "/v1/works/10.5555%2Fa%2F..%2Fb"
    assert "/../" not in raw_path
    assert calls[0].url.path.startswith("/v1/works/")


@pytest.mark.parametrize(
    ("response", "expected_status"),
    [
        (httpx.Response(404), "not_found"),
        (httpx.Response(429), "rate_limited"),
        (httpx.Response(200, text="not-json"), "malformed_json"),
    ],
)
def test_http_404_429_and_malformed_json_are_distinguished(
    response: httpx.Response,
    expected_status: str,
) -> None:
    transport, calls = _transport(work_response=response)
    result = (
        CitationAuditor(transport=transport)
        .audit(
            [CitationRequest(doi=TARGET_DOI)],
            allow_network=True,
        )
        .results[0]
    )

    assert len(calls) == 1
    assert result.status == expected_status
    if expected_status == "not_found":
        assert result.doi_exists is False
    else:
        assert result.doi_exists is None


def test_not_found_has_false_existence_without_claiming_verification() -> None:
    transport, _calls = _transport(work_response=httpx.Response(404))
    result = (
        CitationAuditor(transport=transport)
        .audit(
            [CitationRequest(doi=TARGET_DOI)],
            allow_network=True,
        )
        .results[0]
    )

    assert result.status == "not_found"
    assert result.doi_exists is False
    assert result.title_match is None
    assert result.year_match is None


def test_timeout_and_connection_errors_are_distinguished() -> None:
    def timeout_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    def connection_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    timeout_result = (
        CitationAuditor(transport=httpx.MockTransport(timeout_handler))
        .audit(
            [CitationRequest(doi=TARGET_DOI)],
            allow_network=True,
        )
        .results[0]
    )
    connection_result = (
        CitationAuditor(transport=httpx.MockTransport(connection_handler))
        .audit(
            [CitationRequest(doi=TARGET_DOI)],
            allow_network=True,
        )
        .results[0]
    )

    assert timeout_result.status == "timeout"
    assert connection_result.status == "connection_error"


def test_cross_domain_redirect_is_not_followed() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            302,
            headers={"location": "https://evil.example/collect"},
        )

    result = (
        CitationAuditor(transport=httpx.MockTransport(handler))
        .audit(
            [CitationRequest(doi=TARGET_DOI)],
            allow_network=True,
        )
        .results[0]
    )

    assert len(calls) == 1
    assert result.status == "redirect_refused"
    assert "not followed" in result.issues[0]


def test_batch_limit_is_twenty() -> None:
    requests = [CitationRequest(doi=f"10.5555/example.{index}") for index in range(21)]
    with pytest.raises(ValueError, match="20"):
        CitationAuditor().audit(requests, allow_network=True)


@pytest.mark.skipif(
    os.environ.get("RUN_CITATION_NETWORK_SMOKE") != "1",
    reason="opt-in real Crossref smoke test",
)
def test_crossref_real_network_smoke_uses_public_doi_only() -> None:
    report = CitationAuditor().audit(
        [
            CitationRequest(
                doi="10.1038/nature12373",
                title="Nanometre-scale thermometry in a living cell",
                year=2013,
            )
        ],
        allow_network=True,
    )
    result = report.results[0]
    assert result.doi_exists is True
    assert result.title_match is True
    assert result.year_match is True
