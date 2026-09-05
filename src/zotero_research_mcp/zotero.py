"""Zotero Local API adapter.

This module deliberately has no SQLite fallback. If Zotero's official Local API is
unavailable, callers receive an explicit failure instead of bypassing Zotero.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from contextvars import ContextVar
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

import httpx

from . import __version__
from .models import (
    ITEM_KEY_FULLMATCH,
    AttachmentSummary,
    ItemContext,
    ItemSummary,
    NoteSummary,
    SearchResults,
    ZoteroStatus,
)
from .net import is_loopback_hostname

DEFAULT_LOCAL_API_URL = "http://127.0.0.1:23119/api/"


class ZoteroInstanceMismatch(ValueError):
    """The response came from a different or unidentified Zotero instance."""


class ZoteroLocalClient:
    """Small, typed client for supported Zotero Local API operations."""

    def __init__(
        self,
        base_url: str = DEFAULT_LOCAL_API_URL,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 5.0,
    ) -> None:
        normalized_url = f"{base_url.rstrip('/')}/"
        _validate_local_api_base_url(normalized_url)
        self._client = httpx.Client(
            base_url=normalized_url,
            headers={
                "Zotero-API-Version": "3",
                "User-Agent": f"zotero-research-mcp/{__version__}",
            },
            timeout=timeout,
            transport=transport,
            trust_env=False,
        )
        self._pinned_server_id: ContextVar[str | None] = ContextVar(
            "zotero_research_instance", default=None
        )

    def close(self) -> None:
        self._client.close()

    def pin_instance(self, expected_server_id: str) -> None:
        status = self.health()
        if not expected_server_id or status.server_id != expected_server_id:
            raise ValueError("Zotero instance mismatch; reconnect from the correct local sidebar")
        self._pinned_server_id.set(expected_server_id)

    def _read_headers(self) -> dict[str, str]:
        instance = self._pinned_server_id.get()
        return {"Zotero-Server-ID": instance} if instance else {}

    def _check_response_instance(
        self,
        response: httpx.Response,
        *,
        expected_server_id: str | None = None,
    ) -> None:
        if response.status_code == 412:
            raise ZoteroInstanceMismatch(
                "Zotero instance mismatch; reconnect from the correct local sidebar"
            )
        expected = expected_server_id or self._pinned_server_id.get()
        if expected is not None and response.headers.get("Zotero-Server-ID") != expected:
            raise ZoteroInstanceMismatch(
                "Zotero instance mismatch; reconnect from the correct local sidebar"
            )

    def health(self) -> ZoteroStatus:
        try:
            response = self._client.get("")
            response.raise_for_status()
        except httpx.HTTPError as exc:
            return ZoteroStatus(reachable=False, detail=str(exc))

        version = response.headers.get("X-Zotero-Version")
        api_version = _parse_int_header(response.headers, "Zotero-API-Version")
        schema_version = _parse_int_header(response.headers, "Zotero-Schema-Version")
        server_id = response.headers.get("Zotero-Server-ID")
        return ZoteroStatus(
            reachable=True,
            version=version,
            api_version=api_version,
            schema_version=schema_version,
            server_id=server_id,
            read_supported=api_version == 3,
            detail=None if api_version == 3 else "Only Zotero Local API v3 is supported.",
        )

    def search_items(self, query: str, *, limit: int = 20) -> SearchResults:
        if not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")

        response = self._client.get(
            "users/0/items/top",
            headers=self._read_headers(),
            params={"q": query, "limit": limit, "format": "json"},
        )
        self._check_response_instance(response)
        response.raise_for_status()
        payload = _require_json_list(response)
        items = [_parse_item_summary(raw) for raw in payload]
        total = _parse_int_header(response.headers, "Total-Results")
        return SearchResults(total=total if total is not None else len(items), items=items)

    def get_item_context(self, item_key: str) -> ItemContext:
        _validate_item_key(item_key)
        item_response = self._client.get(f"users/0/items/{item_key}", headers=self._read_headers())
        self._check_response_instance(item_response)
        item_response.raise_for_status()
        raw_item = _require_json_object(item_response)

        children_response = self._client.get(
            f"users/0/items/{item_key}/children", headers=self._read_headers()
        )
        self._check_response_instance(children_response)
        children_response.raise_for_status()
        raw_children = _require_json_list(children_response)

        attachments: list[AttachmentSummary] = []
        notes: list[NoteSummary] = []
        for raw_child in raw_children:
            data = _item_data(raw_child)
            item_type = str(data.get("itemType", ""))
            if item_type == "attachment":
                attachments.append(
                    AttachmentSummary(
                        key=_item_key(raw_child, data),
                        version=_item_version(raw_child, data),
                        title=str(data.get("title", "")),
                        content_type=str(data.get("contentType", "")),
                        filename=str(data.get("filename", "")),
                        link_mode=str(data.get("linkMode", "")),
                        parent_item=str(data.get("parentItem", item_key)),
                    )
                )
            elif item_type == "note":
                notes.append(
                    NoteSummary(
                        key=_item_key(raw_child, data),
                        version=_item_version(raw_child, data),
                        html=str(data.get("note", "")),
                        parent_item=str(data.get("parentItem", item_key)),
                    )
                )

        return ItemContext(
            item=_parse_item_summary(raw_item),
            attachments=attachments,
            notes=notes,
        )

    def get_attachment_path(self, attachment_key: str) -> Path:
        """Resolve an attachment through Zotero without scanning its data directory."""

        _validate_item_key(attachment_key)
        response = self._client.get(
            f"users/0/items/{attachment_key}/file/view/url",
            headers={**self._read_headers(), "Accept": "text/plain"},
        )
        self._check_response_instance(response)
        response.raise_for_status()
        location = response.text.strip()
        if not location:
            raise ValueError("Zotero returned an empty attachment location")

        parsed = urlparse(location)
        if parsed.scheme and parsed.scheme.lower() != "file":
            raise ValueError("Zotero attachment location must use the file scheme")
        if parsed.scheme.lower() == "file":
            raw_path = unquote(parsed.path)
            if os.name == "nt" and re.match(r"^/[A-Za-z]:/", raw_path):
                raw_path = raw_path[1:]
            if parsed.netloc and parsed.netloc.lower() != "localhost":
                raw_path = f"//{parsed.netloc}{raw_path}"
            path = Path(url2pathname(raw_path))
        else:
            path = Path(location)

        if not path.is_absolute():
            raise ValueError("Zotero returned a non-absolute attachment path")
        if path.suffix.casefold() != ".pdf":
            raise ValueError("Only PDF attachments can be read by research tools")
        if str(path).startswith(("\\\\", "//")):
            raise ValueError("Network-share attachments are not allowed in local-only processing")
        return path

def _parse_item_summary(raw: Mapping[str, Any]) -> ItemSummary:
    data = _item_data(raw)
    creators = [_creator_name(creator) for creator in data.get("creators", [])]
    return ItemSummary(
        key=_item_key(raw, data),
        version=_item_version(raw, data),
        item_type=str(data.get("itemType", "")),
        title=str(data.get("title", "")),
        date=str(data.get("date", "")),
        creators=[name for name in creators if name],
        url=str(data.get("url", "")),
    )


def _creator_name(creator: object) -> str:
    if not isinstance(creator, Mapping):
        return ""
    single_name = str(creator.get("name", "")).strip()
    if single_name:
        return single_name
    return " ".join(
        part
        for part in (
            str(creator.get("firstName", "")).strip(),
            str(creator.get("lastName", "")).strip(),
        )
        if part
    )


def _item_data(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    data = raw.get("data", raw)
    if not isinstance(data, Mapping):
        raise ValueError("Zotero item data must be a JSON object")
    return data


def _item_key(raw: Mapping[str, Any], data: Mapping[str, Any]) -> str:
    key = str(raw.get("key") or data.get("key") or "")
    if not key:
        raise ValueError("Zotero item is missing a key")
    return key


def _item_version(raw: Mapping[str, Any], data: Mapping[str, Any]) -> int:
    version = raw.get("version", data.get("version", 0))
    return int(version) if version is not None else 0


def _require_json_object(response: httpx.Response) -> Mapping[str, Any]:
    payload = response.json()
    if not isinstance(payload, Mapping):
        raise ValueError("Expected a JSON object from Zotero")
    return payload


def _require_json_list(response: httpx.Response) -> list[Mapping[str, Any]]:
    payload = response.json()
    if not isinstance(payload, list) or any(not isinstance(item, Mapping) for item in payload):
        raise ValueError("Expected a JSON array of objects from Zotero")
    return payload


def _parse_int_header(headers: httpx.Headers, name: str) -> int | None:
    value = headers.get(name)
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _validate_item_key(item_key: str) -> None:
    if not ITEM_KEY_FULLMATCH.fullmatch(item_key):
        raise ValueError("item_key must be an 8-character Zotero key")


def _validate_local_api_base_url(base_url: str) -> None:
    parsed = urlparse(base_url)
    hostname = parsed.hostname
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Zotero Local API URL cannot contain credentials, query or fragment")
    is_loopback = is_loopback_hostname(hostname)
    if parsed.scheme.casefold() != "http" or not is_loopback:
        raise ValueError("Zotero Local API URL must use HTTP on a loopback address")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Zotero Local API URL must use an explicit valid local port") from exc
    if port is None or not 1 <= port <= 65535:
        raise ValueError("Zotero Local API URL must use an explicit valid local port")
    if parsed.path.rstrip("/") != "/api":
        raise ValueError("Zotero Local API URL must end with /api/")
