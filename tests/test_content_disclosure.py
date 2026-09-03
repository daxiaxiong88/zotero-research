from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from mcp.server.fastmcp.exceptions import ToolError

from zotero_research_mcp.server import create_mcp_server
from zotero_research_mcp.service import ResearchService
from zotero_research_mcp.zotero import ZoteroLocalClient


def test_cloud_mcp_cannot_read_pdf_before_local_user_consent() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("A denied disclosure must not even resolve the attachment")

    server = create_mcp_server(
        service=ResearchService(zotero=ZoteroLocalClient(transport=httpx.MockTransport(handler)))
    )

    with pytest.raises(ToolError, match=r"本地.*授权"):
        asyncio.run(server.call_tool("extract_pdf", {"attachment_key": "ATTACH23"}))


def test_local_consent_is_expiring_and_bound_to_paper_and_zotero_instance(tmp_path: Path) -> None:
    from zotero_research_mcp.disclosure import ContentConsentStore, MCPContentPolicy
    from zotero_research_mcp.privacy import PrivacyViolation

    now = datetime(2026, 9, 3, tzinfo=UTC)
    store = ContentConsentStore(tmp_path / "consents", clock=lambda: now)
    store.grant_public(
        server_id="instance-a",
        parent_item_key="PARENT23",
        attachment_keys=["ATTACH23"],
        confirmed_public=True,
    )
    policy = MCPContentPolicy(consents=store)
    policy.require("ATTACH23", allow_cloud=True, server_id=lambda: "instance-a")
    for subject, instance, notes in [
        ("OTHER234", "instance-a", False),
        ("ATTACH23", "instance-b", False),
        ("PARENT23", "instance-a", True),
    ]:
        with pytest.raises(PrivacyViolation):
            policy.require(
                subject, allow_cloud=True, server_id=lambda instance=instance: instance, notes=notes
            )
    now += timedelta(minutes=11)
    with pytest.raises(PrivacyViolation):
        policy.require("ATTACH23", allow_cloud=True, server_id=lambda: "instance-a")


@pytest.mark.parametrize(
    ("tool", "arguments"),
    [
        ("retrieve_evidence", {"attachment_key": "ATTACH23", "query": "results"}),
        ("generate_reading_card", {"item_key": "PARENT23", "sensitivity": "public"}),
        ("get_item_context", {"item_key": "PARENT23", "include_notes": True}),
    ],
)
def test_every_content_returning_mcp_tool_requires_local_consent(
    tool: str, arguments: dict[str, object]
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("Sensitive content must not be accessed")

    server = create_mcp_server(
        service=ResearchService(zotero=ZoteroLocalClient(transport=httpx.MockTransport(handler)))
    )
    with pytest.raises(ToolError, match=r"本地.*授权"):
        asyncio.run(server.call_tool(tool, {**arguments, "allow_cloud": True}))
