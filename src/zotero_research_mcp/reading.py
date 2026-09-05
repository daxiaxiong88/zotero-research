"""Build a compact, evidence-linked reading card for a public paper."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .model import ModelClient, ModelResponseError
from .models import (
    EvidenceSpan,
    ItemSummary,
    PdfExtraction,
    ReadingCard,
    ReadingCardSection,
    ReadingSectionKey,
)
from .retrieval import EvidenceRetriever

_SECTION_SPECS: tuple[tuple[ReadingSectionKey, str, str], ...] = (
    (
        'research_question',
        'Research question',
        'research question objective hypothesis aim compared',
    ),
    (
        'methods',
        'Methods',
        'methods study design experiment randomized participants sample measurement',
    ),
    (
        'key_findings',
        'Key findings',
        'results key findings effect outcome endpoint increased decreased',
    ),
    (
        'limitations',
        'Limitations',
        'limitations uncertainty bias generalizability short follow-up future work',
    ),
)


class _ModelSection(BaseModel):
    model_config = ConfigDict(extra='forbid')

    summary: str = Field(min_length=1)
    evidence_ids: list[str]


class _ModelCard(BaseModel):
    model_config = ConfigDict(extra='forbid')

    research_question: _ModelSection
    methods: _ModelSection
    key_findings: _ModelSection
    limitations: _ModelSection


class ReadingCardBuilder:
    """Build an extractive card or ask the configured model to synthesize one."""

    def __init__(
        self,
        *,
        retriever: EvidenceRetriever,
        model: ModelClient | None,
    ) -> None:
        self._retriever = retriever
        self._model = model

    def build(
        self,
        *,
        item: ItemSummary,
        extraction: PdfExtraction,
    ) -> ReadingCard:
        evidence_by_section: dict[ReadingSectionKey, list[EvidenceSpan]] = {}
        evidence_by_id: dict[str, EvidenceSpan] = {}
        warnings: list[str] = []
        for key, _title, query in _SECTION_SPECS:
            result = self._retriever.retrieve(extraction, query, top_k=2)
            evidence_by_section[key] = result.evidence
            for evidence in result.evidence:
                evidence_by_id.setdefault(evidence.evidence_id, evidence)
            for warning in result.warnings:
                if warning not in warnings:
                    warnings.append(warning)

        ordered_evidence = sorted(
            evidence_by_id.values(),
            key=lambda evidence: (evidence.page, evidence.chunk_index),
        )
        if self._model is None:
            sections = self._extractive_sections(evidence_by_section)
            return ReadingCard(
                item_key=item.key,
                attachment_key=extraction.attachment_key,
                title=item.title,
                mode='evidence_only',
                generated_by='deterministic-retrieval',
                sections=sections,
                evidence=ordered_evidence,
                warnings=[
                    *warnings,
                    '未配置模型；当前内容是原文证据摘录。',
                ],
            )

        prompt = self._build_prompt(item, ordered_evidence)
        raw_card = self._model.complete_json(prompt)
        model_card = self._validate_model_card(raw_card, set(evidence_by_id))
        sections = [
            ReadingCardSection(
                key=key,
                title=title,
                summary=getattr(model_card, key).summary,
                evidence_ids=getattr(model_card, key).evidence_ids,
            )
            for key, title, _query in _SECTION_SPECS
        ]
        return ReadingCard(
            item_key=item.key,
            attachment_key=extraction.attachment_key,
            title=item.title,
            mode='model',
            generated_by=self._model.name,
            sections=sections,
            evidence=ordered_evidence,
            warnings=warnings,
        )

    @staticmethod
    def _extractive_sections(
        evidence_by_section: Mapping[ReadingSectionKey, list[EvidenceSpan]],
    ) -> list[ReadingCardSection]:
        sections: list[ReadingCardSection] = []
        for key, title, _query in _SECTION_SPECS:
            evidence = evidence_by_section[key]
            summary = evidence[0].text if evidence else 'No matching evidence found.'
            sections.append(
                ReadingCardSection(
                    key=key,
                    title=title,
                    summary=summary,
                    evidence_ids=[entry.evidence_id for entry in evidence],
                )
            )
        return sections

    @staticmethod
    def _build_prompt(item: ItemSummary, evidence: list[EvidenceSpan]) -> str:
        evidence_text = '\n\n'.join(
            f'[{entry.evidence_id}] page {entry.page}\n{entry.text}' for entry in evidence
        )
        shape = {
            key: {'summary': '...', 'evidence_ids': ['ATTACHMENT:p1:c1']}
            for key, _title, _query in _SECTION_SPECS
        }
        return (
            'Create a concise scientific reading card for the item below. Every factual '
            'statement must be supported by one or more IDs from the evidence block. If the '
            'evidence is insufficient, say so and use an empty evidence_ids list.\n\n'
            f'Title: {item.title}\n'
            f'Authors: {", ".join(item.creators)}\n'
            f'Date: {item.date}\n\n'
            f'Required JSON shape:\n{json.dumps(shape, ensure_ascii=False)}\n\n'
            f'Evidence:\n{evidence_text}'
        )

    @staticmethod
    def _validate_model_card(
        payload: Mapping[str, Any],
        known_evidence_ids: set[str],
    ) -> _ModelCard:
        try:
            card = _ModelCard.model_validate(payload)
        except ValidationError as exc:
            raise ModelResponseError(
                'Model reading card does not match the required schema'
            ) from exc
        cited_ids = {
            evidence_id
            for key, _title, _query in _SECTION_SPECS
            for evidence_id in getattr(card, key).evidence_ids
        }
        unknown_ids = cited_ids - known_evidence_ids
        if unknown_ids:
            joined = ', '.join(sorted(unknown_ids))
            raise ModelResponseError(f'Model cited unknown evidence IDs: {joined}')
        return card
