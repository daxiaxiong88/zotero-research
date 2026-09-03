"""Deterministic text-to-position mapping for Zotero PDF annotations.

The PDF reader stores text annotation rectangles in PDF user space: the origin
is the bottom-left of the unrotated page and the values are points.  PyMuPDF's
text extraction, on the other hand, reports rectangles relative to the crop box
with a top-left origin.  This module contains the deliberately small bridge
between those two representations.

The locator never infers a position from semantic similarity.  A location is
returned only when the requested text occurs exactly once in selectable text
and every selected word has a finite, positive-area geometry.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Literal

import pymupdf
from pydantic import BaseModel, Field

QuoteLocationStatus = Literal["exact", "ambiguous", "not_found", "unsupported"]


class QuoteLocation(BaseModel):
    """A page-local, Zotero-compatible location for a quoted passage."""

    status: QuoteLocationStatus
    page: int = Field(ge=1)
    text: str
    rects: list[list[float]] = Field(default_factory=list)
    page_label: str
    sort_index: str
    reason: str


@dataclass(frozen=True)
class _Word:
    """The subset of a PyMuPDF word tuple needed by the locator."""

    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    block_number: int
    line_number: int
    word_number: int


@dataclass(frozen=True)
class _Match:
    start_word: int
    end_word: int
    start_char: int


class PdfQuoteLocator:
    """Locate one exact quote on one physical PDF page.

    ``page`` is one-based, matching Zotero's user-facing page numbering.  The
    returned ``rects`` are ``[x1, y1, x2, y2]`` boxes in the unrotated PDF user
    coordinate system, with ``y1 < y2``.  A page rotation entry is intentionally
    ignored for the conversion: PDF.js converts annotation positions against
    the page's unrotated view box as well.
    """

    def locate(self, path: Path, *, page: int, quote: str) -> QuoteLocation:
        """Return a unique geometry-backed location or a refusal status."""

        result_page = page if isinstance(page, int) and page >= 1 else 1
        if not isinstance(quote, str) or not quote.strip():
            return self._result(
                status="unsupported",
                page=result_page,
                text=quote if isinstance(quote, str) else "",
                reason="quote must contain non-whitespace text",
            )

        try:
            resolved_path = path.expanduser().resolve()
        except (AttributeError, OSError, RuntimeError) as exc:
            return self._result(
                status="unsupported",
                page=result_page,
                text=quote,
                reason=f"unable to resolve PDF path: {exc}",
            )

        if not resolved_path.is_file():
            return self._result(
                status="unsupported",
                page=result_page,
                text=quote,
                reason=f"PDF attachment does not exist: {resolved_path.name}",
            )

        try:
            with pymupdf.open(resolved_path) as document:  # type: ignore[no-untyped-call]
                if not document.is_pdf:
                    return self._result(
                        status="unsupported",
                        page=result_page,
                        text=quote,
                        reason="attachment is not a PDF; PyMuPDF detected another document format",
                    )
                if document.needs_pass:
                    return self._result(
                        status="unsupported",
                        page=result_page,
                        text=quote,
                        reason="encrypted PDF requires a password",
                    )
                if not isinstance(page, int) or isinstance(page, bool) or page < 1:
                    return self._result(
                        status="unsupported",
                        page=result_page,
                        text=quote,
                        reason="page must be a positive one-based integer",
                    )
                if page > document.page_count:
                    return self._result(
                        status="unsupported",
                        page=page,
                        text=quote,
                        reason=f"requested page is outside the PDF ({document.page_count} pages)",
                    )

                pdf_page = document.load_page(page - 1)
                page_label = _page_label(pdf_page, page)
                words = _read_words(pdf_page)
                if not words:
                    return self._result(
                        status="unsupported",
                        page=page,
                        text=quote,
                        page_label=page_label,
                        reason="page has no selectable text with usable word geometry",
                    )

                stream, word_starts = _word_stream(words)
                normalized_quote = _canonical_text(quote)
                matches = _find_matches(stream, word_starts, normalized_quote, words)
                if not matches:
                    return self._result(
                        status="not_found",
                        page=page,
                        text=quote,
                        page_label=page_label,
                        reason="quote was not found in selectable text on the requested page",
                    )
                if len(matches) != 1:
                    return self._result(
                        status="ambiguous",
                        page=page,
                        text=quote,
                        page_label=page_label,
                        reason=f"quote has {len(matches)} exact matches on the requested page",
                    )

                match = matches[0]
                selected = words[match.start_word : match.end_word]
                crop_box = _crop_box(pdf_page)
                if crop_box is None:
                    return self._result(
                        status="ambiguous",
                        page=page,
                        text=quote,
                        page_label=page_label,
                        reason="PDF page crop box is unavailable or invalid",
                    )
                if not _is_visual_sequence_reliable(selected):
                    return self._result(
                        status="ambiguous",
                        page=page,
                        text=quote,
                        page_label=page_label,
                        reason="matched words do not form one reliable visual text sequence",
                    )

                rects = _rects_in_pdf_space(selected, crop_box)
                if not rects or not _rects_are_reliable(rects, crop_box):
                    return self._result(
                        status="ambiguous",
                        page=page,
                        text=quote,
                        page_label=page_label,
                        reason="matched text has invalid or out-of-page geometry",
                    )

                sort_index = _sort_index(
                    page_index=page - 1,
                    offset=match.start_char,
                    rects=rects,
                    page_top=float(crop_box.y1),
                )
                return QuoteLocation(
                    status="exact",
                    page=page,
                    text=quote,
                    rects=rects,
                    page_label=page_label,
                    sort_index=sort_index,
                    reason="",
                )
        except (OSError, RuntimeError, ValueError, pymupdf.FileDataError) as exc:
            return self._result(
                status="unsupported",
                page=result_page,
                text=quote,
                reason=f"unable to read PDF text geometry: {exc}",
            )

    @staticmethod
    def _result(
        *,
        status: QuoteLocationStatus,
        page: int,
        text: str,
        reason: str,
        page_label: str = "",
        rects: list[list[float]] | None = None,
        sort_index: str = "",
    ) -> QuoteLocation:
        return QuoteLocation(
            status=status,
            page=max(page, 1),
            text=text,
            rects=rects or [],
            page_label=page_label,
            sort_index=sort_index,
            reason=reason,
        )


def _canonical_text(text: str) -> str:
    """Normalize only Unicode compatibility forms and whitespace runs."""

    normalized = unicodedata.normalize("NFKC", text.replace("\x00", ""))
    return re.sub(r"\s+", " ", normalized).strip()


def _read_words(page: pymupdf.Page) -> list[_Word]:
    raw_words = page.get_text("words", sort=True)  # type: ignore[no-untyped-call]
    words: list[_Word] = []
    for raw_word in raw_words:
        if not isinstance(raw_word, (tuple, list)) or len(raw_word) < 8:
            continue
        text = raw_word[4]
        if not isinstance(text, str) or not text.strip():
            continue
        try:
            coordinates = tuple(float(raw_word[index]) for index in range(4))
            identifiers = tuple(int(raw_word[index]) for index in range(5, 8))
        except (TypeError, ValueError, OverflowError):
            continue
        if not all(math.isfinite(value) for value in coordinates):
            continue
        words.append(
            _Word(
                x0=coordinates[0],
                y0=coordinates[1],
                x1=coordinates[2],
                y1=coordinates[3],
                text=text,
                block_number=identifiers[0],
                line_number=identifiers[1],
                word_number=identifiers[2],
            )
        )
    return words


def _word_stream(words: list[_Word]) -> tuple[str, list[int]]:
    parts: list[str] = []
    starts: list[int] = []
    position = 0
    for word in words:
        canonical_word = _canonical_text(word.text)
        if not canonical_word:
            continue
        if parts:
            parts.append(" ")
            position += 1
        starts.append(position)
        parts.append(canonical_word)
        position += len(canonical_word)
    return "".join(parts), starts


def _find_matches(
    stream: str,
    word_starts: list[int],
    quote: str,
    words: list[_Word],
) -> list[_Match]:
    if not quote:
        return []
    matches: list[_Match] = []
    search_from = 0
    while True:
        start = stream.find(quote, search_from)
        if start < 0:
            break
        end = start + len(quote)
        if (start == 0 or stream[start - 1] == " ") and (
            end == len(stream) or stream[end] == " "
        ):
            start_word = _word_index_at(word_starts, start)
            end_word_index = _word_index_at(word_starts, end - 1)
            if start_word is not None and end_word_index is not None:
                end_word = end_word_index + 1
            else:
                end_word = len(words) + 1
            if start_word is not None and end_word <= len(words):
                matches.append(_Match(start_word, end_word, start))
        search_from = start + 1
    return matches


def _word_index_at(starts: list[int], position: int) -> int | None:
    for index in range(len(starts) - 1, -1, -1):
        if starts[index] <= position:
            return index
    return None


def _crop_box(page: pymupdf.Page) -> pymupdf.Rect | None:
    try:
        crop_box = page.cropbox
        values = (float(crop_box.x0), float(crop_box.y0), float(crop_box.x1), float(crop_box.y1))
    except (AttributeError, TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for value in values):
        return None
    if values[2] <= values[0] or values[3] <= values[1]:
        return None
    return pymupdf.Rect(*values)  # type: ignore[no-untyped-call]


def _page_label(page: pymupdf.Page, physical_page: int) -> str:
    try:
        label = page.get_label()  # type: ignore[no-untyped-call]
    except (AttributeError, RuntimeError, ValueError):
        label = ""
    return label.strip() if isinstance(label, str) and label.strip() else str(physical_page)


def _is_visual_sequence_reliable(words: list[_Word]) -> bool:
    if not words:
        return False
    for word in words:
        if word.x1 <= word.x0 or word.y1 <= word.y0:
            return False

    for previous, current in pairwise(words):
        same_line = (
            previous.block_number == current.block_number
            and previous.line_number == current.line_number
        )
        if same_line:
            # PyMuPDF's sorted order is left-to-right for ordinary horizontal
            # text.  A small overlap tolerance handles kerning and rounding.
            if current.x1 < previous.x0 - 1.0:
                return False
            continue

        previous_center_y = (previous.y0 + previous.y1) / 2.0
        current_center_y = (current.y0 + current.y1) / 2.0
        # A line transition that moves back to the left at the same vertical
        # position is normally a cross-column false match.  Refuse it rather
        # than creating a highlight over unrelated columns.
        if current_center_y <= previous_center_y + 1.0 and current.x0 < previous.x0 - 1.0:
            return False
    return True


def _rects_in_pdf_space(words: list[_Word], crop_box: pymupdf.Rect) -> list[list[float]]:
    grouped: list[tuple[tuple[int, int], list[_Word]]] = []
    for word in words:
        line_key = (word.block_number, word.line_number)
        if grouped and grouped[-1][0] == line_key:
            grouped[-1][1].append(word)
        else:
            grouped.append((line_key, [word]))

    rects: list[list[float]] = []
    for _, line_words in grouped:
        x0 = min(word.x0 for word in line_words)
        y0 = min(word.y0 for word in line_words)
        x1 = max(word.x1 for word in line_words)
        y1 = max(word.y1 for word in line_words)
        rects.append(
            [
                float(crop_box.x0 + x0),
                float(crop_box.y1 - y1),
                float(crop_box.x0 + x1),
                float(crop_box.y1 - y0),
            ]
        )
    return rects


def _rects_are_reliable(rects: list[list[float]], crop_box: pymupdf.Rect) -> bool:
    for rect in rects:
        if len(rect) != 4 or not all(math.isfinite(value) for value in rect):
            return False
        x0, y0, x1, y1 = rect
        if x1 <= x0 or y1 <= y0:
            return False
        if x0 < crop_box.x0 - 1e-3 or x1 > crop_box.x1 + 1e-3:
            return False
        if y0 < crop_box.y0 - 1e-3 or y1 > crop_box.y1 + 1e-3:
            return False
    return True


def _sort_index(*, page_index: int, offset: int, rects: list[list[float]], page_top: float) -> str:
    top = max(0, math.floor(page_top - max(rect[3] for rect in rects)))
    return "|".join(
        (
            str(page_index)[:5].zfill(5),
            str(max(offset, 0))[:6].zfill(6),
            str(top)[:5].zfill(5),
        )
    )
