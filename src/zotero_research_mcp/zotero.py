"""Zotero Local API adapter.

This module deliberately has no SQLite fallback. If Zotero's official Local API is
unavailable, callers receive an explicit failure instead of bypassing Zotero.
"""

from __future__ import annotations

import ipaddress
import os
import re
import secrets
from collections.abc import Mapping
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

import httpx

from .models import (
    AttachmentSummary,
    ItemContext,
    ItemSummary,
    NoteSummary,
    SearchResults,
    WriteAuthorization,
    ZoteroStatus,
)

DEFAULT_LOCAL_API_URL = "http://127.0.0.1:23119/api/"


class LocalWriteUnavailable(RuntimeError):
    """The running Zotero release has no supported Local API write path."""


class LocalWriteAuthorizationRequired(PermissionError):
    """The user must approve Zotero's native authorization dialog."""


class LocalWriteFailed(RuntimeError):
    """Zotero accepted the request but did not create the requested object."""


class LocalWriteOutcomeUnknown(RuntimeError):
    """A write may have reached Zotero, so replaying it is unsafe."""


class ZoteroInstanceMismatch(ValueError):
    """The response came from a different or unidentified Zotero instance."""


@dataclass(frozen=True, slots=True)
class CreatedItem:
    key: str
    version: int


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
                "User-Agent": "zotero-research-mcp/0.2.0",
            },
            timeout=timeout,
            transport=transport,
            trust_env=False,
        )
        self._write_key: str | None = None
        self._write_server_id: str | None = None
        self._write_key_remembered = False
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
        major_version = _parse_major_version(version)
        write_supported = (
            api_version == 3
            and major_version is not None
            and major_version >= 10
            and bool(server_id)
        )
        return ZoteroStatus(
            reachable=True,
            version=version,
            api_version=api_version,
            schema_version=schema_version,
            server_id=server_id,
            read_supported=api_version == 3,
            write_supported=write_supported,
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

    def request_write_authorization(
        self,
        *,
        app_name: str = "Zotero Research MCP",
    ) -> WriteAuthorization:
        """Ask Zotero 10+ to show its native local-write approval dialog."""

        status = self.health()
        if not status.write_supported or status.server_id is None:
            raise LocalWriteUnavailable("Official Local API writes require Zotero 10 or newer.")
        if self._pinned_server_id.get() and status.server_id != self._pinned_server_id.get():
            raise LocalWriteUnavailable("Zotero instance changed; reconnect before authorizing")
        response = self._client.post(
            "local/authorize",
            headers={"Zotero-Server-ID": status.server_id},
            json={"appName": app_name},
            timeout=120.0,
        )
        self._check_response_instance(response, expected_server_id=status.server_id)
        if response.status_code == 403:
            return WriteAuthorization(
                authorized=False,
                remembered=False,
                server_id=status.server_id,
                detail="The Zotero write authorization request was denied.",
            )
        response.raise_for_status()
        payload = _require_json_object(response)
        key = payload.get("key")
        if not isinstance(key, str) or len(key) != 32:
            raise LocalWriteFailed("Zotero returned an invalid local API key")
        remembered = bool(payload.get("remember", False))
        self._write_key = key
        self._write_server_id = status.server_id
        self._write_key_remembered = remembered
        return WriteAuthorization(
            authorized=True,
            remembered=remembered,
            server_id=status.server_id,
            detail=(
                "Zotero granted remembered local write access."
                if remembered
                else "Zotero granted one-time local write access."
            ),
        )

    def create_child_note(
        self,
        payload: Mapping[str, Any],
        *,
        write_token: str | None = None,
    ) -> CreatedItem:
        """Create one child note through the authorized Zotero 10+ Local API."""

        status = self.health()
        if not status.write_supported or status.server_id is None:
            raise LocalWriteUnavailable("Official Local API writes require Zotero 10 or newer.")
        if self._pinned_server_id.get() and status.server_id != self._pinned_server_id.get():
            raise LocalWriteUnavailable("Zotero instance changed; reconnect before writing")
        if self._write_server_id != status.server_id:
            self._clear_write_authorization()
            raise LocalWriteAuthorizationRequired(
                "Zotero instance changed; request write authorization again."
            )
        if self._write_key is None:
            raise LocalWriteAuthorizationRequired(
                "Call request_write_authorization before writing a note."
            )

        idempotency_token = write_token or secrets.token_hex(16)
        if not re.fullmatch(r"[0-9a-f]{32}", idempotency_token):
            raise ValueError("write_token must be 32 lowercase hexadecimal characters")
        key = self._write_key
        remembered = self._write_key_remembered
        try:
            try:
                response = self._client.post(
                    "users/0/items",
                    headers={
                        "Zotero-Server-ID": status.server_id,
                        "Zotero-API-Key": key,
                        "Zotero-Write-Token": idempotency_token,
                    },
                    json=[dict(payload)],
                )
            except httpx.HTTPError as exc:
                raise LocalWriteOutcomeUnknown(
                    "The Zotero write outcome is unknown; regenerate a preview after checking "
                    "the library."
                ) from exc
            try:
                self._check_response_instance(response, expected_server_id=status.server_id)
            except ZoteroInstanceMismatch as exc:
                raise LocalWriteOutcomeUnknown(
                    "The Zotero write outcome is unknown; regenerate a preview after checking "
                    "the library."
                ) from exc
        finally:
            if not remembered:
                self._clear_write_authorization()

        if response.status_code == 401:
            self._clear_write_authorization()
            raise LocalWriteAuthorizationRequired(
                "Zotero local write authorization expired; authorize again."
            )
        if response.status_code >= 500:
            raise LocalWriteOutcomeUnknown(
                "Zotero returned a server error after receiving the write; check the library "
                "before creating another preview."
            )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise LocalWriteFailed(
                f"Zotero rejected the child note request with HTTP {response.status_code}"
            ) from exc
        try:
            result = _require_json_object(response)
        except ValueError as exc:
            raise LocalWriteOutcomeUnknown(
                "Zotero returned an unreadable success response; check the library before "
                "creating another preview."
            ) from exc
        failed = result.get("failed", {})
        if isinstance(failed, Mapping) and failed:
            raise LocalWriteFailed("Zotero rejected the child note payload")
        successful = result.get("successful")
        if not isinstance(successful, Mapping):
            raise LocalWriteOutcomeUnknown(
                "Zotero response did not identify the created item; check the library before "
                "creating another preview."
            )
        created = successful.get("0")
        if not isinstance(created, Mapping):
            raise LocalWriteOutcomeUnknown(
                "Zotero response did not identify the created child note; check the library "
                "before creating another preview."
            )
        try:
            data = _item_data(created)
            return CreatedItem(
                key=_item_key(created, data),
                version=_item_version(created, data),
            )
        except (TypeError, ValueError) as exc:
            raise LocalWriteOutcomeUnknown(
                "Zotero created an item but returned incomplete metadata; check the library "
                "before creating another preview."
            ) from exc

    def _clear_write_authorization(self) -> None:
        self._write_key = None
        self._write_server_id = None
        self._write_key_remembered = False


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
        doi=str(data.get("DOI", "")),
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


def _parse_major_version(version: str | None) -> int | None:
    if not version:
        return None
    match = re.match(r"(\d+)", version)
    return int(match.group(1)) if match else None


def _validate_item_key(item_key: str) -> None:
    if not re.fullmatch(r"[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}", item_key):
        raise ValueError("item_key must be an 8-character Zotero key")


def _validate_local_api_base_url(base_url: str) -> None:
    parsed = urlparse(base_url)
    hostname = parsed.hostname
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Zotero Local API URL cannot contain credentials, query or fragment")
    is_loopback = hostname is not None and hostname.casefold() == "localhost"
    if hostname is not None and not is_loopback:
        try:
            is_loopback = ipaddress.ip_address(hostname).is_loopback
        except ValueError:
            is_loopback = False
    if parsed.scheme.casefold() != "http" or not is_loopback:
        raise ValueError("Zotero Local API URL must use HTTP on a loopback address")
    if parsed.port != 23119:
        raise ValueError("Zotero Local API URL must use port 23119")
    if parsed.path.rstrip("/") != "/api":
        raise ValueError("Zotero Local API URL must end with /api/")
