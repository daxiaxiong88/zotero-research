from __future__ import annotations

from contextvars import copy_context

import httpx
import pytest

from zotero_research_mcp.zotero import (
    LocalWriteAuthorizationRequired,
    LocalWriteOutcomeUnknown,
    ZoteroLocalClient,
)

INSTANCE_A = "instance-a"
INSTANCE_B = "instance-b"


def _health_response(server_id: str | None) -> httpx.Response:
    headers = {
        "X-Zotero-Version": "10.0.1",
        "Zotero-API-Version": "3",
    }
    if server_id is not None:
        headers["Zotero-Server-ID"] = server_id
    return httpx.Response(200, headers=headers)


def _item_response(server_id: str | None, *, body: object | None = None) -> httpx.Response:
    headers = {"Zotero-Server-ID": server_id} if server_id is not None else {}
    return httpx.Response(
        200,
        headers=headers,
        json=body
        if body is not None
        else {
            "key": "PARENT23",
            "data": {"itemType": "journalArticle", "title": "Paper"},
        },
    )


def _children_response(server_id: str | None, *, body: object | None = None) -> httpx.Response:
    headers = {"Zotero-Server-ID": server_id} if server_id is not None else {}
    return httpx.Response(200, headers=headers, json=[] if body is None else body)


def test_explicit_loopback_api_port_is_allowed() -> None:
    client = ZoteroLocalClient(base_url="http://127.0.0.1:23120/api/")
    client.close()


def test_remote_api_host_is_rejected_even_on_explicit_port() -> None:
    with pytest.raises(ValueError, match="loopback"):
        ZoteroLocalClient(base_url="http://example.test:23120/api/")


def test_pinned_item_response_missing_id_is_rejected_before_body() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/api/":
            return _health_response(INSTANCE_A)
        if request.url.path == "/api/users/0/items/PARENT23":
            return httpx.Response(200, text="SECRET item body")
        raise AssertionError(f"unexpected request: {request.url}")

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    client.pin_instance(INSTANCE_A)

    with pytest.raises(ValueError, match="instance") as exc_info:
        client.get_item_context("PARENT23")

    assert "SECRET" not in str(exc_info.value)
    assert calls == ["/api/", "/api/users/0/items/PARENT23"]


@pytest.mark.parametrize("server_id", [None, INSTANCE_B])
def test_pinned_children_response_missing_or_different_id_is_rejected_before_body(
    server_id: str | None,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/":
            return _health_response(INSTANCE_A)
        if request.url.path == "/api/users/0/items/PARENT23":
            return _item_response(INSTANCE_A)
        if request.url.path.endswith("/children"):
            headers = {"Zotero-Server-ID": server_id} if server_id is not None else {}
            return httpx.Response(200, headers=headers, text="SECRET children body")
        raise AssertionError(f"unexpected request: {request.url}")

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    client.pin_instance(INSTANCE_A)

    with pytest.raises(ValueError, match="instance") as exc_info:
        client.get_item_context("PARENT23")

    assert "SECRET" not in str(exc_info.value)


@pytest.mark.parametrize("server_id", [None, INSTANCE_B])
def test_pinned_search_response_missing_or_different_id_is_rejected_before_body(
    server_id: str | None,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/":
            return _health_response(INSTANCE_A)
        if request.url.path.endswith("/items/top"):
            headers = {"Zotero-Server-ID": server_id} if server_id is not None else {}
            return httpx.Response(200, headers=headers, text="SECRET search body")
        raise AssertionError(f"unexpected request: {request.url}")

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    client.pin_instance(INSTANCE_A)

    with pytest.raises(ValueError, match="instance") as exc_info:
        client.search_items("query")

    assert "SECRET" not in str(exc_info.value)


@pytest.mark.parametrize("server_id", [None, INSTANCE_B])
def test_pinned_attachment_response_missing_or_different_id_is_rejected_before_body(
    server_id: str | None,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/":
            return _health_response(INSTANCE_A)
        if request.url.path.endswith("/file/view/url"):
            headers = {"Zotero-Server-ID": server_id} if server_id is not None else {}
            return httpx.Response(200, headers=headers, text="SECRET attachment body")
        raise AssertionError(f"unexpected request: {request.url}")

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    client.pin_instance(INSTANCE_A)

    with pytest.raises(ValueError, match="instance") as exc_info:
        client.get_attachment_path("ATTACH23")

    assert "SECRET" not in str(exc_info.value)


def test_read_http_412_is_instance_mismatch_without_body_echo() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/items/top"):
            return httpx.Response(
                412,
                headers={"Zotero-Server-ID": INSTANCE_A},
                text="SECRET precondition body",
            )
        raise AssertionError(f"unexpected request: {request.url}")

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    with pytest.raises(ValueError, match="instance") as exc_info:
        client.search_items("query")

    assert "SECRET" not in str(exc_info.value)


def test_health_ignores_stale_pin_and_repin_can_follow_current_instance() -> None:
    health_ids = iter([INSTANCE_A, INSTANCE_B, INSTANCE_B])
    seen_headers: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path != "/api/":
            raise AssertionError(f"unexpected request: {request.url}")
        seen_headers.append(request.headers.get("Zotero-Server-ID"))
        return _health_response(next(health_ids))

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    client.pin_instance(INSTANCE_A)
    assert client.health().server_id == INSTANCE_B
    client.pin_instance(INSTANCE_B)

    assert seen_headers == [None, None, None]


def test_pinned_contexts_are_isolated_for_read_headers() -> None:
    health_ids = iter([INSTANCE_A, INSTANCE_B])
    seen_search_ids: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/":
            return _health_response(next(health_ids))
        if request.url.path.endswith("/items/top"):
            server_id = request.url.params["q"]
            seen_search_ids.append(request.headers.get("Zotero-Server-ID"))
            return httpx.Response(
                200,
                headers={"Zotero-Server-ID": server_id},
                json=[],
            )
        raise AssertionError(f"unexpected request: {request.url}")

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    context_a = copy_context()
    context_b = copy_context()
    context_a.run(lambda: client.pin_instance(INSTANCE_A))
    context_b.run(lambda: client.pin_instance(INSTANCE_B))

    result_a = context_a.run(lambda: client.search_items(INSTANCE_A))
    result_b = context_b.run(lambda: client.search_items(INSTANCE_B))

    assert result_a.items == []
    assert result_b.items == []
    assert seen_search_ids == [INSTANCE_A, INSTANCE_B]


@pytest.mark.parametrize("response_id", [None, INSTANCE_B])
def test_authorization_response_id_mismatch_is_rejected_before_key_body(
    response_id: str | None,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/":
            return _health_response(INSTANCE_A)
        if request.url.path == "/api/local/authorize":
            headers = {"Zotero-Server-ID": response_id} if response_id is not None else {}
            return httpx.Response(
                200,
                headers=headers,
                json={"key": "SECRET-KEY", "remember": True},
            )
        raise AssertionError(f"unexpected request: {request.url}")

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    client.pin_instance(INSTANCE_A)

    with pytest.raises(ValueError, match="instance") as exc_info:
        client.request_write_authorization()

    assert "SECRET" not in str(exc_info.value)


@pytest.mark.parametrize("response_id", [None, INSTANCE_B])
def test_write_response_id_mismatch_is_unknown_and_not_replayed(
    response_id: str | None,
) -> None:
    write_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal write_calls
        if request.url.path == "/api/":
            return _health_response(INSTANCE_A)
        if request.url.path == "/api/local/authorize":
            return httpx.Response(
                200,
                headers={"Zotero-Server-ID": INSTANCE_A},
                json={"key": "K" * 32, "remember": False},
            )
        if request.method == "POST" and request.url.path == "/api/users/0/items":
            write_calls += 1
            headers = {"Zotero-Server-ID": response_id} if response_id is not None else {}
            return httpx.Response(
                200,
                headers=headers,
                json={"successful": {"0": {"key": "SECRET-NOTE", "version": 1}}},
            )
        raise AssertionError(f"unexpected request: {request.url}")

    client = ZoteroLocalClient(transport=httpx.MockTransport(handler))
    client.pin_instance(INSTANCE_A)
    client.request_write_authorization()

    with pytest.raises(LocalWriteOutcomeUnknown) as exc_info:
        client.create_child_note(
            {"itemType": "note", "parentItem": "PARENT23", "note": "body"},
            write_token="a" * 32,
        )

    assert "SECRET" not in str(exc_info.value)
    assert write_calls == 1

    with pytest.raises(LocalWriteAuthorizationRequired):
        client.create_child_note(
            {"itemType": "note", "parentItem": "PARENT23", "note": "body"},
            write_token="b" * 32,
        )
    assert write_calls == 1
