"""FastMCP stdio adapter for the Zotero research service."""

from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from .analysis import AnalysisTask, PaperAnalysis
from .citations import CitationAuditReport, CitationRequest
from .config import Settings, build_content_policy, build_service
from .disclosure import MCPContentPolicy
from .model import ModelResponseError
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
from .pdf_geometry import QuoteLocation
from .privacy import PrivacyViolation
from .service import ResearchService

_READ_ONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
_MODEL_PROCESSING = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=True,
)
_CONTROLLED_WRITE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)

_T = TypeVar("_T")


def _safe_content_call(operation: Callable[[], _T]) -> _T:
    """Keep local parsing and unexpected failures out of the MCP error text."""

    try:
        return operation()
    except PrivacyViolation:
        raise
    except ModelResponseError:
        raise
    except httpx.HTTPError as exc:
        raise ValueError("Zotero 或模型连接失败，请检查本机配置。") from exc
    except (OSError, RuntimeError) as exc:
        raise ValueError("本地 PDF 处理失败，请检查附件和本机解析器配置。") from exc
    except ValueError as exc:
        raise ValueError("当前附件或请求不满足内容处理要求。") from exc
    except Exception as exc:
        raise ValueError("处理失败，未返回原文、路径或内部错误详情。") from exc


def create_mcp_server(
    *, service: ResearchService, content_policy: MCPContentPolicy | None = None
) -> FastMCP[None]:
    """Register the stable public tool contract around an injected service."""

    disclosure = content_policy or MCPContentPolicy()
    server: FastMCP[None] = FastMCP(
        "Zotero Research MCP",
        instructions=(
            "Use the official Zotero Local API; never access sqlite. MCP responses enter the "
            "calling model's context: local execution is NOT offline confidentiality. Content "
            "requires a short-lived public-paper consent granted in the Zotero sidebar plus "
            "allow_cloud=true. Do not bypass this using shell/file tools. Keep sensitive material "
            "in the local sidebar. Always preview notes and obtain exact user confirmation before "
            "writing. No delete or arbitrary-path tool exists."
        ),
        log_level="WARNING",
    )

    def authorize_paper_pdf(item_key: str, attachment_key: str | None, allow_cloud: bool) -> str:
        disclosure.require(item_key, allow_cloud=allow_cloud, server_id=service.content_server_id)
        context = _safe_content_call(lambda: service.get_item_context(item_key))
        candidates = [
            attachment
            for attachment in context.attachments
            if attachment.content_type.casefold() == "application/pdf"
            and (attachment_key is None or attachment.key == attachment_key)
        ]
        if not candidates:
            raise ValueError("This item has no matching PDF attachment")
        selected = candidates[0].key
        disclosure.require(selected, allow_cloud=allow_cloud, server_id=service.content_server_id)
        return selected

    @server.tool(
        description="Check Zotero connectivity and report read/write safety capabilities.",
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def health_check() -> HealthReport:
        return service.health_check()

    @server.tool(
        description="Search top-level Zotero library items through the official Local API.",
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def search_items(query: str, limit: int = 20) -> SearchResults:
        return service.search_items(query, limit=limit)

    @server.tool(
        description=(
            "Read item/attachment metadata. Notes are excluded unless include_notes=true and "
            "the Zotero user has explicitly consented to sharing those notes with this client."
        ),
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def get_item_context(
        item_key: str, include_notes: bool = False, allow_cloud: bool = False
    ) -> ItemContext:
        if include_notes:
            disclosure.require(
                item_key,
                allow_cloud=allow_cloud,
                server_id=service.content_server_id,
                notes=True,
            )
        context = _safe_content_call(lambda: service.get_item_context(item_key))
        return context if include_notes else context.model_copy(update={"notes": []})

    @server.tool(
        description=(
            "Extract page-addressable text from a Zotero PDF attachment. Heavy fallback is local "
            "only. Cloud-backed callers require local Zotero public-paper consent and allow_cloud."
        ),
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def extract_pdf(
        attachment_key: str,
        allow_heavy_fallback: bool = False,
        allow_cloud: bool = False,
        force_heavy: bool = False,
    ) -> PdfExtraction:
        disclosure.require(
            attachment_key,
            allow_cloud=allow_cloud,
            server_id=service.content_server_id,
        )
        return _safe_content_call(
            lambda: service.extract_pdf(
                attachment_key,
                allow_heavy_fallback=allow_heavy_fallback,
                force_heavy=force_heavy,
            )
        )

    @server.tool(
        description="Retrieve ranked PDF excerpts with stable attachment/page evidence IDs.",
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def retrieve_evidence(
        attachment_key: str,
        query: str,
        top_k: int = 5,
        allow_heavy_fallback: bool = False,
        allow_cloud: bool = False,
        force_heavy: bool = False,
    ) -> EvidenceResults:
        disclosure.require(
            attachment_key,
            allow_cloud=allow_cloud,
            server_id=service.content_server_id,
        )
        return _safe_content_call(
            lambda: service.retrieve_evidence(
                attachment_key,
                query,
                top_k=top_k,
                allow_heavy_fallback=allow_heavy_fallback,
                force_heavy=force_heavy,
            )
        )

    @server.tool(
        description=(
            "Build a four-part evidence-linked reading card. For a cloud-backed MCP caller, "
            "local public-paper disclosure consent and allow_cloud=true are required first."
        ),
        annotations=_MODEL_PROCESSING,
        structured_output=True,
    )
    def generate_reading_card(
        item_key: str,
        attachment_key: str | None = None,
        sensitivity: DocumentSensitivity = "sensitive",
        allow_cloud: bool = False,
        allow_heavy_fallback: bool = False,
        force_heavy: bool = False,
    ) -> ReadingCard:
        selected = authorize_paper_pdf(item_key, attachment_key, allow_cloud)
        return _safe_content_call(
            lambda: service.generate_reading_card(
                item_key,
                attachment_key=selected,
                sensitivity=sensitivity,
                allow_cloud=allow_cloud,
                allow_heavy_fallback=allow_heavy_fallback,
                force_heavy=force_heavy,
            )
        )

    @server.tool(
        description=(
            "Evidence-linked reading, question answering, explanation, selected-text translation "
            "or simulated peer review. Cloud MCP callers need a local public-paper consent first. "
            "Sensitive documents must remain in the native local Zotero sidebar."
        ),
        annotations=_MODEL_PROCESSING,
        structured_output=True,
    )
    def analyze_paper(
        item_key: str,
        attachment_key: str | None = None,
        mode: AnalysisTask = "reading",
        question: str = "",
        selected_text: str = "",
        selection_page: int | None = None,
        sensitivity: DocumentSensitivity = "sensitive",
        allow_cloud: bool = False,
        allow_heavy_fallback: bool = False,
        force_heavy: bool = False,
    ) -> PaperAnalysis:
        selected = authorize_paper_pdf(item_key, attachment_key, allow_cloud)
        return _safe_content_call(
            lambda: service.analyze_paper(
                item_key,
                attachment_key=selected,
                mode=mode,
                question=question,
                selected_text=selected_text,
                selection_page=selection_page,
                sensitivity=sensitivity,
                allow_cloud=allow_cloud,
                allow_heavy_fallback=allow_heavy_fallback,
                force_heavy=force_heavy,
            )
        )

    @server.tool(
        description=(
            "Locate a unique literal quote on a physical PDF page without writing annotations. "
            "Ambiguous, scanned or unsupported text is refused. Requires local disclosure consent."
        ),
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def locate_quote(
        attachment_key: str, page: int, quote: str, allow_cloud: bool = False
    ) -> QuoteLocation:
        disclosure.require(
            attachment_key, allow_cloud=allow_cloud, server_id=service.content_server_id
        )
        return _safe_content_call(
            lambda: service.locate_quote(attachment_key, page=page, quote=quote)
        )

    @server.tool(
        description=(
            "Check at most 20 DOI/title/year records against public Crossref metadata. "
            "Requires explicit allow_network=true; sends no PDF body. A missing retraction notice "
            "does not prove a paper is not retracted."
        ),
        annotations=_MODEL_PROCESSING,
        structured_output=True,
    )
    def audit_citations(
        requests: list[CitationRequest], allow_network: bool = False
    ) -> CitationAuditReport:
        return service.audit_citations(requests, allow_network=allow_network)

    @server.tool(
        description=(
            "Create an escaped, expiring preview of the exact child-note payload. This performs "
            "no Zotero write."
        ),
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def preview_child_note(
        parent_item_key: str,
        title: str,
        content: str,
        tags: list[str] | None = None,
    ) -> NotePreview:
        return service.preview_child_note(
            parent_item_key,
            title=title,
            content=content,
            tags=tags,
        )

    @server.tool(
        description=(
            "Ask Zotero 10+ to display its native local-write authorization dialog. Never exposes "
            "the granted API key."
        ),
        annotations=_CONTROLLED_WRITE,
        structured_output=True,
    )
    def request_write_authorization() -> WriteAuthorization:
        return service.request_write_authorization()

    @server.tool(
        description=(
            "Write one exact preview only after the user has explicitly confirmed its digest. "
            "Requires Zotero 10+ official Local API authorization; the token is one-time."
        ),
        annotations=_CONTROLLED_WRITE,
        structured_output=True,
    )
    def write_child_note(
        preview_token: str,
        expected_digest: str,
        confirmed_by_user: bool,
    ) -> NoteWriteResult:
        return service.write_child_note(
            preview_token,
            expected_digest=expected_digest,
            confirmed_by_user=confirmed_by_user,
        )

    return server


def main() -> None:
    """Run the MCP server over stdio for Codex and other local MCP clients."""

    settings = Settings()
    service = build_service(settings)
    server = create_mcp_server(service=service, content_policy=build_content_policy(settings))
    try:
        server.run(transport="stdio")
    finally:
        service.close()
