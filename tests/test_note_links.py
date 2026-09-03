from zotero_research_mcp.notes import NotePreviewStore


def test_notes_link_only_canonical_zotero_pdf_sources_and_escape_other_content() -> None:
    text = (
        "Evidence [PDFKEY23:p2:c1]\n"
        "zotero://open-pdf/library/items/PDFKEY23?page=2\n"
        '<img src="https://external.example/tracker"> https://external.example/paper'
    )
    preview = NotePreviewStore().create(parent_item_key="PARENT23", title="Synthetic", content=text)
    assert '<a href="zotero://open-pdf/library/items/PDFKEY23?page=2">' in preview.note_html
    assert '<a href="https://' not in preview.note_html
    assert "<img" not in preview.note_html
    assert preview.note_text == f"Synthetic\n\n{text}"
