from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import httpx
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from zotero_research_mcp.server import create_mcp_server
from zotero_research_mcp.service import ResearchService
from zotero_research_mcp.zotero import ZoteroLocalClient


def test_mcp_exposes_only_scoped_zotero_research_tools() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Tool registration must not call Zotero: {request.url}")

    service = ResearchService(zotero=ZoteroLocalClient(transport=httpx.MockTransport(handler)))
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
    }
    assert "path" not in by_name["extract_pdf"]["inputSchema"]["properties"]
    assert by_name["search_items"]["annotations"]["readOnlyHint"] is True
    assert by_name["generate_reading_card"]["annotations"]["readOnlyHint"] is False
    assert all(tool["annotations"]["destructiveHint"] is False for tool in by_name.values())
    assert "delete" not in by_name
    for tool in by_name.values():
        properties = tool["inputSchema"].get("properties", {})
        assert "sensitivity" not in properties
        assert "allow_cloud" not in properties


@pytest.mark.parametrize("entrypoint", ["python-module", "installed-script"])
def test_stdio_entrypoint_completes_mcp_handshake(tmp_path: Path, entrypoint: str) -> None:
    async def exercise_server() -> set[str]:
        executable = Path(sys.executable).with_name(
            "zotero-research-mcp.exe" if os.name == "nt" else "zotero-research-mcp"
        )
        if entrypoint == "installed-script":
            assert executable.is_file(), (
                "Install the project scripts before running integration tests"
            )
        parameters = StdioServerParameters(
            command=str(executable) if entrypoint == "installed-script" else sys.executable,
            args=[
                "-c",
                "from zotero_research_mcp.server import main; main()",
            ]
            if entrypoint == "python-module"
            else [],
            cwd=str(tmp_path),  # Never load the operator's .env or real paper configuration.
            env={"ZRM_STATE_DIRECTORY": str(tmp_path / "state")},
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
    assert "write_child_note" not in names
    assert len(names) == 8
