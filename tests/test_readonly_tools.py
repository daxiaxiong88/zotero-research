from __future__ import annotations

import httpx
import pytest

from zotero_research_mcp.service import ResearchService
from zotero_research_mcp.zotero import ZoteroLocalClient


def test_local_api_client_rejects_non_loopback_or_invalid_port() -> None:
    with pytest.raises(ValueError, match="loopback"):
        ZoteroLocalClient(base_url="https://example.test/api/")
    with pytest.raises(ValueError, match="explicit valid local port"):
        ZoteroLocalClient(base_url="http://127.0.0.1:0/api/")


def test_health_check_reports_zotero_9_as_read_only() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/api/"
        return httpx.Response(
            200,
            headers={
                "X-Zotero-Version": "9.0.6",
                "Zotero-API-Version": "3",
                "Zotero-Schema-Version": "42",
            },
            text="Nothing to see here.",
        )

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    report = ResearchService(zotero=client).health_check()

    assert report.status == "ok"
    assert report.zotero.reachable is True
    assert report.zotero.version == "9.0.6"
    assert report.zotero.api_version == 3
    assert report.zotero.read_supported is True
    assert report.zotero.write_supported is False
    assert report.write_mode == "preview_only"
    assert report.sqlite_access == "forbidden"


def test_health_check_requires_local_api_v3_before_enabling_writes() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/"
        return httpx.Response(
            200,
            headers={
                "X-Zotero-Version": "10.0.1",
                "Zotero-API-Version": "2",
                "Zotero-Server-ID": "server-abc",
            },
        )

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    report = ResearchService(zotero=client).health_check()

    assert report.zotero.read_supported is False
    assert report.zotero.write_supported is False
    assert report.write_mode == "preview_only"


def test_search_items_returns_normalized_top_level_results() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/api/users/0/items/top"
        assert request.url.params["q"] == "protein folding"
        assert request.url.params["limit"] == "5"
        return httpx.Response(
            200,
            headers={"Total-Results": "1"},
            json=[
                {
                    "key": "ABCD2345",
                    "version": 17,
                    "data": {
                        "key": "ABCD2345",
                        "version": 17,
                        "itemType": "journalArticle",
                        "title": "A useful paper",
                        "date": "2025",
                        "DOI": "10.1000/example",
                        "url": "https://example.test/paper",
                        "creators": [
                            {
                                "creatorType": "author",
                                "firstName": "Ada",
                                "lastName": "Lovelace",
                            },
                            {"creatorType": "author", "name": "Research Consortium"},
                        ],
                    },
                }
            ],
        )

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    result = ResearchService(zotero=client).search_items("protein folding", limit=5)

    assert result.total == 1
    assert len(result.items) == 1
    item = result.items[0]
    assert item.key == "ABCD2345"
    assert item.item_type == "journalArticle"
    assert item.title == "A useful paper"
    assert item.creators == ["Ada Lovelace", "Research Consortium"]
    assert item.doi == "10.1000/example"


def test_get_item_context_separates_attachments_and_notes() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/users/0/items/PARENT23":
            return httpx.Response(
                200,
                json={
                    "key": "PARENT23",
                    "version": 3,
                    "data": {
                        "key": "PARENT23",
                        "version": 3,
                        "itemType": "journalArticle",
                        "title": "Parent paper",
                        "creators": [],
                    },
                },
            )
        if request.url.path == "/api/users/0/items/PARENT23/children":
            return httpx.Response(
                200,
                json=[
                    {
                        "key": "PDFKEY01",
                        "version": 4,
                        "data": {
                            "key": "PDFKEY01",
                            "version": 4,
                            "itemType": "attachment",
                            "title": "Full Text PDF",
                            "contentType": "application/pdf",
                            "filename": "paper.pdf",
                            "linkMode": "imported_file",
                            "parentItem": "PARENT23",
                        },
                    },
                    {
                        "key": "NTEKEY23",
                        "version": 5,
                        "data": {
                            "key": "NTEKEY23",
                            "version": 5,
                            "itemType": "note",
                            "note": "<p>Existing note</p>",
                            "parentItem": "PARENT23",
                        },
                    },
                ],
            )
        raise AssertionError(f"Unexpected request: {request.url}")

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    context = ResearchService(zotero=client).get_item_context("PARENT23")

    assert context.item.title == "Parent paper"
    assert [attachment.key for attachment in context.attachments] == ["PDFKEY01"]
    assert context.attachments[0].content_type == "application/pdf"
    assert [note.key for note in context.notes] == ["NTEKEY23"]
    assert context.notes[0].html == "<p>Existing note</p>"
