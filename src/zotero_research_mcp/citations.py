"""Crossref-backed citation metadata auditing.

The auditor deliberately treats Crossref as a metadata signal source, not as a
guarantee of publication integrity.  It never downloads a landing page, PDF, or
Zotero content, and it never sends citation text to a model.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, cast
from urllib.parse import quote, unquote, urlparse

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_CITATIONS = 20
MAX_DOI_LENGTH = 255
"""Maximum normalized DOI length accepted by this boundary."""

_CROSSREF_BASE_URL = "https://api.crossref.org/v1"
_CROSSREF_HOST = "api.crossref.org"
_CROSSREF_WORKS_URL = f"{_CROSSREF_BASE_URL}/works"
_DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_DOI_PATTERN = re.compile(
    r"^10\.\d{4,9}/[^\s<>\"{}|\\^`?#]+$",
    re.IGNORECASE,
)
_SELECT_FIELDS = "DOI,title,published,published-print,published-online,issued,update-to,URL"
_BASE_WARNINGS = [
    "Crossref is a single metadata source; this is not independent multi-source validation.",
    "A no_notice_found result is not a clean or not-retracted determination.",
    "Crossref update metadata can be incomplete or delayed; review publisher records "
    "for a definitive status.",
]

CitationStatus = Literal[
    "no_notice_found",
    "unknown",
    "not_found",
    "connection_error",
    "timeout",
    "rate_limited",
    "malformed_json",
    "malformed_response",
    "redirect_refused",
    "http_error",
    "retraction_signal",
    "correction_signal",
    "update_signal",
    "title_mismatch",
    "year_mismatch",
    "metadata_mismatch",
]


def normalize_doi(value: str) -> str:
    """Normalize a DOI name or a strict ``doi.org`` URL.

    Only DOI names beginning with a Crossref-compatible ``10.`` registrant
    prefix are accepted.  URL input is restricted to ``doi.org`` so that a
    publisher URL or an arbitrary URL cannot silently become an audit target.
    The returned DOI is lower-cased because DOI comparison and resolution are
    case-insensitive for this audit boundary.
    """

    if not isinstance(value, str):
        raise TypeError("doi must be a string")
    candidate = value.strip()
    if not candidate:
        raise ValueError("doi must not be empty")
    if len(candidate) > 2048:
        raise ValueError("doi input is too long")

    lower_candidate = candidate.casefold()
    if lower_candidate.startswith("doi:"):
        candidate = candidate[4:].strip()
    elif "://" in candidate or lower_candidate.startswith(("http:", "https:")):
        try:
            parts = urlparse(candidate)
            host = parts.hostname
            port = parts.port
        except ValueError as exc:
            raise ValueError("doi URL is malformed") from exc
        if parts.scheme.casefold() not in {"http", "https"}:
            raise ValueError("doi URL must use http or https")
        if host is None or host.casefold() != "doi.org":
            raise ValueError("only doi.org URLs are accepted")
        if port is not None or parts.username is not None or parts.password is not None:
            raise ValueError("doi URL must not contain credentials or a port")
        if parts.query or parts.fragment or parts.params:
            raise ValueError("doi URL must not contain a query, fragment, or parameters")
        if not parts.path.startswith("/") or parts.path.startswith("//"):
            raise ValueError("doi URL must contain one DOI path")
        candidate = unquote(parts.path[1:])
    elif lower_candidate.startswith(("doi.org/", "www.doi.org/", "dx.doi.org/")):
        raise ValueError("doi.org input must be an http(s) URL")

    candidate = candidate.strip()
    if len(candidate) > MAX_DOI_LENGTH:
        raise ValueError(f"doi must be at most {MAX_DOI_LENGTH} characters")
    if any(ord(char) < 32 or ord(char) == 127 for char in candidate):
        raise ValueError("doi must not contain control characters")
    if not _DOI_PATTERN.fullmatch(candidate):
        raise ValueError("doi is not a valid DOI name")
    return candidate.casefold()


class CitationRequest(BaseModel):
    """One DOI and optional bibliographic expectations to compare."""

    model_config = ConfigDict(extra="forbid")

    doi: str
    title: str | None = Field(default=None, max_length=2000)
    year: int | None = Field(default=None, ge=1000, le=9999)

    @field_validator("doi")
    @classmethod
    def _normalize_doi(cls, value: str) -> str:
        return normalize_doi(value)

    @field_validator("title")
    @classmethod
    def _normalize_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class CitationSource(BaseModel):
    """A Crossref endpoint used for one result."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["work", "updates_query"]
    doi: str
    url: str


class CitationUpdate(BaseModel):
    """One typed Crossref update clue, such as a correction or retraction."""

    model_config = ConfigDict(extra="forbid")

    doi: str | None = None
    target_doi: str | None = None
    type: str = Field(min_length=1)
    label: str | None = None
    source: str | None = None
    updated_at: datetime | None = None
    record_id: int | None = None
    source_url: str
    relation: Literal["update-to", "updates-query"]


class CitationAuditResult(BaseModel):
    """Audited metadata and update signals for one citation request."""

    model_config = ConfigDict(extra="forbid")

    request: CitationRequest
    doi: str
    status: CitationStatus
    doi_exists: bool | None = None
    title_match: bool | None = None
    year_match: bool | None = None
    crossref_doi: str | None = None
    crossref_title: str | None = None
    crossref_year: int | None = None
    landing_url: str | None = None
    updates: list[CitationUpdate] = Field(default_factory=list)
    source_doi: str
    source_url: str
    sources: list[CitationSource] = Field(default_factory=list)
    checked_at: datetime
    issues: list[str] = Field(default_factory=list)

    @property
    def update_to(self) -> list[CitationUpdate]:
        """Compatibility view named after Crossref's ``update-to`` field."""

        return self.updates

    @property
    def verified_at(self) -> datetime:
        """Alias for callers that use ``verified_at`` terminology."""

        return self.checked_at


class CitationAuditReport(BaseModel):
    """Batch citation audit report."""

    model_config = ConfigDict(extra="forbid")

    results: list[CitationAuditResult]
    warnings: list[str] = Field(default_factory=list)


class NetworkAccessDisabledError(PermissionError):
    """Raised before any HTTP request when network access was not opted in."""


@dataclass(frozen=True)
class _FetchOutcome:
    kind: str
    payload: Mapping[str, Any] | None
    url: str
    status_code: int | None = None
    issue: str | None = None


class CitationAuditor:
    """Audit DOI metadata against the Crossref public REST API.

    ``transport`` is an injection seam for tests.  The production URL is not
    configurable: every request is an HTTPS GET to ``api.crossref.org`` and
    redirects are disabled.
    """

    def __init__(self, transport: httpx.BaseTransport | None = None) -> None:
        self._transport = transport

    def audit(
        self,
        requests: list[CitationRequest],
        *,
        allow_network: bool = False,
    ) -> CitationAuditReport:
        """Audit at most 20 requests, requiring explicit network opt-in."""

        if len(requests) > MAX_CITATIONS:
            raise ValueError(f"at most {MAX_CITATIONS} citations may be audited at once")
        if any(not isinstance(request, CitationRequest) for request in requests):
            raise TypeError("audit requests must contain CitationRequest objects")
        if not requests:
            return CitationAuditReport(results=[], warnings=list(_BASE_WARNINGS))
        if not allow_network:
            raise NetworkAccessDisabledError(
                "Network access is disabled; pass allow_network=True to query Crossref."
            )

        checked_at = datetime.now(UTC)
        results: list[CitationAuditResult] = []
        with httpx.Client(
            transport=self._transport,
            follow_redirects=False,
            timeout=_DEFAULT_TIMEOUT,
            headers={
                "Accept": "application/json",
                "User-Agent": "zotero-research-mcp-citation-auditor/0.1",
            },
            trust_env=False,
        ) as client:
            for request in requests:
                results.append(self._audit_one(client, request, checked_at))

        warnings = list(_BASE_WARNINGS)
        if any(result.status in _ERROR_STATUSES for result in results):
            warnings.append(
                "At least one Crossref request failed or returned an unusable response; "
                "those results are not verification passes."
            )
        return CitationAuditReport(results=results, warnings=_dedupe(warnings))

    def _audit_one(
        self,
        client: httpx.Client,
        request: CitationRequest,
        checked_at: datetime,
    ) -> CitationAuditResult:
        work_url = _work_url(request.doi)
        sources = [CitationSource(kind="work", doi=request.doi, url=work_url)]
        direct = _fetch_json(client, work_url)
        if direct.kind != "ok" or direct.payload is None:
            return _error_result(
                request=request,
                outcome=direct,
                checked_at=checked_at,
                sources=sources,
            )

        message = direct.payload
        issues: list[str] = []
        crossref_doi = _safe_normalize(message.get("DOI"))
        if crossref_doi is None:
            issues.append("Crossref response did not contain a valid DOI.")
        elif crossref_doi != request.doi:
            issues.append("Crossref returned metadata for a different DOI.")

        crossref_title = _first_title(message.get("title"))
        crossref_year = _publication_year(message)
        title_match = _match_title(request.title, crossref_title, issues)
        year_match = _match_year(request.year, crossref_year, issues)
        landing_url = _optional_url(message.get("URL"))

        direct_updates, direct_update_issues = _parse_direct_updates(
            message.get("update-to"),
            request.doi,
            work_url,
        )
        issues.extend(direct_update_issues)
        updates = direct_updates
        secondary_failed = False

        updates_url = _updates_query_url(request.doi)
        sources.append(CitationSource(kind="updates_query", doi=request.doi, url=updates_url))
        inverse = _fetch_json(client, updates_url)
        if inverse.kind == "ok" and inverse.payload is not None:
            inverse_updates, inverse_issues = _parse_inverse_updates(
                inverse.payload,
                request.doi,
                updates_url,
            )
            updates = _merge_updates(updates, inverse_updates)
            issues.extend(inverse_issues)
        else:
            secondary_failed = True
            issues.append(
                "Crossref inverse update query failed: "
                f"{inverse.kind}" + (f" ({inverse.issue})" if inverse.issue else ".")
            )

        if crossref_doi is None:
            status: CitationStatus = "malformed_response"
        else:
            status = _status_for(
                updates,
                title_match=title_match,
                year_match=year_match,
                secondary_failed=secondary_failed,
                relation_malformed=bool(direct_update_issues),
            )
        if status == "no_notice_found":
            issues.append(
                "No retraction or correction signal was found in Crossref metadata; "
                "this does not establish that the work is not retracted."
            )

        return CitationAuditResult(
            request=request,
            doi=request.doi,
            status=status,
            doi_exists=crossref_doi is not None,
            title_match=title_match,
            year_match=year_match,
            crossref_doi=crossref_doi,
            crossref_title=crossref_title,
            crossref_year=crossref_year,
            landing_url=landing_url,
            updates=updates,
            source_doi=request.doi,
            source_url=work_url,
            sources=sources,
            checked_at=checked_at,
            issues=_dedupe(issues),
        )


_ERROR_STATUSES: frozenset[CitationStatus] = frozenset(
    {
        "unknown",
        "not_found",
        "connection_error",
        "timeout",
        "rate_limited",
        "malformed_json",
        "malformed_response",
        "redirect_refused",
        "http_error",
    }
)


def _work_url(doi: str) -> str:
    # Crossref's single-work route does not support ``select``; keep the
    # complete metadata response and select fields only on the list query.
    return f"{_CROSSREF_WORKS_URL}/{quote(doi, safe='/')}"


def _updates_query_url(doi: str) -> str:
    return str(
        httpx.URL(
            _CROSSREF_WORKS_URL,
            params={
                "filter": f"updates:{doi}",
                "rows": "20",
                "select": _SELECT_FIELDS,
            },
        )
    )


def _fetch_json(client: httpx.Client, url: str) -> _FetchOutcome:
    """Fetch one Crossref JSON envelope while preserving failure categories."""

    try:
        response = client.get(url)
    except httpx.TimeoutException:
        return _FetchOutcome(
            kind="timeout",
            payload=None,
            url=url,
            issue="Crossref request timed out.",
        )
    except httpx.RequestError as exc:
        return _FetchOutcome(
            kind="connection_error",
            payload=None,
            url=url,
            issue=f"Crossref connection failed: {exc.__class__.__name__}.",
        )

    status_code = response.status_code
    if 300 <= status_code < 400:
        return _FetchOutcome(
            kind="redirect_refused",
            payload=None,
            url=url,
            status_code=status_code,
            issue="Crossref returned a redirect; redirects are not followed.",
        )
    if status_code == 404:
        return _FetchOutcome(
            kind="not_found",
            payload=None,
            url=url,
            status_code=status_code,
            issue="Crossref returned HTTP 404 for this DOI/query.",
        )
    if status_code == 429:
        return _FetchOutcome(
            kind="rate_limited",
            payload=None,
            url=url,
            status_code=status_code,
            issue="Crossref returned HTTP 429 (rate limited).",
        )
    if not 200 <= status_code < 300:
        return _FetchOutcome(
            kind="http_error",
            payload=None,
            url=url,
            status_code=status_code,
            issue=f"Crossref returned HTTP {status_code}.",
        )

    try:
        decoded: Any = response.json()
    except json.JSONDecodeError as exc:
        return _FetchOutcome(
            kind="malformed_json",
            payload=None,
            url=url,
            status_code=status_code,
            issue=f"Crossref returned malformed JSON: {exc.msg}.",
        )
    except (UnicodeDecodeError, ValueError) as exc:
        return _FetchOutcome(
            kind="malformed_json",
            payload=None,
            url=url,
            status_code=status_code,
            issue=f"Crossref returned malformed JSON: {exc}.",
        )

    if not isinstance(decoded, Mapping):
        return _FetchOutcome(
            kind="malformed_response",
            payload=None,
            url=url,
            status_code=status_code,
            issue="Crossref JSON envelope is not an object.",
        )
    message = decoded.get("message")
    if not isinstance(message, Mapping):
        return _FetchOutcome(
            kind="malformed_response",
            payload=None,
            url=url,
            status_code=status_code,
            issue="Crossref JSON envelope has no object-valued message.",
        )
    return _FetchOutcome(
        kind="ok",
        payload=cast(Mapping[str, Any], message),
        url=url,
        status_code=status_code,
    )


def _error_result(
    *,
    request: CitationRequest,
    outcome: _FetchOutcome,
    checked_at: datetime,
    sources: list[CitationSource],
) -> CitationAuditResult:
    status = cast(CitationStatus, outcome.kind)
    return CitationAuditResult(
        request=request,
        doi=request.doi,
        status=status,
        doi_exists=False if status == "not_found" else None,
        source_doi=request.doi,
        source_url=outcome.url,
        sources=sources,
        checked_at=checked_at,
        issues=[outcome.issue or f"Crossref request failed: {status}."],
    )


def _parse_direct_updates(
    raw_updates: Any,
    target_doi: str,
    source_url: str,
) -> tuple[list[CitationUpdate], list[str]]:
    if raw_updates is None:
        return [], []
    if not isinstance(raw_updates, list):
        return [], ["Crossref update-to metadata is not a list."]

    updates: list[CitationUpdate] = []
    issues: list[str] = []
    for raw_update in raw_updates:
        if not isinstance(raw_update, Mapping):
            issues.append("Crossref update-to metadata contains a non-object entry.")
            continue
        update = _update_from_entry(
            raw_update,
            doi=_safe_normalize(raw_update.get("DOI")),
            target_doi=target_doi,
            source_url=source_url,
            relation="update-to",
        )
        updates.append(update)
    return updates, issues


def _parse_inverse_updates(
    payload: Mapping[str, Any],
    target_doi: str,
    source_url: str,
) -> tuple[list[CitationUpdate], list[str]]:
    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        return [], ["Crossref updates query response has no list-valued items field."]

    updates: list[CitationUpdate] = []
    issues: list[str] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, Mapping):
            issues.append("Crossref updates query contains a non-object item.")
            continue
        item_doi = _safe_normalize(raw_item.get("DOI"))
        raw_relations = raw_item.get("update-to")
        typed_relation_found = False
        if isinstance(raw_relations, list):
            for raw_relation in raw_relations:
                if not isinstance(raw_relation, Mapping):
                    issues.append("Crossref update-to metadata contains a non-object entry.")
                    continue
                relation_target = _safe_normalize(raw_relation.get("DOI"))
                if relation_target is not None and relation_target != target_doi:
                    continue
                typed_relation_found = True
                updates.append(
                    _update_from_entry(
                        raw_relation,
                        doi=item_doi,
                        target_doi=relation_target or target_doi,
                        source_url=source_url,
                        relation="updates-query",
                    )
                )
        elif raw_relations is not None:
            issues.append("Crossref inverse item has malformed update-to metadata.")

        if not typed_relation_found:
            # The official ``updates:<doi>`` filter itself says this item is an
            # update of the target.  Keep that clue even if the item omitted
            # its typed update-to assertion.
            raw_update_type = raw_item.get("update-type")
            update_type = (
                _normalize_update_type(raw_update_type)
                if isinstance(raw_update_type, str) and raw_update_type.strip()
                else "update"
            )
            updates.append(
                CitationUpdate(
                    doi=item_doi,
                    target_doi=target_doi,
                    type=update_type,
                    label=None,
                    source=None,
                    updated_at=None,
                    record_id=None,
                    source_url=source_url,
                    relation="updates-query",
                )
            )
    return updates, issues


def _update_from_entry(
    entry: Mapping[str, Any],
    *,
    doi: str | None,
    target_doi: str,
    source_url: str,
    relation: Literal["update-to", "updates-query"],
) -> CitationUpdate:
    raw_type = entry.get("type")
    update_type = _normalize_update_type(raw_type) if isinstance(raw_type, str) else "update"
    label = entry.get("label")
    source = entry.get("source")
    return CitationUpdate(
        doi=doi,
        target_doi=target_doi,
        type=update_type,
        label=label.strip() if isinstance(label, str) and label.strip() else None,
        source=source.strip() if isinstance(source, str) and source.strip() else None,
        updated_at=_updated_at(entry.get("updated")),
        record_id=entry.get("record-id") if isinstance(entry.get("record-id"), int) else None,
        source_url=source_url,
        relation=relation,
    )


def _merge_updates(
    first: list[CitationUpdate],
    second: list[CitationUpdate],
) -> list[CitationUpdate]:
    merged: list[CitationUpdate] = []
    seen: set[tuple[str | None, str | None, str]] = set()
    for update in [*first, *second]:
        key = (update.doi, update.target_doi, update.type.casefold())
        if key not in seen:
            seen.add(key)
            merged.append(update)
    return merged


def _normalize_update_type(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).strip().casefold()
    normalized = re.sub(r"[\s_]+", "-", normalized)
    return normalized or "update"


def _status_for(
    updates: list[CitationUpdate],
    *,
    title_match: bool | None,
    year_match: bool | None,
    secondary_failed: bool,
    relation_malformed: bool,
) -> CitationStatus:
    if any(_is_retraction(update.type) for update in updates):
        return "retraction_signal"
    if any(_is_correction(update.type) for update in updates):
        return "correction_signal"
    if updates:
        return "update_signal"
    if secondary_failed or relation_malformed:
        return "unknown"
    if title_match is False and year_match is False:
        return "metadata_mismatch"
    if title_match is False:
        return "title_mismatch"
    if year_match is False:
        return "year_mismatch"
    return "no_notice_found"


def _is_retraction(update_type: str) -> bool:
    normalized = _normalize_update_type(update_type)
    return "retract" in normalized or normalized in {"withdrawal", "removal"}


def _is_correction(update_type: str) -> bool:
    normalized = _normalize_update_type(update_type)
    return any(token in normalized for token in ("correct", "corrigendum", "erratum"))


def _match_title(
    expected: str | None,
    actual: str | None,
    issues: list[str],
) -> bool | None:
    if expected is None:
        return None
    if actual is None:
        issues.append("Crossref metadata has no title to compare.")
        return None
    matches = _title_key(expected) == _title_key(actual)
    if not matches:
        issues.append("Known title does not match Crossref metadata.")
    return matches


def _match_year(
    expected: int | None,
    actual: int | None,
    issues: list[str],
) -> bool | None:
    if expected is None:
        return None
    if actual is None:
        issues.append("Crossref metadata has no publication year to compare.")
        return None
    matches = expected == actual
    if not matches:
        issues.append("Known publication year does not match Crossref metadata.")
    return matches


def _title_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return " ".join("".join(char if char.isalnum() else " " for char in normalized).split())


def _first_title(raw_title: Any) -> str | None:
    if isinstance(raw_title, str):
        return raw_title.strip() or None
    if isinstance(raw_title, list):
        for item in raw_title:
            if isinstance(item, str) and item.strip():
                return item.strip()
    return None


def _publication_year(message: Mapping[str, Any]) -> int | None:
    for key in ("published", "published-print", "published-online", "issued", "created"):
        year = _year_from_date(message.get(key))
        if year is not None:
            return year
    return None


def _year_from_date(raw_date: Any) -> int | None:
    if not isinstance(raw_date, Mapping):
        return None
    date_parts = raw_date.get("date-parts")
    if not isinstance(date_parts, list) or not date_parts:
        return None
    first = date_parts[0]
    if not isinstance(first, list) or not first:
        return None
    year = first[0]
    if isinstance(year, bool) or not isinstance(year, int):
        return None
    return cast(int, year)


def _updated_at(raw_updated: Any) -> datetime | None:
    if not isinstance(raw_updated, Mapping):
        return None
    raw_datetime = raw_updated.get("date-time")
    if isinstance(raw_datetime, str):
        try:
            return datetime.fromisoformat(raw_datetime.replace("Z", "+00:00"))
        except ValueError:
            pass
    raw_parts = raw_updated.get("date-parts")
    if not isinstance(raw_parts, list) or not raw_parts:
        return None
    first = raw_parts[0]
    if not isinstance(first, list) or not first or not isinstance(first[0], int):
        return None
    try:
        month = first[1] if len(first) > 1 else 1
        day = first[2] if len(first) > 2 else 1
        return datetime(first[0], month, day, tzinfo=UTC)
    except (TypeError, ValueError):
        return None


def _optional_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if candidate.startswith(("http://", "https://")):
        return candidate
    return None


def _safe_normalize(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return normalize_doi(value)
    except (TypeError, ValueError):
        return None


def _dedupe(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


__all__ = [
    "MAX_CITATIONS",
    "MAX_DOI_LENGTH",
    "CitationAuditReport",
    "CitationAuditResult",
    "CitationAuditor",
    "CitationRequest",
    "CitationSource",
    "CitationStatus",
    "CitationUpdate",
    "NetworkAccessDisabledError",
    "normalize_doi",
]
