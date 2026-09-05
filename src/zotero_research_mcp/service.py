"""Application service for read-only Zotero reading operations."""

from __future__ import annotations

from . import __version__
from .analysis import AnalysisTask, PaperAnalysis, PaperAnalysisBuilder, pdf_source
from .models import (
    EvidenceResults,
    EvidenceSpan,
    HealthReport,
    ItemContext,
    PdfExtraction,
    PdfPage,
    ReadingCard,
    SearchResults,
)
from .pdf import PdfExtractor
from .pdf_geometry import PdfQuoteLocator, QuoteLocation
from .reading import ReadingCardBuilder
from .retrieval import EvidenceRetriever
from .zotero import ZoteroLocalClient

_WEB_AI_FALLBACK_PAGE_LIMIT = 6
_WEB_AI_FALLBACK_PAGE_CHARACTERS = 9_000


class ResearchService:
    """Coordinate Zotero Local API and PDF evidence extraction."""

    def __init__(
        self,
        *,
        zotero: ZoteroLocalClient,
        pdf_extractor: PdfExtractor | None = None,
        evidence_retriever: EvidenceRetriever | None = None,
    ) -> None:
        self._zotero = zotero
        self._pdf_extractor = pdf_extractor or PdfExtractor()
        self._evidence_retriever = evidence_retriever or EvidenceRetriever()

    def close(self) -> None:
        self._zotero.close()

    def verify_instance(self, expected_server_id: str) -> None:
        self._zotero.pin_instance(expected_server_id)

    def parser_status(self) -> dict[str, str | None]:
        return {'fast': 'pymupdf', 'heavy': self._pdf_extractor.heavy_parser_name}

    def health_check(self) -> HealthReport:
        zotero_status = self._zotero.health()
        healthy = zotero_status.reachable and zotero_status.read_supported
        return HealthReport(
            status='ok' if healthy else 'degraded',
            service_version=__version__,
            zotero=zotero_status,
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
        force_heavy: bool = False,
    ) -> PdfExtraction:
        path = self._zotero.get_attachment_path(attachment_key)
        return self._pdf_extractor.extract(
            path,
            attachment_key=attachment_key,
            allow_heavy_fallback=allow_heavy_fallback,
            force_heavy=force_heavy,
        )

    def retrieve_evidence(
        self,
        attachment_key: str,
        query: str,
        *,
        top_k: int = 5,
        allow_heavy_fallback: bool = False,
        force_heavy: bool = False,
    ) -> EvidenceResults:
        extraction = self.extract_pdf(
            attachment_key,
            allow_heavy_fallback=allow_heavy_fallback,
            force_heavy=force_heavy,
        )
        return self._evidence_retriever.retrieve(extraction, query, top_k=top_k)

    def _select_pdf(self, context: ItemContext, attachment_key: str | None) -> str:
        candidates = [
            entry
            for entry in context.attachments
            if entry.content_type.casefold() == 'application/pdf'
            and (attachment_key is None or entry.key == attachment_key)
        ]
        if not candidates:
            raise ValueError('This item has no matching local PDF attachment')
        return candidates[0].key

    def generate_reading_card(
        self,
        item_key: str,
        *,
        attachment_key: str | None = None,
        allow_heavy_fallback: bool = False,
        force_heavy: bool = False,
    ) -> ReadingCard:
        context = self.get_item_context(item_key)
        selected_key = self._select_pdf(context, attachment_key)
        extraction = self.extract_pdf(
            selected_key,
            allow_heavy_fallback=allow_heavy_fallback,
            force_heavy=force_heavy,
        )
        return ReadingCardBuilder(
            retriever=self._evidence_retriever,
            model=None,
        ).build(item=context.item, extraction=extraction)

    def analyze_paper(
        self,
        item_key: str,
        *,
        attachment_key: str | None = None,
        mode: AnalysisTask = 'reading',
        question: str = '',
        selected_text: str = '',
        selection_page: int | None = None,
        allow_heavy_fallback: bool = False,
        force_heavy: bool = False,
    ) -> PaperAnalysis:
        context = self.get_item_context(item_key)
        selected_key = self._select_pdf(context, attachment_key)
        extraction = self.extract_pdf(
            selected_key,
            allow_heavy_fallback=allow_heavy_fallback,
            force_heavy=force_heavy,
        )
        return PaperAnalysisBuilder(
            retriever=self._evidence_retriever,
            model=None,
        ).build(
            item=context.item,
            extraction=extraction,
            task=mode,
            question=question,
            selected_text=selected_text,
            selection_page=selection_page,
        )

    def locate_quote(self, attachment_key: str, *, page: int, quote: str) -> QuoteLocation:
        path = self._zotero.get_attachment_path(attachment_key)
        return PdfQuoteLocator().locate(path, page=page, quote=quote)

    def fallback_page_context(self, extraction: PdfExtraction) -> list[EvidenceSpan]:
        """Bounded opening/closing pages for questions that miss BM25 terms."""

        pages = extraction.pages
        if not pages:
            return []
        selected_pages: list[PdfPage] = []
        for page in [*pages[:4], *pages[-2:]]:
            if page.number not in {item.number for item in selected_pages}:
                selected_pages.append(page)
        spans: list[EvidenceSpan] = []
        for page in selected_pages[:_WEB_AI_FALLBACK_PAGE_LIMIT]:
            text = page.text.strip()[:_WEB_AI_FALLBACK_PAGE_CHARACTERS]
            if not text:
                continue
            spans.append(
                EvidenceSpan(
                    evidence_id=f'{extraction.attachment_key}:p{page.number}:context',
                    page=page.number,
                    chunk_index=1,
                    text=text,
                    score=0.0,
                    source=pdf_source(extraction.attachment_key, page.number),
                )
            )
        return spans


def _compact(value: str) -> str:
    return ''.join(value.split()).replace('­', '').casefold()
