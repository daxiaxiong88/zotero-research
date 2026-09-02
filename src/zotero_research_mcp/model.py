"""Model adapter contracts and an optional OpenAI-compatible implementation."""

from __future__ import annotations

import ipaddress
import json
from collections.abc import Mapping
from typing import Any, Protocol
from urllib.parse import urlparse

import httpx


class ModelClient(Protocol):
    """Minimal model seam used by the reading-card generator."""

    name: str
    is_local: bool

    def complete_json(self, prompt: str) -> Mapping[str, Any]:
        """Return one JSON object for the supplied grounded prompt."""


class ModelResponseError(RuntimeError):
    """Raised when a model endpoint returns unusable structured output."""


class OpenAICompatibleModelClient:
    """Call a local Ollama/vLLM or explicitly opted-in compatible endpoint."""

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key: str | None = None,
        is_local: bool | None = None,
        timeout: float = 120.0,
    ) -> None:
        self.name = model
        self.is_local = _is_loopback_url(base_url) if is_local is None else is_local
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._client = httpx.Client(
            base_url=f"{base_url.rstrip('/')}/",
            headers=headers,
            timeout=timeout,
            trust_env=not self.is_local,
        )
        self._model = model

    def complete_json(self, prompt: str) -> Mapping[str, Any]:
        response = self._client.post(
            "chat/completions",
            json={
                "model": self._model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Return one JSON object only. Use only the supplied evidence IDs; "
                            "never invent evidence or bibliographic facts."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0,
                "response_format": {"type": "json_object"},
            },
        )
        response.raise_for_status()
        payload = response.json()
        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ModelResponseError("Model response is missing message content") from exc
        if isinstance(content, Mapping):
            return content
        if not isinstance(content, str):
            raise ModelResponseError("Model message content is not JSON text")
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ModelResponseError("Model did not return valid JSON") from exc
        if not isinstance(parsed, Mapping):
            raise ModelResponseError("Model JSON response must be an object")
        return parsed


def _is_loopback_url(url: str) -> bool:
    hostname = urlparse(url).hostname
    if hostname is None:
        return False
    if hostname.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False
