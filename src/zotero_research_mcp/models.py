"""Public data contracts shared by the service and MCP adapter."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field

# Zotero item/attachment keys: 8 characters from Zotero's base-32-style alphabet.
ITEM_KEY_ALPHABET = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ"
ITEM_KEY_FULLMATCH = re.compile(rf"[{ITEM_KEY_ALPHABET}]{{8}}")
ITEM_KEY_PATTERN = rf"^[{ITEM_KEY_ALPHABET}]{{8}}$"


class ZoteroStatus(BaseModel):
    """Observed read capabilities of the running Zotero instance."""

    reachable: bool
    version: str | None = None
    api_version: int | None = None
    schema_version: int | None = None
    server_id: str | None = None
    read_supported: bool = False
    detail: str | None = None


class HealthReport(BaseModel):
    """Connection and parser health exposed through ``health_check``."""

    status: Literal["ok", "degraded"]
    service_version: str
    zotero: ZoteroStatus


class ItemSummary(BaseModel):
    """Normalized Zotero bibliographic item."""

    key: str
    version: int = 0
    item_type: str
    title: str
    date: str = ""
    creators: list[str] = Field(default_factory=list)
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


class ReadingCardSection(BaseModel):
    """One evidence-linked section of a structured reading card."""

    key: ReadingSectionKey
    title: str
    summary: str
    evidence_ids: list[str]


class ReadingCard(BaseModel):
    """Structured paper reading result with a fixed evidence set."""

    item_key: str
    attachment_key: str
    title: str
    mode: Literal["evidence_only", "model"]
    generated_by: str
    sections: list[ReadingCardSection]
    evidence: list[EvidenceSpan]
    warnings: list[str] = Field(default_factory=list)
