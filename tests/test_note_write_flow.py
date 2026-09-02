from __future__ import annotations

import json

import httpx
import pytest

from zotero_research_mcp.notes import PreviewAlreadyUsed, PreviewMismatch, WriteConfirmationRequired
from zotero_research_mcp.service import ResearchService
from zotero_research_mcp.zotero import LocalWriteUnavailable, ZoteroLocalClient


def _parent_responses(request: httpx.Request) -> httpx.Response | None:
    if request.method == "GET" and request.url.path == "/api/users/0/items/PARENT23":
        return httpx.Response(
            200,
            json={
                "key": "PARENT23",
                "version": 8,
                "data": {
                    "key": "PARENT23",
                    "version": 8,
                    "itemType": "journalArticle",
                    "title": "Parent paper",
                    "creators": [],
                },
            },
        )
    if (
        request.method == "GET"
        and request.url.path == "/api/users/0/items/PARENT23/children"
    ):
        return httpx.Response(200, json=[])
    return None


def test_preview_child_note_escapes_content_and_binds_exact_digest() -> None:
    seen_methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_methods.append(request.method)
        response = _parent_responses(request)
        if response is not None:
            return response
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    service = ResearchService(
        zotero=ZoteroLocalClient(transport=httpx.MockTransport(handler))
    )

    preview = service.preview_child_note(
        "PARENT23",
        title="AI reading card",
        content="Finding: 12% improvement.\n\n<script>alert('x')</script>",
        tags=["AI review"],
    )

    assert preview.parent_item_key == "PARENT23"
    assert preview.requires_user_confirmation is True
    assert len(preview.digest) == 64
    assert len(preview.preview_token) >= 32
    assert "<h1>AI reading card</h1>" in preview.note_html
    assert "<script>" not in preview.note_html
    assert "&lt;script&gt;" in preview.note_html
    assert preview.tags == ["AI review", "zotero-research-mcp"]
    assert seen_methods == ["GET", "GET"]


def test_write_rejects_missing_confirmation_and_digest_mismatch_before_http_write() -> None:
    post_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        response = _parent_responses(request)
        if response is not None:
            return response
        if request.method == "POST":
            post_paths.append(request.url.path)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    service = ResearchService(
        zotero=ZoteroLocalClient(transport=httpx.MockTransport(handler))
    )
    preview = service.preview_child_note(
        "PARENT23",
        title="AI reading card",
        content="Evidence-grounded note.",
    )

    with pytest.raises(WriteConfirmationRequired):
        service.write_child_note(
            preview.preview_token,
            expected_digest=preview.digest,
            confirmed_by_user=False,
        )
    with pytest.raises(PreviewMismatch):
        service.write_child_note(
            preview.preview_token,
            expected_digest="0" * 64,
            confirmed_by_user=True,
        )

    assert post_paths == []


def test_zotero_9_stays_preview_only_even_after_confirmation() -> None:
    post_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        response = _parent_responses(request)
        if response is not None:
            return response
        if request.method == "GET" and request.url.path == "/api/":
            return httpx.Response(
                200,
                headers={
                    "X-Zotero-Version": "9.0.6",
                    "Zotero-API-Version": "3",
                },
            )
        if request.method == "POST":
            post_paths.append(request.url.path)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    service = ResearchService(
        zotero=ZoteroLocalClient(transport=httpx.MockTransport(handler))
    )
    preview = service.preview_child_note(
        "PARENT23",
        title="AI reading card",
        content="Do not write this on Zotero 9.",
    )

    with pytest.raises(LocalWriteUnavailable, match="Zotero 10"):
        service.write_child_note(
            preview.preview_token,
            expected_digest=preview.digest,
            confirmed_by_user=True,
        )

    assert post_paths == []


def test_zotero_10_authorizes_and_creates_exact_preview_once() -> None:
    posted_note: dict[str, object] = {}
    authorize_calls = 0
    item_write_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal authorize_calls, item_write_calls, posted_note
        response = _parent_responses(request)
        if response is not None:
            return response
        if request.method == "GET" and request.url.path == "/api/":
            return httpx.Response(
                200,
                headers={
                    "X-Zotero-Version": "10.0.1",
                    "Zotero-API-Version": "3",
                    "Zotero-Server-ID": "server-abc",
                },
            )
        if request.method == "POST" and request.url.path == "/api/local/authorize":
            authorize_calls += 1
            assert request.headers["Zotero-Server-ID"] == "server-abc"
            assert json.loads(request.content) == {"appName": "Zotero Research MCP"}
            return httpx.Response(200, json={"key": "K" * 32, "remember": False})
        if request.method == "POST" and request.url.path == "/api/users/0/items":
            item_write_calls += 1
            assert request.headers["Zotero-Server-ID"] == "server-abc"
            assert request.headers["Zotero-API-Key"] == "K" * 32
            assert len(request.headers["Zotero-Write-Token"]) == 32
            payload = json.loads(request.content)
            assert isinstance(payload, list) and len(payload) == 1
            posted_note = payload[0]
            return httpx.Response(
                200,
                json={
                    "successful": {
                        "0": {
                            "key": "NEWNOTE2",
                            "version": 9,
                            "data": {"key": "NEWNOTE2", "version": 9},
                        }
                    },
                    "unchanged": {},
                    "failed": {},
                },
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    service = ResearchService(
        zotero=ZoteroLocalClient(transport=httpx.MockTransport(handler))
    )
    preview = service.preview_child_note(
        "PARENT23",
        title="AI reading card",
        content="Evidence-grounded note.",
        tags=["reviewed"],
    )

    authorization = service.request_write_authorization()
    assert authorization.authorized is True
    assert authorization.remembered is False
    assert "K" * 32 not in authorization.model_dump_json()

    result = service.write_child_note(
        preview.preview_token,
        expected_digest=preview.digest,
        confirmed_by_user=True,
    )

    assert result.status == "created"
    assert result.item_key == "NEWNOTE2"
    assert result.parent_item_key == "PARENT23"
    assert result.digest == preview.digest
    assert posted_note["itemType"] == "note"
    assert posted_note["parentItem"] == "PARENT23"
    assert posted_note["note"] == preview.note_html
    assert posted_note["tags"] == [
        {"tag": "reviewed"},
        {"tag": "zotero-research-mcp"},
    ]
    assert authorize_calls == 1
    assert item_write_calls == 1

    with pytest.raises(PreviewAlreadyUsed):
        service.write_child_note(
            preview.preview_token,
            expected_digest=preview.digest,
            confirmed_by_user=True,
        )
    assert item_write_calls == 1
