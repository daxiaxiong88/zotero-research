from __future__ import annotations

import asyncio
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, NoReturn

import httpx
import pytest
from mcp.server.fastmcp.exceptions import ToolError
from pydantic import ValidationError

from zotero_research_mcp.bridge import BridgeApplication, create_bridge_server
from zotero_research_mcp.config import Settings, build_content_policy
from zotero_research_mcp.disclosure import (
    ContentConsentStore,
    MCPContentPolicy,
    PublicContentGrant,
)
from zotero_research_mcp.mineru import MinerUParserError
from zotero_research_mcp.model import ModelResponseError
from zotero_research_mcp.models import AttachmentSummary, ItemContext, ItemSummary
from zotero_research_mcp.privacy import PrivacyViolation
from zotero_research_mcp.server import create_mcp_server
from zotero_research_mcp.service import ResearchService
from zotero_research_mcp.zotero import (
    LocalWriteFailed,
    LocalWriteOutcomeUnknown,
    LocalWriteUnavailable,
    ZoteroLocalClient,
)

SERVER_ID = "instance-a"
PARENT_KEY = "PARENT23"
PUBLIC_PDF = "PUBLIC23"
PRIVATE_PDF = "DRAFT234"
NON_PDF = "TEXT2345"
FOREIGN_PDF = "XTHER234"
FOREIGN_PARENT = "PARANT23"


def _context() -> ItemContext:
    return ItemContext(
        item=ItemSummary(key=PARENT_KEY, item_type="journalArticle", title="Synthetic paper"),
        attachments=[
            AttachmentSummary(
                key=PUBLIC_PDF,
                content_type="application/pdf",
                parent_item=PARENT_KEY,
            ),
            AttachmentSummary(
                key=PRIVATE_PDF,
                content_type="application/pdf",
                parent_item=PARENT_KEY,
            ),
            AttachmentSummary(
                key=NON_PDF,
                content_type="text/plain",
                parent_item=PARENT_KEY,
            ),
            AttachmentSummary(
                key=FOREIGN_PDF,
                content_type="application/pdf",
                parent_item=FOREIGN_PARENT,
            ),
        ],
    )


class _GrantService:
    def __init__(self) -> None:
        self.context = _context()

    def verify_instance(self, expected_server_id: str) -> None:
        assert expected_server_id == SERVER_ID

    def get_item_context(self, item_key: str) -> ItemContext:
        assert item_key == PARENT_KEY
        return self.context


def test_bridge_grants_only_selected_current_pdf_and_defaults_notes_to_false(
    tmp_path: Path,
) -> None:
    store = ContentConsentStore(tmp_path / "grants")
    app = BridgeApplication(_GrantService(), store)

    result = app.dispatch(
        {
            "method": "grant_cloud_access",
            "expected_server_id": SERVER_ID,
            "params": {
                "item_key": PARENT_KEY,
                "attachment_key": PUBLIC_PDF,
                "confirmed_public": True,
            },
        }
    )

    assert isinstance(result, PublicContentGrant)
    assert result.parent_item_key == PARENT_KEY
    assert result.attachment_keys == [PUBLIC_PDF]
    assert result.include_notes is False
    assert store.allows(PUBLIC_PDF, server_id=SERVER_ID)
    assert not store.allows(PRIVATE_PDF, server_id=SERVER_ID)
    assert not store.allows(PARENT_KEY, server_id=SERVER_ID, notes=True)


def test_bridge_grant_can_separately_enable_parent_notes(tmp_path: Path) -> None:
    store = ContentConsentStore(tmp_path / "grants")
    app = BridgeApplication(_GrantService(), store)

    result = app.dispatch(
        {
            "method": "grant_cloud_access",
            "expected_server_id": SERVER_ID,
            "params": {
                "item_key": PARENT_KEY,
                "attachment_key": PUBLIC_PDF,
                "confirmed_public": True,
                "include_notes": True,
            },
        }
    )

    assert isinstance(result, PublicContentGrant)
    assert result.include_notes is True
    assert store.allows(PARENT_KEY, server_id=SERVER_ID, notes=True)
    assert not store.allows(PRIVATE_PDF, server_id=SERVER_ID)


@pytest.mark.parametrize("attachment_key", [NON_PDF, FOREIGN_PDF])
def test_bridge_grant_rejects_non_pdf_or_foreign_attachment(
    tmp_path: Path, attachment_key: str
) -> None:
    app = BridgeApplication(_GrantService(), ContentConsentStore(tmp_path / "grants"))

    with pytest.raises(PrivacyViolation):
        app.dispatch(
            {
                "method": "grant_cloud_access",
                "expected_server_id": SERVER_ID,
                "params": {
                    "item_key": PARENT_KEY,
                    "attachment_key": attachment_key,
                    "confirmed_public": True,
                },
            }
        )


def test_bridge_grant_rejects_missing_attachment_key(tmp_path: Path) -> None:
    app = BridgeApplication(_GrantService(), ContentConsentStore(tmp_path / "grants"))

    with pytest.raises(ValidationError):
        app.dispatch(
            {
                "method": "grant_cloud_access",
                "expected_server_id": SERVER_ID,
                "params": {"item_key": PARENT_KEY, "confirmed_public": True},
            }
        )


@pytest.mark.parametrize(
    ("attachment_key", "expected_exception"),
    [("not-an-item-key", ValidationError), ("MISSING2", PrivacyViolation)],
)
def test_bridge_grant_rejects_invalid_or_unknown_attachment_key(
    tmp_path: Path, attachment_key: str, expected_exception: type[Exception]
) -> None:
    app = BridgeApplication(_GrantService(), ContentConsentStore(tmp_path / "grants"))

    with pytest.raises(expected_exception):
        app.dispatch(
            {
                "method": "grant_cloud_access",
                "expected_server_id": SERVER_ID,
                "params": {
                    "item_key": PARENT_KEY,
                    "attachment_key": attachment_key,
                    "confirmed_public": True,
                },
            }
        )


def test_zrm_local_environment_cannot_bypass_mcp_content(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("ZRM_MCP_CLIENT", "local")
    settings = Settings(_env_file=None, state_directory=tmp_path)
    policy = build_content_policy(settings)
    with pytest.raises(TypeError):
        MCPContentPolicy(local_client=True)  # type: ignore[call-arg]

    accessed = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal accessed
        if request.url.path == "/api/":
            return httpx.Response(
                200,
                headers={
                    "X-Zotero-Version": "10.0.1",
                    "Zotero-API-Version": "3",
                    "Zotero-Server-ID": SERVER_ID,
                },
            )
        accessed = True
        raise AssertionError(f"MCP disclosure must deny before Zotero access: {request.url}")

    server = create_mcp_server(
        service=ResearchService(zotero=ZoteroLocalClient(transport=httpx.MockTransport(handler))),
        content_policy=policy,
    )
    with pytest.raises(ToolError, match=r"本地.*授权"):
        asyncio.run(
            server.call_tool("extract_pdf", {"attachment_key": PUBLIC_PDF, "allow_cloud": True})
        )
    assert accessed is False


class _FailingMcpService:
    def __init__(self, failure: BaseException) -> None:
        self.failure = failure

    def content_server_id(self) -> str:
        return SERVER_ID

    def get_item_context(self, item_key: str) -> ItemContext:
        assert item_key == PARENT_KEY
        return _context()

    def extract_pdf(self, *_args: Any, **_kwargs: Any) -> NoReturn:
        raise self.failure

    def retrieve_evidence(self, *_args: Any, **_kwargs: Any) -> NoReturn:
        raise self.failure

    def generate_reading_card(self, *_args: Any, **_kwargs: Any) -> NoReturn:
        raise self.failure

    def analyze_paper(self, *_args: Any, **_kwargs: Any) -> NoReturn:
        raise self.failure


@pytest.mark.parametrize(
    ("tool", "arguments"),
    [
        ("extract_pdf", {"attachment_key": PUBLIC_PDF, "allow_cloud": True}),
        (
            "retrieve_evidence",
            {"attachment_key": PUBLIC_PDF, "query": "results", "allow_cloud": True},
        ),
        (
            "generate_reading_card",
            {
                "item_key": PARENT_KEY,
                "attachment_key": PUBLIC_PDF,
                "sensitivity": "public",
                "allow_cloud": True,
            },
        ),
        (
            "analyze_paper",
            {
                "item_key": PARENT_KEY,
                "attachment_key": PUBLIC_PDF,
                "allow_cloud": True,
            },
        ),
    ],
)
@pytest.mark.parametrize(
    ("failure_type", "failure_message", "safe_message"),
    [
        (FileNotFoundError, "LEAK-PDF-PATH", "本地 PDF 处理失败"),
        (RuntimeError, "LEAK-FULL-TEXT API-KEY", "本地 PDF 处理失败"),
        (Exception, "LEAK-UNKNOWN-DETAIL", "未返回原文、路径或内部错误详情"),
    ],
)
def test_mcp_pdf_failures_are_fixed_and_do_not_echo_details(
    tmp_path: Path,
    tool: str,
    arguments: dict[str, object],
    failure_type: type[BaseException],
    failure_message: str,
    safe_message: str,
) -> None:
    store = ContentConsentStore(tmp_path / "grants")
    store.grant_public(
        server_id=SERVER_ID,
        parent_item_key=PARENT_KEY,
        attachment_keys=[PUBLIC_PDF],
        confirmed_public=True,
    )
    service = _FailingMcpService(failure_type(failure_message))
    server = create_mcp_server(
        service=service,  # type: ignore[arg-type]
        content_policy=MCPContentPolicy(consents=store),
    )

    with pytest.raises(ToolError) as exc_info:
        asyncio.run(server.call_tool(tool, arguments))

    message = str(exc_info.value)
    assert failure_message not in message
    assert safe_message in message


def test_mcp_model_response_error_does_not_echo_details(tmp_path: Path) -> None:
    store = ContentConsentStore(tmp_path / "grants")
    store.grant_public(
        server_id=SERVER_ID,
        parent_item_key=PARENT_KEY,
        attachment_keys=[PUBLIC_PDF],
        confirmed_public=True,
    )
    leak = "LEAK/path/secret.pdf unknown evidence ID FULL-TEXT"
    server = create_mcp_server(
        service=_FailingMcpService(ModelResponseError(leak)),  # type: ignore[arg-type]
        content_policy=MCPContentPolicy(consents=store),
    )

    with pytest.raises(ToolError) as exc_info:
        asyncio.run(
            server.call_tool(
                "generate_reading_card",
                {
                    "item_key": PARENT_KEY,
                    "attachment_key": PUBLIC_PDF,
                    "sensitivity": "public",
                    "allow_cloud": True,
                },
            )
        )

    message = str(exc_info.value)
    assert leak not in message
    assert "模型结果缺少可靠证据或格式无效，未返回内容" in message


class _FailingBridgeService:
    def __init__(self, failure: BaseException) -> None:
        self.failure = failure
        self.write_attempts = 0

    def verify_instance(self, expected_server_id: str) -> None:
        assert expected_server_id == SERVER_ID

    def write_child_note(self, *_args: Any, **_kwargs: Any) -> NoReturn:
        self.write_attempts += 1
        raise self.failure

    def analyze_paper(self, *_args: Any, **_kwargs: Any) -> NoReturn:
        raise self.failure


@contextmanager
def _bridge_client(
    service: _FailingBridgeService, tmp_path: Path
) -> Iterator[tuple[httpx.Client, str]]:
    server = create_bridge_server(
        service=service,
        consents=ContentConsentStore(tmp_path / "grants"),  # type: ignore[arg-type]
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    info = server.startup_info()
    try:
        with httpx.Client(base_url=info["url"], trust_env=False, timeout=3) as client:
            yield client, info["token"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


@pytest.mark.parametrize(
    ("method", "params", "failure_type", "status", "code"),
    [
        (
            "write_note",
            {
                "preview_token": "t" * 20,
                "expected_digest": "0" * 64,
                "confirmed_by_user": True,
            },
            LocalWriteUnavailable,
            409,
            "local_write_unavailable",
        ),
        (
            "write_note",
            {
                "preview_token": "t" * 20,
                "expected_digest": "0" * 64,
                "confirmed_by_user": True,
            },
            LocalWriteFailed,
            422,
            "local_write_failed",
        ),
        (
            "write_note",
            {
                "preview_token": "t" * 20,
                "expected_digest": "0" * 64,
                "confirmed_by_user": True,
            },
            LocalWriteOutcomeUnknown,
            409,
            "write_outcome_unknown",
        ),
        (
            "analyze",
            {"item_key": PARENT_KEY},
            MinerUParserError,
            422,
            "mineru_processing_failed",
        ),
    ],
)
def test_bridge_maps_deterministic_failures_without_echoing_details(
    tmp_path: Path,
    method: str,
    params: dict[str, object],
    failure_type: type[BaseException],
    status: int,
    code: str,
) -> None:
    service = _FailingBridgeService(failure_type("LEAK-BRIDGE-DETAIL"))
    with _bridge_client(service, tmp_path) as (
        client,
        token,
    ):
        response = client.post(
            "/rpc",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "method": method,
                "params": params,
                "expected_server_id": SERVER_ID,
            },
        )

    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert "LEAK-BRIDGE-DETAIL" not in response.text
    assert service.write_attempts == (1 if method == "write_note" else 0)
