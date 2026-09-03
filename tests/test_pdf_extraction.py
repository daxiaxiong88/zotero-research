from __future__ import annotations

from pathlib import Path

import httpx
import pymupdf as fitz
import pytest

from zotero_research_mcp.models import PdfPage
from zotero_research_mcp.pdf import PdfExtractionError, PdfExtractor
from zotero_research_mcp.service import ResearchService
from zotero_research_mcp.zotero import ZoteroLocalClient


def _save_text_pdf(path: Path) -> None:
    document = fitz.open()
    for page_number in range(1, 3):
        page = document.new_page()
        text = (
            f"Page {page_number}. Protein folding evidence and reproducible methods. "
            "This paragraph contains enough selectable text for the fast parser. " * 8
        )
        page.insert_textbox(fitz.Rect(72, 72, 520, 740), text, fontsize=11)
    document.save(path)
    document.close()


def _save_blank_pdf(path: Path) -> None:
    document = fitz.open()
    document.new_page()
    document.new_page()
    document.save(path)
    document.close()


def _zotero_transport_for_attachment(path: Path) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/api/users/0/items/PDFKEY23/file/view/url"
        return httpx.Response(200, text=path.resolve().as_uri())

    return httpx.MockTransport(handler)


def test_extract_pdf_uses_fast_parser_and_preserves_page_evidence(tmp_path: Path) -> None:
    pdf_path = tmp_path / "selectable.pdf"
    _save_text_pdf(pdf_path)
    client = ZoteroLocalClient(transport=_zotero_transport_for_attachment(pdf_path))

    result = ResearchService(zotero=client).extract_pdf("PDFKEY23")

    assert result.attachment_key == "PDFKEY23"
    assert result.file_name == "selectable.pdf"
    assert result.parser == "pymupdf"
    assert result.route == "fast"
    assert result.page_count == 2
    assert [page.number for page in result.pages] == [1, 2]
    assert "Protein folding evidence" in result.pages[0].text
    assert result.quality.needs_heavy_parser is False
    assert result.fallback_used is False


def test_blank_pdf_recommends_heavy_parser_without_automatic_fallback(tmp_path: Path) -> None:
    pdf_path = tmp_path / "scan.pdf"
    _save_blank_pdf(pdf_path)
    client = ZoteroLocalClient(transport=_zotero_transport_for_attachment(pdf_path))

    result = ResearchService(zotero=client).extract_pdf("PDFKEY23")

    assert result.parser == "pymupdf"
    assert result.route == "heavy_recommended"
    assert result.quality.needs_heavy_parser is True
    assert "insufficient_selectable_text" in result.quality.reasons
    assert result.fallback_used is False


def test_explicit_fallback_uses_configured_local_heavy_parser(tmp_path: Path) -> None:
    class StubLocalHeavyParser:
        name = "mineru-local-stub"
        is_local = True

        def __init__(self) -> None:
            self.calls = 0

        def extract_pages(self, path: Path) -> list[PdfPage]:
            assert path.name == "scan.pdf"
            self.calls += 1
            return [
                PdfPage(
                    number=1,
                    text="Recovered OCR text with methods, results, equations, and evidence. " * 8,
                ),
                PdfPage(number=2, text="Recovered second page with a complex table. " * 8),
            ]

    pdf_path = tmp_path / "scan.pdf"
    _save_blank_pdf(pdf_path)
    heavy_parser = StubLocalHeavyParser()
    client = ZoteroLocalClient(transport=_zotero_transport_for_attachment(pdf_path))
    service = ResearchService(
        zotero=client,
        pdf_extractor=PdfExtractor(heavy_parser=heavy_parser),
    )

    result = service.extract_pdf("PDFKEY23", allow_heavy_fallback=True)

    assert heavy_parser.calls == 1
    assert result.parser == "mineru-local-stub"
    assert result.route == "heavy_fallback"
    assert result.fallback_used is True
    assert "Recovered OCR text" in result.pages[0].text


def test_force_heavy_requires_opt_in_and_runs_for_selectable_text(tmp_path: Path) -> None:
    class StubLocalHeavyParser:
        name = "mineru-local-stub"
        is_local = True

        def __init__(self) -> None:
            self.calls = 0

        def extract_pages(self, path: Path) -> list[PdfPage]:
            self.calls += 1
            return [PdfPage(number=1, text="Formula-aware heavy extraction.")]

    pdf_path = tmp_path / "selectable.pdf"
    _save_text_pdf(pdf_path)
    parser = StubLocalHeavyParser()
    extractor = PdfExtractor(heavy_parser=parser)

    with pytest.raises(ValueError, match="allow_heavy_fallback"):
        extractor.extract(pdf_path, attachment_key="PDFKEY23", force_heavy=True)

    result = extractor.extract(
        pdf_path,
        attachment_key="PDFKEY23",
        allow_heavy_fallback=True,
        force_heavy=True,
    )

    assert parser.calls == 1
    assert result.route == "heavy_fallback"
    assert result.fallback_used is True
    assert result.pages[0].text == "Formula-aware heavy extraction."


def test_force_heavy_without_a_parser_fails_explicitly(tmp_path: Path) -> None:
    pdf_path = tmp_path / "selectable.pdf"
    _save_text_pdf(pdf_path)

    with pytest.raises(PdfExtractionError, match="configured local heavy PDF parser"):
        PdfExtractor().extract(
            pdf_path,
            attachment_key="PDFKEY23",
            allow_heavy_fallback=True,
            force_heavy=True,
        )


def test_extractor_rejects_non_pdf_format_recognized_by_pymupdf(tmp_path: Path) -> None:
    svg_path = tmp_path / "looks-like-attachment.svg"
    svg_path.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
        "<text x=\"10\" y=\"20\">not a PDF</text></svg>",
        encoding="utf-8",
    )

    with pytest.raises(PdfExtractionError, match="not a PDF"):
        PdfExtractor().extract(svg_path, attachment_key="PDFKEY24")
