"""Deterministic, dependency-light retrieval over page-addressable PDF text."""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

from .models import EvidenceResults, EvidenceSpan, PdfExtraction

_TOKEN_PATTERN = re.compile(r"[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff]", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class _Chunk:
    page: int
    index: int
    text: str
    tokens: tuple[str, ...]


class EvidenceRetriever:
    """BM25 retrieval with deterministic page/chunk citations."""

    def __init__(self, *, max_chunk_characters: int = 1_200, overlap: int = 160) -> None:
        if max_chunk_characters < 300:
            raise ValueError("max_chunk_characters must be at least 300")
        if not 0 <= overlap < max_chunk_characters:
            raise ValueError("overlap must be smaller than max_chunk_characters")
        self._max_chunk_characters = max_chunk_characters
        self._overlap = overlap

    def retrieve(
        self,
        extraction: PdfExtraction,
        query: str,
        *,
        top_k: int = 5,
    ) -> EvidenceResults:
        normalized_query = query.strip()
        query_tokens = _tokenize(normalized_query)
        if not query_tokens:
            raise ValueError("query must contain searchable text")
        if not 1 <= top_k <= 20:
            raise ValueError("top_k must be between 1 and 20")

        chunks = self._chunks(extraction)
        ranked = self._rank(chunks, query_tokens, normalized_query)
        evidence = [
            EvidenceSpan(
                evidence_id=(
                    f"{extraction.attachment_key}:p{chunk.page}:c{chunk.index}"
                ),
                page=chunk.page,
                chunk_index=chunk.index,
                text=chunk.text,
                score=round(score, 6),
                source=(
                    f"zotero://attachment/{extraction.attachment_key}?page={chunk.page}"
                ),
            )
            for score, chunk in ranked[:top_k]
        ]
        warnings = (
            ["PDF extraction quality is low; consider a configured local heavy parser."]
            if extraction.quality.needs_heavy_parser
            else []
        )
        return EvidenceResults(
            attachment_key=extraction.attachment_key,
            query=normalized_query,
            parser=extraction.parser,
            evidence=evidence,
            warnings=warnings,
        )

    def _chunks(self, extraction: PdfExtraction) -> list[_Chunk]:
        chunks: list[_Chunk] = []
        for page in extraction.pages:
            for index, text in enumerate(self._split_text(page.text), start=1):
                tokens = tuple(_tokenize(text))
                if tokens:
                    chunks.append(
                        _Chunk(page=page.number, index=index, text=text, tokens=tokens)
                    )
        return chunks

    def _split_text(self, text: str) -> list[str]:
        normalized = re.sub(r"[ \t]+", " ", text).strip()
        if not normalized:
            return []

        chunks: list[str] = []
        start = 0
        while start < len(normalized):
            hard_end = min(start + self._max_chunk_characters, len(normalized))
            end = hard_end
            if hard_end < len(normalized):
                boundary = max(
                    normalized.rfind("\n", start, hard_end),
                    normalized.rfind(". ", start, hard_end),
                    normalized.rfind("。", start, hard_end),
                )
                if boundary > start + self._max_chunk_characters // 2:
                    end = boundary + 1
            chunk = normalized[start:end].strip()
            if chunk:
                chunks.append(chunk)
            if end >= len(normalized):
                break
            start = max(end - self._overlap, start + 1)
        return chunks

    @staticmethod
    def _rank(
        chunks: list[_Chunk],
        query_tokens: list[str],
        raw_query: str,
    ) -> list[tuple[float, _Chunk]]:
        if not chunks:
            return []
        document_frequency = Counter(
            token for chunk in chunks for token in set(chunk.tokens)
        )
        average_length = sum(len(chunk.tokens) for chunk in chunks) / len(chunks)
        query_frequency = Counter(query_tokens)
        ranked: list[tuple[float, _Chunk]] = []
        for chunk in chunks:
            frequencies = Counter(chunk.tokens)
            score = 0.0
            for token, query_count in query_frequency.items():
                term_frequency = frequencies[token]
                if term_frequency == 0:
                    continue
                frequency = document_frequency[token]
                inverse_frequency = math.log(
                    1.0 + (len(chunks) - frequency + 0.5) / (frequency + 0.5)
                )
                normalization = term_frequency + 1.5 * (
                    0.25 + 0.75 * len(chunk.tokens) / max(average_length, 1.0)
                )
                score += (
                    inverse_frequency
                    * term_frequency
                    * 2.5
                    / normalization
                    * query_count
                )
            if raw_query.casefold() in chunk.text.casefold():
                score += 1.5
            if score > 0:
                ranked.append((score, chunk))
        ranked.sort(key=lambda entry: (-entry[0], entry[1].page, entry[1].index))
        return ranked


def _tokenize(text: str) -> list[str]:
    return [match.group(0).casefold() for match in _TOKEN_PATTERN.finditer(text)]
