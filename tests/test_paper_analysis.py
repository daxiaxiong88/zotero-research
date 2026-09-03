from __future__ import annotations

from typing import Any

import pytest

from zotero_research_mcp.analysis import PaperAnalysisBuilder
from zotero_research_mcp.model import ModelResponseError
from zotero_research_mcp.models import ItemSummary, PdfExtraction, PdfPage
from zotero_research_mcp.pdf import assess_pdf_quality
from zotero_research_mcp.privacy import PrivacyPolicy, PrivacyViolation
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
    builder = PaperAnalysisBuilder(
        retriever=EvidenceRetriever(), privacy_policy=PrivacyPolicy(), model=endpoint
    )
    result = builder.build(item=item, extraction=extraction, task="question", question="samples?")
    assert result.mode == "model"
    assert result.sections[0].evidence_ids == ["ATTACH23:p1:c1"]
    assert result.evidence[0].page == 1
    assert "40 samples" in endpoint.prompts[0]


def test_unknown_model_evidence_is_rejected() -> None:
    item, extraction = paper_fixture()
    builder = PaperAnalysisBuilder(
        retriever=EvidenceRetriever(),
        privacy_policy=PrivacyPolicy(),
        model=TestModelEndpoint(reference="INVENTED:p9:c1"),
    )
    with pytest.raises(ModelResponseError, match="unknown evidence"):
        builder.build(item=item, extraction=extraction, task="review")


def test_sensitive_analysis_never_calls_external_model() -> None:
    item, extraction = paper_fixture()
    endpoint = TestModelEndpoint()
    endpoint.is_local = False
    builder = PaperAnalysisBuilder(
        retriever=EvidenceRetriever(), privacy_policy=PrivacyPolicy(), model=endpoint
    )
    with pytest.raises(PrivacyViolation):
        builder.build(item=item, extraction=extraction, task="review", allow_cloud=True)
    assert endpoint.prompts == []
