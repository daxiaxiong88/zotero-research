"""Public data contracts shared by the service and MCP adapter."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ZoteroStatus(BaseModel):
    """Observed capabilities of the running Zotero instance."""

    reachable: bool
    version: str | None = None
    api_version: int | None = None
    schema_version: int | None = None
    server_id: str | None = None
    read_supported: bool = False
    write_supported: bool = False
    detail: str | None = None


class HealthReport(BaseModel):
    """Health and safety posture exposed through ``health_check``."""

    status: Literal["ok", "degraded"]
    service_version: str
    zotero: ZoteroStatus
    write_mode: Literal["local_api", "preview_only"]
    sqlite_access: Literal["forbidden"] = "forbidden"


class ItemSummary(BaseModel):
    """Normalized Zotero bibliographic item."""

    key: str
    version: int = 0
    item_type: str
    title: str
    date: str = ""
    creators: list[str] = Field(default_factory=list)
    doi: str = ""
    url: str = ""


class SearchResults(BaseModel):
    """A page of normalized top-level Zotero items."""

    total: int
    items: list[ItemSummary]


class AttachmentSummary(BaseModel):
    """Metadata for a child attachment without reading its file."""

    key: str
    version: int = 0
    title: str = ""
    content_type: str = ""
    filename: str = ""
    link_mode: str = ""
    parent_item: str


class NoteSummary(BaseModel):
    """A Zotero child note."""

    key: str
    version: int = 0
    html: str
    parent_item: str


class ItemContext(BaseModel):
    """One bibliographic item and its immediate children."""

    item: ItemSummary
    attachments: list[AttachmentSummary] = Field(default_factory=list)
    notes: list[NoteSummary] = Field(default_factory=list)


class PdfPage(BaseModel):
    """Text extracted from one physical PDF page."""

    number: int = Field(ge=1)
    text: str


class PdfQuality(BaseModel):
    """Cheap diagnostics used to decide whether heavy parsing is warranted."""

    score: float = Field(ge=0.0, le=1.0)
    text_characters: int = Field(ge=0)
    characters_per_page: float = Field(ge=0.0)
    empty_page_ratio: float = Field(ge=0.0, le=1.0)
    replacement_character_ratio: float = Field(ge=0.0, le=1.0)
    needs_heavy_parser: bool
    reasons: list[str] = Field(default_factory=list)


class PdfExtraction(BaseModel):
    """Page-addressable PDF text and the parser routing decision."""

    attachment_key: str
    file_name: str
    parser: str
    route: Literal["fast", "heavy_recommended", "heavy_fallback"]
    page_count: int = Field(ge=0)
    pages: list[PdfPage]
    quality: PdfQuality
    fallback_used: bool


class EvidenceSpan(BaseModel):
    """One ranked, page-addressable excerpt from a Zotero attachment."""

    evidence_id: str
    page: int = Field(ge=1)
    chunk_index: int = Field(ge=1)
    text: str
    score: float = Field(ge=0.0)
    source: str


class EvidenceResults(BaseModel):
    """Evidence returned for a focused question."""

    attachment_key: str
    query: str
    parser: str
    evidence: list[EvidenceSpan]
    warnings: list[str] = Field(default_factory=list)


ReadingSectionKey = Literal[
    "research_question",
    "methods",
    "key_findings",
    "limitations",
]
DocumentSensitivity = Literal["public", "sensitive"]


class ReadingCardSection(BaseModel):
    """One evidence-linked section of a structured reading card."""

    key: ReadingSectionKey
    title: str
    summary: str
    evidence_ids: list[str]


class ReadingCard(BaseModel):
    """Structured paper reading result with a closed citation set."""

    item_key: str
    attachment_key: str
    title: str
    sensitivity: DocumentSensitivity
    mode: Literal["evidence_only", "model"]
    generated_by: str
    sections: list[ReadingCardSection]
    evidence: list[EvidenceSpan]
    warnings: list[str] = Field(default_factory=list)


class NotePreview(BaseModel):
    """Exact, expiring child-note payload presented before any write."""

    preview_token: str
    digest: str
    server_id: str | None = None
    parent_item_key: str
    title: str
    note_html: str
    note_text: str = ""
    tags: list[str]
    expires_at: datetime
    requires_user_confirmation: Literal[True] = True


class WriteAuthorization(BaseModel):
    """Non-secret result of Zotero's local write authorization dialog."""

    authorized: bool
    remembered: bool = False
    server_id: str | None = None
    detail: str


class NoteWriteResult(BaseModel):
    """Result of committing one previously previewed child note."""

    status: Literal["created"]
    item_key: str
    version: int = Field(ge=0)
    parent_item_key: str
    digest: str
