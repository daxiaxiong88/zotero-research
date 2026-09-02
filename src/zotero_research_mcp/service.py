"""Application service exposing the MCP tool seams."""

from __future__ import annotations

from . import __version__
from .model import ModelClient
from .models import (
    DocumentSensitivity,
    EvidenceResults,
    HealthReport,
    ItemContext,
    NotePreview,
    NoteWriteResult,
    PdfExtraction,
    ReadingCard,
    SearchResults,
    WriteAuthorization,
)
from .notes import NotePreviewStore
from .pdf import PdfExtractor
from .privacy import PrivacyPolicy
from .reading import ReadingCardBuilder
from .retrieval import EvidenceRetriever
from .zotero import (
    LocalWriteAuthorizationRequired,
    LocalWriteFailed,
    LocalWriteUnavailable,
    ZoteroLocalClient,
)


class ResearchService:
    """Coordinates policy-safe Zotero research operations."""

    def __init__(
        self,
        *,
        zotero: ZoteroLocalClient,
        pdf_extractor: PdfExtractor | None = None,
        evidence_retriever: EvidenceRetriever | None = None,
        model: ModelClient | None = None,
        privacy_policy: PrivacyPolicy | None = None,
        note_previews: NotePreviewStore | None = None,
    ) -> None:
        self._zotero = zotero
        self._pdf_extractor = pdf_extractor or PdfExtractor()
        self._evidence_retriever = evidence_retriever or EvidenceRetriever()
        self._reading_card_builder = ReadingCardBuilder(
            retriever=self._evidence_retriever,
            privacy_policy=privacy_policy or PrivacyPolicy(),
            model=model,
        )
        self._note_previews = note_previews or NotePreviewStore()

    def close(self) -> None:
        self._zotero.close()

    def health_check(self) -> HealthReport:
        zotero_status = self._zotero.health()
        healthy = zotero_status.reachable and zotero_status.read_supported
        return HealthReport(
            status="ok" if healthy else "degraded",
            service_version=__version__,
            zotero=zotero_status,
            write_mode="local_api" if zotero_status.write_supported else "preview_only",
        )

    def search_items(self, query: str, *, limit: int = 20) -> SearchResults:
        return self._zotero.search_items(query, limit=limit)

    def get_item_context(self, item_key: str) -> ItemContext:
        return self._zotero.get_item_context(item_key)

    def extract_pdf(
        self,
        attachment_key: str,
        *,
        allow_heavy_fallback: bool = False,
    ) -> PdfExtraction:
        path = self._zotero.get_attachment_path(attachment_key)
        return self._pdf_extractor.extract(
            path,
            attachment_key=attachment_key,
            allow_heavy_fallback=allow_heavy_fallback,
        )

    def retrieve_evidence(
        self,
        attachment_key: str,
        query: str,
        *,
        top_k: int = 5,
        allow_heavy_fallback: bool = False,
    ) -> EvidenceResults:
        extraction = self.extract_pdf(
            attachment_key,
            allow_heavy_fallback=allow_heavy_fallback,
        )
        return self._evidence_retriever.retrieve(extraction, query, top_k=top_k)

    def generate_reading_card(
        self,
        item_key: str,
        *,
        attachment_key: str | None = None,
        sensitivity: DocumentSensitivity = "sensitive",
        allow_cloud: bool = False,
        allow_heavy_fallback: bool = False,
    ) -> ReadingCard:
        context = self.get_item_context(item_key)
        pdf_attachments = [
            attachment
            for attachment in context.attachments
            if attachment.content_type.casefold() == "application/pdf"
        ]
        if attachment_key is None:
            if not pdf_attachments:
                raise ValueError("The Zotero item has no PDF attachment")
            selected_key = pdf_attachments[0].key
        else:
            matching = [
                attachment
                for attachment in pdf_attachments
                if attachment.key == attachment_key
            ]
            if not matching:
                raise ValueError("attachment_key is not a PDF child of the requested item")
            selected_key = attachment_key

        extraction = self.extract_pdf(
            selected_key,
            allow_heavy_fallback=allow_heavy_fallback,
        )
        return self._reading_card_builder.build(
            item=context.item,
            extraction=extraction,
            sensitivity=sensitivity,
            allow_cloud=allow_cloud,
        )

    def preview_child_note(
        self,
        parent_item_key: str,
        *,
        title: str,
        content: str,
        tags: list[str] | None = None,
    ) -> NotePreview:
        self.get_item_context(parent_item_key)
        return self._note_previews.create(
            parent_item_key=parent_item_key,
            title=title,
            content=content,
            tags=tags,
        )

    def request_write_authorization(self) -> WriteAuthorization:
        return self._zotero.request_write_authorization()

    def write_child_note(
        self,
        preview_token: str,
        *,
        expected_digest: str,
        confirmed_by_user: bool,
    ) -> NoteWriteResult:
        claim = self._note_previews.claim(
            preview_token,
            expected_digest=expected_digest,
            confirmed_by_user=confirmed_by_user,
        )
        try:
            created = self._zotero.create_child_note(
                claim.payload,
                write_token=claim.write_token,
            )
        except (LocalWriteUnavailable, LocalWriteAuthorizationRequired, LocalWriteFailed):
            self._note_previews.release(preview_token)
            raise
        except Exception:
            self._note_previews.consume(preview_token)
            raise
        self._note_previews.consume(preview_token)
        return NoteWriteResult(
            status="created",
            item_key=created.key,
            version=created.version,
            parent_item_key=claim.parent_item_key,
            digest=claim.digest,
        )
