from __future__ import annotations

import threading
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from zotero_research_mcp.bridge import create_bridge_server
from zotero_research_mcp.disclosure import ContentConsentStore
from zotero_research_mcp.service import ResearchService
from zotero_research_mcp.zotero import ZoteroLocalClient


@pytest.fixture
def bridge_client(tmp_path: Path) -> Iterator[tuple[httpx.Client, str]]:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/":
            return httpx.Response(
                200,
                headers={
                    "X-Zotero-Version": "10.0.1",
                    "Zotero-API-Version": "3",
                    "Zotero-Server-ID": "synthetic-instance",
                },
            )
        raise AssertionError("Unexpected access to document content")

    service = ResearchService(zotero=ZoteroLocalClient(transport=httpx.MockTransport(handler)))
    server = create_bridge_server(
        service=service, consents=ContentConsentStore(tmp_path / "grants")
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
        service.close()


def test_private_bridge_rejects_unauthenticated_and_browser_origin_requests(
    bridge_client: tuple[httpx.Client, str],
) -> None:
    client, token = bridge_client
    assert client.post("/rpc", json={"method": "health"}).status_code == 401
    response = client.post(
        "/rpc",
        json={"method": "health"},
        headers={"Authorization": f"Bearer {token}", "Origin": "https://hostile.example"},
    )
    assert response.status_code == 403
    assert "Access-Control-Allow-Origin" not in response.headers


def test_private_bridge_health_works_but_mismatched_library_is_rejected(
    bridge_client: tuple[httpx.Client, str],
) -> None:
    client, token = bridge_client
    headers = {"Authorization": f"Bearer {token}"}
    response = client.post("/rpc", headers=headers, json={"method": "health"})
    assert response.json()["result"]["zotero"]["version"] == "10.0.1"
    response = client.post(
        "/rpc",
        headers=headers,
        json={
            "method": "item_context",
            "params": {"item_key": "PARENT23"},
            "expected_server_id": "wrong-instance",
        },
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "instance_mismatch"
