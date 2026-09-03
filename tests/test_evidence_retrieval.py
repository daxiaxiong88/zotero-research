from __future__ import annotations

from pathlib import Path

import httpx
import pymupdf

from zotero_research_mcp.service import ResearchService
from zotero_research_mcp.zotero import ZoteroLocalClient


def _save_evidence_pdf(path: Path) -> None:
    page_texts = [
        (
            "Introduction and objective. Protein homeostasis is important for cellular health. "
            "The research question asks whether treatment improves protein folding stability. "
            "Background observations motivate a controlled experiment. " * 5
        ),
        (
            "Methods. We conducted a double-blind randomized controlled trial with 240 "
            "participants. Participants were randomly assigned to treatment or placebo and "
            "followed for twelve weeks. "
            "The primary endpoint was measured by an assessor blinded to allocation. " * 5
        ),
        (
            "Results and limitations. Treatment improved the primary endpoint by twelve percent. "
            "The confidence interval was narrow, but the single-center design limits "
            "generalizability. "
            "Long-term adverse events remain uncertain and require additional follow-up. " * 5
        ),
    ]
    document = pymupdf.open()
    for text in page_texts:
        page = document.new_page()
        page.insert_textbox(pymupdf.Rect(72, 72, 520, 740), text, fontsize=10)
    document.save(path)
    document.close()


def test_retrieve_evidence_ranks_relevant_page_and_returns_stable_citations(
    tmp_path: Path,
) -> None:
    pdf_path = tmp_path / "evidence.pdf"
    _save_evidence_pdf(pdf_path)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/users/0/items/PDFKEY23/file/view/url"
        return httpx.Response(200, text=pdf_path.resolve().as_uri())

    service = ResearchService(
        zotero=ZoteroLocalClient(transport=httpx.MockTransport(handler))
    )

    result = service.retrieve_evidence(
        "PDFKEY23",
        "double blind randomized controlled trial",
        top_k=2,
    )

    assert result.query == "double blind randomized controlled trial"
    assert result.attachment_key == "PDFKEY23"
    assert len(result.evidence) == 2
    assert result.evidence[0].page == 2
    assert result.evidence[0].evidence_id == "PDFKEY23:p2:c1"
    assert result.evidence[0].source == "zotero://open-pdf/library/items/PDFKEY23?page=2"
    assert "randomized controlled trial" in result.evidence[0].text.lower()
    assert result.evidence[0].score > result.evidence[1].score
