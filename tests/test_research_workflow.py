from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pymupdf
import pytest
from mcp.server.fastmcp.exceptions import ToolError

from zotero_research_mcp.bridge import BridgeApplication
from zotero_research_mcp.disclosure import ContentConsentStore, MCPContentPolicy
from zotero_research_mcp.models import PdfPage
from zotero_research_mcp.pdf import PdfExtractor
from zotero_research_mcp.server import create_mcp_server
from zotero_research_mcp.service import ResearchService
from zotero_research_mcp.zotero import ZoteroLocalClient


def _synthetic_zotero(path: Path) -> ZoteroLocalClient:
    def respond(request: httpx.Request) -> httpx.Response:
        headers = {
            "X-Zotero-Version": "10.0.1",
            "Zotero-API-Version": "3",
            "Zotero-Server-ID": "synthetic-instance",
        }
        if request.url.path == "/api/":
            return httpx.Response(200, headers=headers)
        if request.url.path.endswith("/file/view/url"):
            return httpx.Response(200, text=path.as_uri(), headers=headers)
        if request.url.path.endswith("/children"):
            return httpx.Response(
                200,
                headers=headers,
                json=[
                    {
                        "key": "PDFKEY23",
                        "version": 1,
                        "data": {
                            "itemType": "attachment",
                            "contentType": "application/pdf",
                            "parentItem": "PARENT23",
                        },
                    }
                ],
            )
        if request.url.path.endswith("/PARENT23"):
            return httpx.Response(
                200,
                headers=headers,
                json={
                    "key": "PARENT23",
                    "version": 1,
                    "data": {"itemType": "journalArticle", "title": "Synthetic research"},
                },
            )
        raise AssertionError("Unexpected synthetic Zotero request")

    return ZoteroLocalClient(transport=httpx.MockTransport(respond))


def test_native_rpc_routes_forced_local_parsing_and_exact_quote_location(tmp_path: Path) -> None:
    pdf_path = tmp_path / "synthetic.pdf"
    with pymupdf.open() as document:
        document.new_page().insert_text((72, 100), "Measured improvement.")
        document.save(pdf_path)

    class LocalParser:
        name = "synthetic-heavy"
        is_local = True
        calls = 0

        def extract_pages(self, path: Path) -> list[PdfPage]:
            assert path == pdf_path
            self.calls += 1
            return [
                PdfPage(
                    number=1, text="Results: Measured improvement. Method: synthetic experiment."
                )
            ]

    parser = LocalParser()
    service = ResearchService(
        zotero=_synthetic_zotero(pdf_path), pdf_extractor=PdfExtractor(heavy_parser=parser)
    )
    app = BridgeApplication(service, ContentConsentStore(tmp_path / "grants"))
    result = app.dispatch(
        {
            "method": "analyze",
            "expected_server_id": "synthetic-instance",
            "params": {"item_key": "PARENT23", "allow_heavy_fallback": True, "force_heavy": True},
        }
    )
    assert result.processing_location == "none"
    assert parser.calls == 1
    assert result.evidence[0].source.startswith("zotero://open-pdf/library/items/")
    location = app.dispatch(
        {
            "method": "locate",
            "expected_server_id": "synthetic-instance",
            "params": {"attachment_key": "PDFKEY23", "page": 1, "quote": "Measured improvement."},
        }
    )
    assert location.status == "exact"
    assert len(location.rects) == 1
    assert parser.calls == 1  # Native geometry must not come from OCR output.
    service.close()


def test_citation_rpc_requires_independent_explicit_network_consent(tmp_path: Path) -> None:
    service = ResearchService(zotero=_synthetic_zotero(tmp_path / "unused.pdf"))
    app = BridgeApplication(service, ContentConsentStore(tmp_path / "grants"))
    with pytest.raises(PermissionError):
        app.dispatch(
            {
                "method": "audit_citations",
                "expected_server_id": "synthetic-instance",
                "params": {"requests": [{"doi": "10.5555/synthetic"}]},
            }
        )
    service.close()


def test_parent_consent_does_not_cover_a_later_added_pdf(tmp_path: Path) -> None:
    store = ContentConsentStore(tmp_path / "grants")
    store.grant_public(
        server_id="synthetic-instance",
        parent_item_key="PARENT23",
        attachment_keys=["ATTACH23"],
        confirmed_public=True,
    )
    service = ResearchService(zotero=_synthetic_zotero(tmp_path / "must-not-open.pdf"))
    server = create_mcp_server(service=service, content_policy=MCPContentPolicy(consents=store))
    with pytest.raises(ToolError, match=r"本地.*授权"):
        asyncio.run(
            server.call_tool(
                "generate_reading_card",
                {
                    "item_key": "PARENT23",
                    "sensitivity": "public",
                    "allow_cloud": True,
                },
            )
        )
    service.close()
