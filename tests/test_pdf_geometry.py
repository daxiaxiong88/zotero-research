from __future__ import annotations

from pathlib import Path

import pymupdf as fitz
import pytest

from zotero_research_mcp.pdf_geometry import PdfQuoteLocator


def _save_two_line_pdf(path: Path, *, crop: bool = False, rotation: int = 0) -> None:
    document = fitz.open()
    page = document.new_page(width=600, height=800)
    page.insert_text((72, 100), "First line for exact geometry.", fontsize=11)
    page.insert_text((72, 120), "Second line contains a unique quote.", fontsize=11)
    if crop:
        page.set_cropbox(fitz.Rect(50, 30, 550, 700))
    if rotation:
        page.set_rotation(rotation)
    document.save(path)
    document.close()


def test_locator_returns_unique_multiline_native_pdf_rects(tmp_path: Path) -> None:
    pdf_path = tmp_path / "two-lines.pdf"
    _save_two_line_pdf(pdf_path)

    location = PdfQuoteLocator().locate(
        pdf_path,
        page=1,
        quote="First line for exact geometry. Second line contains a unique quote.",
    )

    assert location.status == "exact"
    assert location.page == 1
    assert location.page_label == "1"
    assert len(location.rects) == 2
    assert location.rects[0][0] == pytest.approx(72.0)
    assert location.rects[0][1] > 650.0
    assert location.rects[0][1] > location.rects[1][1]
    assert location.rects[0][3] > location.rects[0][1]
    assert location.sort_index == "00000|000000|00088"


def test_locator_uses_asymmetric_crop_box_for_native_coordinates(tmp_path: Path) -> None:
    pdf_path = tmp_path / "asymmetric-crop.pdf"
    _save_two_line_pdf(pdf_path, crop=True)

    location = PdfQuoteLocator().locate(
        pdf_path,
        page=1,
        quote="First line for exact geometry.",
    )

    assert location.status == "exact"
    assert location.rects[0][0] == pytest.approx(72.0)
    assert location.rects[0][1] == pytest.approx(696.711, abs=0.02)
    assert location.rects[0][3] == pytest.approx(711.825, abs=0.02)


def test_locator_uses_unrotated_transform_for_asymmetric_crop_and_rotation(
    tmp_path: Path,
) -> None:
    pdf_path = tmp_path / "cropped-rotated.pdf"
    _save_two_line_pdf(pdf_path, crop=True, rotation=90)

    location = PdfQuoteLocator().locate(
        pdf_path,
        page=1,
        quote="First line for exact geometry.",
    )

    assert location.status == "exact"
    assert location.rects[0][0] == pytest.approx(72.0)
    # The y coordinate is in bottom-left PDF user space, not PyMuPDF's
    # top-left extraction space.  Both crop margins are asymmetric, and the
    # page rotation does not swap the unrotated PDF coordinates.
    assert location.rects[0][1] == pytest.approx(696.711, abs=0.02)
    assert location.rects[0][3] == pytest.approx(711.825, abs=0.02)


def test_locator_supports_nonzero_media_box_origin(tmp_path: Path) -> None:
    pdf_path = tmp_path / "nonzero-media-box.pdf"
    document = fitz.open()
    page = document.new_page(width=600, height=800)
    page.set_mediabox(fitz.Rect(100, 200, 700, 1000))
    page.insert_text((72, 100), "Nonzero media box coordinate.", fontsize=11)
    document.save(pdf_path)
    document.close()

    location = PdfQuoteLocator().locate(
        pdf_path,
        page=1,
        quote="Nonzero media box coordinate.",
    )

    assert location.status == "exact"
    assert location.rects[0][0] == pytest.approx(172.0)
    assert location.rects[0][1] == pytest.approx(896.711, abs=0.02)
    assert location.rects[0][3] == pytest.approx(911.825, abs=0.02)


def test_locator_refuses_duplicate_exact_matches(tmp_path: Path) -> None:
    pdf_path = tmp_path / "duplicate.pdf"
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 100), "Repeated phrase appears here.", fontsize=11)
    page.insert_text((72, 140), "Repeated phrase appears here.", fontsize=11)
    document.save(pdf_path)
    document.close()

    location = PdfQuoteLocator().locate(pdf_path, page=1, quote="Repeated phrase appears here.")

    assert location.status == "ambiguous"
    assert location.rects == []
    assert "2 exact matches" in location.reason


def test_locator_distinguishes_not_found_from_unsupported_page(tmp_path: Path) -> None:
    pdf_path = tmp_path / "blank.pdf"
    document = fitz.open()
    document.new_page()
    document.save(pdf_path)
    document.close()

    not_found_pdf = tmp_path / "text.pdf"
    _save_two_line_pdf(not_found_pdf)
    not_found = PdfQuoteLocator().locate(not_found_pdf, page=1, quote="not present")
    unsupported = PdfQuoteLocator().locate(pdf_path, page=1, quote="not present")

    assert not_found.status == "not_found"
    assert unsupported.status == "unsupported"
    assert unsupported.rects == []
