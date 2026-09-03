from __future__ import annotations

from contextvars import Context

import httpx
import pytest

from zotero_research_mcp.notes import PreviewMismatch
from zotero_research_mcp.service import ResearchService
from zotero_research_mcp.zotero import ZoteroLocalClient


def test_preview_cannot_be_written_to_another_library_even_after_reauthorization() -> None:
    instance = "instance-a"
    writes: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/":
            return httpx.Response(
                200,
                headers={
                    "X-Zotero-Version": "10.0.1",
                    "Zotero-API-Version": "3",
                    "Zotero-Server-ID": instance,
                },
            )
        if request.url.path == "/api/local/authorize":
            return httpx.Response(
                200,
                headers={"Zotero-Server-ID": instance},
                json={"key": "k" * 32, "remember": True},
            )
        if request.url.path == "/api/users/0/items/PARENT23":
            return httpx.Response(
                200,
                headers={"Zotero-Server-ID": instance},
                json={
                    "key": "PARENT23",
                    "data": {"itemType": "journalArticle", "title": "Synthetic paper"},
                },
            )
        if request.url.path.endswith("/children"):
            return httpx.Response(200, headers={"Zotero-Server-ID": instance}, json=[])
        if request.method == "POST" and request.url.path == "/api/users/0/items":
            writes.append(request.content)
            return httpx.Response(
                200,
                headers={"Zotero-Server-ID": instance},
                json={"successful": {"0": {"key": "NOTEAB23", "version": 1}}, "failed": {}},
            )
        raise AssertionError("Unexpected HTTP operation")

    service = ResearchService(zotero=ZoteroLocalClient(transport=httpx.MockTransport(handler)))
    preview = service.preview_child_note("PARENT23", title="Test", content="Synthetic note")
    instance = "instance-b"
    Context().run(service.request_write_authorization)
    with pytest.raises(PreviewMismatch, match="instance"):
        Context().run(
            lambda: service.write_child_note(
                preview.preview_token, expected_digest=preview.digest, confirmed_by_user=True
            )
        )
    assert writes == []
