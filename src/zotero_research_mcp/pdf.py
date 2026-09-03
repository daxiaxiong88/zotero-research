"""Local-first PDF extraction with an explicit heavy-parser fallback seam."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

import pymupdf

from .models import PdfExtraction, PdfPage, PdfQuality


class HeavyPdfParser(Protocol):
    """Adapter contract for an optional MinerU-class parser."""

    name: str
    is_local: bool

    def extract_pages(self, path: Path) -> list[PdfPage]:
        """Extract page-addressable text from ``path``."""


class PdfExtractionError(RuntimeError):
    """Raised when a PDF cannot be read safely."""


class PdfExtractor:
    """Extract selectable text quickly and escalate only when explicitly allowed."""

    def __init__(self, *, heavy_parser: HeavyPdfParser | None = None) -> None:
        self._heavy_parser = heavy_parser

    @property
    def heavy_parser_name(self) -> str | None:
        return self._heavy_parser.name if self._heavy_parser else None

    def extract(
        self,
        path: Path,
        *,
        attachment_key: str,
        allow_heavy_fallback: bool = False,
        force_heavy: bool = False,
    ) -> PdfExtraction:
        if force_heavy and not allow_heavy_fallback:
            raise ValueError("force_heavy=True requires allow_heavy_fallback=True")

        resolved_path = path.resolve()
        if not resolved_path.is_file():
            raise PdfExtractionError(f"PDF attachment does not exist: {resolved_path.name}")

        fast_pages = self._extract_with_pymupdf(resolved_path)
        fast_quality = assess_pdf_quality(fast_pages)
        if not force_heavy and not fast_quality.needs_heavy_parser:
            return PdfExtraction(
                attachment_key=attachment_key,
                file_name=resolved_path.name,
                parser="pymupdf",
                route="fast",
                page_count=len(fast_pages),
                pages=fast_pages,
                quality=fast_quality,
                fallback_used=False,
            )

        if allow_heavy_fallback and self._heavy_parser is None:
            raise PdfExtractionError(
                "This PDF needs a configured local heavy PDF parser; configure MinerU first."
            )

        if allow_heavy_fallback and self._heavy_parser is not None:
            if not self._heavy_parser.is_local:
                raise PermissionError(
                    "Heavy parsing of PDF full text is restricted to a local parser."
                )
            heavy_pages = self._heavy_parser.extract_pages(resolved_path)
            return PdfExtraction(
                attachment_key=attachment_key,
                file_name=resolved_path.name,
                parser=self._heavy_parser.name,
                route="heavy_fallback",
                page_count=len(heavy_pages),
                pages=heavy_pages,
                quality=assess_pdf_quality(heavy_pages),
                fallback_used=True,
            )

        return PdfExtraction(
            attachment_key=attachment_key,
            file_name=resolved_path.name,
            parser="pymupdf",
            route="heavy_recommended",
            page_count=len(fast_pages),
            pages=fast_pages,
            quality=fast_quality,
            fallback_used=False,
        )

    @staticmethod
    def _extract_with_pymupdf(path: Path) -> list[PdfPage]:
        try:
            with pymupdf.open(path) as document:  # type: ignore[no-untyped-call]
                if not document.is_pdf:
                    raise PdfExtractionError(
                        "Attachment is not a PDF (PyMuPDF detected another document format)."
                    )
                if document.needs_pass:
                    raise PdfExtractionError("Encrypted PDF requires a password.")
                return [
                    PdfPage(number=index + 1, text=_normalize_page_text(page.get_text("text")))
                    for index, page in enumerate(document)
                ]
        except PdfExtractionError:
            raise
        except (OSError, RuntimeError, ValueError) as exc:
            raise PdfExtractionError(f"Unable to parse PDF: {path.name}") from exc


def assess_pdf_quality(pages: list[PdfPage]) -> PdfQuality:
    """Assess extraction quality using deterministic, inexpensive signals."""

    page_count = len(pages)
    compact_texts = ["".join(page.text.split()) for page in pages]
    text_characters = sum(len(text) for text in compact_texts)
    empty_pages = sum(len(text) < 20 for text in compact_texts)
    replacement_characters = sum(text.count("\ufffd") for text in compact_texts)
    characters_per_page = text_characters / page_count if page_count else 0.0
    empty_page_ratio = empty_pages / page_count if page_count else 1.0
    replacement_ratio = replacement_characters / max(text_characters, 1)

    reasons: list[str] = []
    minimum_text = max(120, page_count * 80)
    if text_characters < minimum_text:
        reasons.append("insufficient_selectable_text")
    if empty_page_ratio >= 0.5:
        reasons.append("too_many_empty_pages")
    if replacement_ratio > 0.02:
        reasons.append("text_encoding_damage")

    density_score = min(characters_per_page / 500.0, 1.0)
    coverage_score = 1.0 - empty_page_ratio
    encoding_score = max(0.0, 1.0 - replacement_ratio * 10.0)
    score = 0.55 * density_score + 0.35 * coverage_score + 0.10 * encoding_score
    return PdfQuality(
        score=round(max(0.0, min(1.0, score)), 4),
        text_characters=text_characters,
        characters_per_page=round(characters_per_page, 2),
        empty_page_ratio=round(empty_page_ratio, 4),
        replacement_character_ratio=round(replacement_ratio, 6),
        needs_heavy_parser=bool(reasons),
        reasons=reasons,
    )


def _normalize_page_text(text: str) -> str:
    lines = [line.rstrip() for line in text.replace("\x00", "").splitlines()]
    return "\n".join(lines).strip()
