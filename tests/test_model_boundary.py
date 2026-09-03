from __future__ import annotations

import httpx
import pytest

from zotero_research_mcp.model import OpenAICompatibleModelClient


def test_remote_endpoint_cannot_be_declared_local() -> None:
    with pytest.raises(ValueError, match="loopback"):
        OpenAICompatibleModelClient(
            base_url="https://external.example/v1", model="test", is_local=True
        )


def test_local_model_request_is_bounded_and_does_not_follow_redirects() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(302, headers={"Location": "https://external.example/v1"})

    model = OpenAICompatibleModelClient(
        base_url="http://localhost:11434/v1",
        model="test",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(httpx.HTTPStatusError):
        model.complete_json("synthetic input")
    assert len(requests) == 1
    assert requests[0].url.host == "127.0.0.1"
    model.close()
