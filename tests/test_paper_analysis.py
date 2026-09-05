from __future__ import annotations

from typing import Any

import pytest

from zotero_research_mcp.analysis import PaperAnalysisBuilder
from zotero_research_mcp.model import ModelResponseError
from zotero_research_mcp.models import ItemSummary, PdfExtraction, PdfPage
from zotero_research_mcp.pdf import assess_pdf_quality
from zotero_research_mcp.retrieval import EvidenceRetriever


class TestModelEndpoint:
    __test__ = False
    name = "test-local-endpoint"
    is_local = True

    def __init__(self, *, reference: str = "ATTACH23:p1:c1") -> None:
        self.reference = reference
        self.prompts: list[str] = []

    def complete_json(self, prompt: str) -> dict[str, Any]:
        self.prompts.append(prompt)
        return {
            "sections": [
                {"title": "证据", "content": "Synthetic finding.", "evidence_ids": [self.reference]}
            ]
        }


def paper_fixture() -> tuple[ItemSummary, PdfExtraction]:
    pages = [PdfPage(number=1, text="Results: the synthetic experiment used 40 samples. " * 12)]
    return (
        ItemSummary(key="PARENT23", item_type="journalArticle", title="Synthetic study"),
        PdfExtraction(
            attachment_key="ATTACH23",
            file_name="synthetic.pdf",
            parser="pymupdf",
            route="fast",
            page_count=1,
            pages=pages,
            quality=assess_pdf_quality(pages),
            fallback_used=False,
        ),
    )


def test_paper_question_is_grounded_in_a_closed_evidence_set() -> None:
    item, extraction = paper_fixture()
    endpoint = TestModelEndpoint()
    builder = PaperAnalysisBuilder(retriever=EvidenceRetriever(), model=endpoint)
    result = builder.build(item=item, extraction=extraction, task="question", question="samples?")
    assert result.mode == "model"
    assert result.sections[0].evidence_ids == ["ATTACH23:p1:c1"]
    assert result.evidence[0].page == 1
    assert "40 samples" in endpoint.prompts[0]


def test_unknown_model_evidence_is_rejected() -> None:
    item, extraction = paper_fixture()
    builder = PaperAnalysisBuilder(
        retriever=EvidenceRetriever(), model=TestModelEndpoint(reference="INVENTED:p9:c1")
    )
    with pytest.raises(ModelResponseError, match="unknown evidence"):
        builder.build(item=item, extraction=extraction, task="review")


def test_configured_external_model_can_process_public_paper() -> None:
    item, extraction = paper_fixture()
    endpoint = TestModelEndpoint()
    endpoint.is_local = False
    builder = PaperAnalysisBuilder(retriever=EvidenceRetriever(), model=endpoint)
    result = builder.build(item=item, extraction=extraction, task="review")
    assert result.processing_location == "external"
    assert endpoint.prompts


def _multi_page_extraction() -> PdfExtraction:
    """Five pages whose keywords each match one overview query with 3+ chunks."""

    page_texts = [
        "research question hypothesis aim objective. " * 100,
        "methods experiment randomized participants sample measurement. " * 100,
        "results key findings effect outcome endpoint increased decreased. " * 100,
        "limitations uncertainty bias generalizability short follow-up. " * 100,
        "introduction related work motivation study 背景. " * 100,
    ]
    pages = [PdfPage(number=index + 1, text=text) for index, text in enumerate(page_texts)]
    return PdfExtraction(
        attachment_key="ATTACH23",
        file_name="synthetic.pdf",
        parser="pymupdf",
        route="fast",
        page_count=len(pages),
        pages=pages,
        quality=assess_pdf_quality(pages),
        fallback_used=False,
    )


def test_translate_warning_describes_selection_scope_only() -> None:
    item, extraction = paper_fixture()
    builder = PaperAnalysisBuilder(
        retriever=EvidenceRetriever(), model=TestModelEndpoint(reference="ATTACH23:p1:selection")
    )
    result = builder.build(
        item=item,
        extraction=extraction,
        task="translate",
        selected_text="the synthetic experiment used 40 samples.",
        selection_page=1,
    )
    assert result.mode == "model"
    assert any("所选原文片段" in warning for warning in result.warnings)
    assert not any("逐页完整审阅" in warning for warning in result.warnings)


def test_evidence_truncation_is_warned_not_silent() -> None:
    item = ItemSummary(key="PARENT23", item_type="journalArticle", title="Synthetic study")
    extraction = _multi_page_extraction()
    builder = PaperAnalysisBuilder(retriever=EvidenceRetriever(), model=None)
    result = builder.build(
        item=item, extraction=extraction, task="question", question="introduction motivation?"
    )
    assert len(result.evidence) == 12
    assert any("已截断" in warning for warning in result.warnings)
