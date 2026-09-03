"""FastMCP stdio adapter for the Zotero research service."""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from .config import Settings, build_content_policy, build_service
from .disclosure import MCPContentPolicy
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
        context = service.get_item_context(item_key)
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
    ) -> PdfExtraction:
        disclosure.require(
            attachment_key,
            allow_cloud=allow_cloud,
            server_id=service.content_server_id,
        )
        return service.extract_pdf(
            attachment_key,
            allow_heavy_fallback=allow_heavy_fallback,
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
    ) -> EvidenceResults:
        disclosure.require(
            attachment_key,
            allow_cloud=allow_cloud,
            server_id=service.content_server_id,
        )
        return service.retrieve_evidence(
            attachment_key,
            query,
            top_k=top_k,
            allow_heavy_fallback=allow_heavy_fallback,
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
    ) -> ReadingCard:
        disclosure.require(
            item_key,
            allow_cloud=allow_cloud,
            server_id=service.content_server_id,
        )
        return service.generate_reading_card(
            item_key,
            attachment_key=attachment_key,
            sensitivity=sensitivity,
            allow_cloud=allow_cloud,
            allow_heavy_fallback=allow_heavy_fallback,
        )

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
