from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import httpx
import pymupdf
import pytest

from zotero_research_mcp.model import ModelClient
from zotero_research_mcp.privacy import PrivacyViolation
from zotero_research_mcp.service import ResearchService
from zotero_research_mcp.zotero import ZoteroLocalClient


def _save_paper(path: Path) -> None:
    page_texts = [
        (
            "Research question and hypothesis. The objective is to determine whether treatment "
            "improves protein folding stability compared with placebo. The hypothesis predicts "
            "greater stability after treatment. " * 5
        ),
        (
            "Methods and study design. A double-blind randomized controlled trial enrolled 240 "
            "participants. Random allocation assigned treatment or placebo for twelve weeks. "
            "Blinded assessors measured the primary endpoint. " * 5
        ),
        (
            "Results and key findings. Treatment improved the primary endpoint by twelve percent. "
            "Limitations include a single-center sample and short follow-up. Generalizability and "
            "long-term safety remain uncertain. " * 5
        ),
    ]
    document = pymupdf.open()
    for text in page_texts:
        page = document.new_page()
        page.insert_textbox(pymupdf.Rect(72, 72, 520, 740), text, fontsize=10)
    document.save(path)
    document.close()


def _transport(path: Path) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/users/0/items/PARENT23":
            return httpx.Response(
                200,
                json={
                    "key": "PARENT23",
                    "version": 7,
                    "data": {
                        "key": "PARENT23",
                        "version": 7,
                        "itemType": "journalArticle",
                        "title": "A trial of protein stability",
                        "date": "2025",
                        "creators": [
                            {
                                "creatorType": "author",
                                "firstName": "Ada",
                                "lastName": "Lovelace",
                            }
                        ],
                    },
                },
            )
        if request.url.path == "/api/users/0/items/PARENT23/children":
            return httpx.Response(
                200,
                json=[
                    {
                        "key": "PDFKEY23",
                        "version": 4,
                        "data": {
                            "key": "PDFKEY23",
                            "version": 4,
                            "itemType": "attachment",
                            "title": "Full Text PDF",
                            "contentType": "application/pdf",
                            "filename": path.name,
                            "linkMode": "imported_file",
                            "parentItem": "PARENT23",
                        },
                    }
                ],
            )
        if request.url.path == "/api/users/0/items/PDFKEY23/file/view/url":
            return httpx.Response(200, text=path.resolve().as_uri())
        raise AssertionError(f"Unexpected request: {request.url}")

    return httpx.MockTransport(handler)


class RecordingModel(ModelClient):
    def __init__(self, *, is_local: bool) -> None:
        self.name = "recording-local" if is_local else "recording-cloud"
        self.is_local = is_local
        self.calls: list[str] = []

    def complete_json(self, prompt: str) -> Mapping[str, Any]:
        self.calls.append(prompt)
        return {
            "research_question": {
                "summary": "The study asks whether treatment improves protein stability.",
                "evidence_ids": ["PDFKEY23:p1:c1"],
            },
            "methods": {
                "summary": "A double-blind randomized trial enrolled 240 participants.",
                "evidence_ids": ["PDFKEY23:p2:c1"],
            },
            "key_findings": {
                "summary": "The primary endpoint improved by twelve percent.",
                "evidence_ids": ["PDFKEY23:p3:c1"],
            },
            "limitations": {
                "summary": "Single-center recruitment and short follow-up limit inference.",
                "evidence_ids": ["PDFKEY23:p3:c1"],
            },
        }


def test_reading_card_without_model_remains_evidence_grounded(tmp_path: Path) -> None:
    path = tmp_path / "paper.pdf"
    _save_paper(path)
    service = ResearchService(
        zotero=ZoteroLocalClient(transport=_transport(path)),
    )

    card = service.generate_reading_card("PARENT23")

    assert card.mode == "evidence_only"
    assert card.title == "A trial of protein stability"
    assert [section.key for section in card.sections] == [
        "research_question",
        "methods",
        "key_findings",
        "limitations",
    ]
    assert all(section.evidence_ids for section in card.sections)
    known_ids = {evidence.evidence_id for evidence in card.evidence}
    assert all(
        evidence_id in known_ids
        for section in card.sections
        for evidence_id in section.evidence_ids
    )


def test_sensitive_full_text_can_use_a_local_model(tmp_path: Path) -> None:
    path = tmp_path / "paper.pdf"
    _save_paper(path)
    model = RecordingModel(is_local=True)
    service = ResearchService(
        zotero=ZoteroLocalClient(transport=_transport(path)),
        model=model,
    )

    card = service.generate_reading_card("PARENT23", sensitivity="sensitive")

    assert card.mode == "model"
    assert card.generated_by == "recording-local"
    assert len(model.calls) == 1
    assert "A trial of protein stability" in model.calls[0]
    assert "PDFKEY23:p2:c1" in model.calls[0]
    assert card.sections[1].evidence_ids == ["PDFKEY23:p2:c1"]


def test_sensitive_full_text_is_never_sent_to_external_model(tmp_path: Path) -> None:
    path = tmp_path / "paper.pdf"
    _save_paper(path)
    model = RecordingModel(is_local=False)
    service = ResearchService(
        zotero=ZoteroLocalClient(transport=_transport(path)),
        model=model,
    )

    with pytest.raises(PrivacyViolation, match=r"(?i)sensitive full text"):
        service.generate_reading_card(
            "PARENT23",
            sensitivity="sensitive",
            allow_cloud=True,
        )

    assert model.calls == []


def test_public_full_text_requires_explicit_cloud_opt_in(tmp_path: Path) -> None:
    path = tmp_path / "paper.pdf"
    _save_paper(path)
    model = RecordingModel(is_local=False)
    service = ResearchService(
        zotero=ZoteroLocalClient(transport=_transport(path)),
        model=model,
    )

    with pytest.raises(PrivacyViolation, match="explicit allow_cloud"):
        service.generate_reading_card("PARENT23", sensitivity="public")
    assert model.calls == []

    card = service.generate_reading_card(
        "PARENT23",
        sensitivity="public",
        allow_cloud=True,
    )
    assert card.mode == "model"
    assert len(model.calls) == 1
