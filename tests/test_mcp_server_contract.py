from __future__ import annotations

import asyncio
import sys

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from zotero_research_mcp.server import create_mcp_server
from zotero_research_mcp.service import ResearchService
from zotero_research_mcp.zotero import ZoteroLocalClient


def test_mcp_exposes_only_scoped_zotero_research_tools() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Tool registration must not call Zotero: {request.url}")

    service = ResearchService(
        zotero=ZoteroLocalClient(transport=httpx.MockTransport(handler))
    )
    server = create_mcp_server(service=service)

    tools = asyncio.run(server.list_tools())
    by_name = {tool.name: tool.model_dump(by_alias=True) for tool in tools}

    assert set(by_name) == {
        "health_check",
        "search_items",
        "get_item_context",
        "extract_pdf",
        "retrieve_evidence",
        "generate_reading_card",
        "analyze_paper",
        "locate_quote",
        "audit_citations",
        "preview_child_note",
        "request_write_authorization",
        "write_child_note",
    }
    assert "path" not in by_name["extract_pdf"]["inputSchema"]["properties"]
    assert set(by_name["write_child_note"]["inputSchema"]["required"]) == {
        "preview_token",
        "expected_digest",
        "confirmed_by_user",
    }
    write_description = by_name["write_child_note"]["description"].casefold()
    assert "exact preview" in write_description
    assert "explicitly confirmed" in write_description
    assert by_name["search_items"]["annotations"]["readOnlyHint"] is True
    assert by_name["generate_reading_card"]["annotations"]["readOnlyHint"] is False
    assert by_name["write_child_note"]["annotations"]["readOnlyHint"] is False
    assert all(
        tool["annotations"]["destructiveHint"] is False for tool in by_name.values()
    )
    assert "delete" not in by_name


def test_stdio_entrypoint_completes_mcp_handshake() -> None:
    async def exercise_server() -> set[str]:
        parameters = StdioServerParameters(
            command=sys.executable,
            args=[
                "-c",
                "from zotero_research_mcp.server import main; main()",
            ],
        )
        async with (
            stdio_client(parameters) as (reader, writer),
            ClientSession(reader, writer) as session,
        ):
            await session.initialize()
            response = await session.list_tools()
            return {tool.name for tool in response.tools}

    names = asyncio.run(exercise_server())

    assert "health_check" in names
    assert "generate_reading_card" in names
    assert "write_child_note" in names
