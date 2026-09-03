"""Preview-first note rendering and one-time write claims."""

from __future__ import annotations

import copy
import hashlib
import hmac
import html
import json
import re
import secrets
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from .models import NotePreview


class NotePreviewError(RuntimeError):
    """Base error for invalid preview lifecycle operations."""


class PreviewNotFound(NotePreviewError):
    """The preview token is unknown to this server process."""


class PreviewExpired(NotePreviewError):
    """The preview must be regenerated because its TTL elapsed."""


class PreviewMismatch(NotePreviewError):
    """The caller did not confirm the exact previewed content digest."""


class PreviewAlreadyUsed(NotePreviewError):
    """A one-time preview was already committed or is being committed."""


class WriteConfirmationRequired(NotePreviewError):
    """The write call did not attest explicit user confirmation."""


@dataclass(slots=True)
class _PendingNote:
    preview_token: str
    digest: str
    server_id: str | None
    parent_item_key: str
    title: str
    note_html: str
    tags: list[str]
    payload: dict[str, Any]
    write_token: str
    expires_at: datetime
    state: Literal["pending", "in_progress", "consumed"] = "pending"


@dataclass(frozen=True, slots=True)
class NoteWriteClaim:
    """Immutable copy of the exact payload claimed for one write attempt."""

    preview_token: str
    digest: str
    server_id: str | None
    parent_item_key: str
    payload: dict[str, Any]
    write_token: str


class NotePreviewStore:
    """In-memory, lock-protected store; previews intentionally die on restart."""

    def __init__(
        self,
        *,
        ttl: timedelta = timedelta(minutes=10),
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if ttl <= timedelta(0):
            raise ValueError("preview TTL must be positive")
        self._ttl = ttl
        self._clock = clock or (lambda: datetime.now(UTC))
        self._pending: dict[str, _PendingNote] = {}
        self._lock = threading.Lock()

    def create(
        self,
        *,
        parent_item_key: str,
        title: str,
        content: str,
        tags: list[str] | None = None,
        server_id: str | None = None,
    ) -> NotePreview:
        clean_title = title.strip()
        clean_content = content.strip()
        if not clean_title:
            raise ValueError("title must not be empty")
        if len(clean_title) > 500:
            raise ValueError("title must not exceed 500 characters")
        if not clean_content:
            raise ValueError("content must not be empty")
        if len(clean_content) > 100_000:
            raise ValueError("content must not exceed 100000 characters")

        normalized_tags = _normalize_tags(tags)
        note_html = _render_safe_note_html(clean_title, clean_content)
        payload: dict[str, Any] = {
            "itemType": "note",
            "parentItem": parent_item_key,
            "note": note_html,
            "tags": [{"tag": tag} for tag in normalized_tags],
        }
        digest = _payload_digest({"server_id": server_id, "payload": payload})
        preview_token = secrets.token_urlsafe(32)
        expires_at = self._now() + self._ttl
        pending = _PendingNote(
            preview_token=preview_token,
            digest=digest,
            server_id=server_id,
            parent_item_key=parent_item_key,
            title=clean_title,
            note_html=note_html,
            tags=normalized_tags,
            payload=payload,
            write_token=secrets.token_hex(16),
            expires_at=expires_at,
        )
        with self._lock:
            self._purge_expired_locked()
            self._pending[preview_token] = pending
        return NotePreview(
            preview_token=preview_token,
            digest=digest,
            server_id=server_id,
            parent_item_key=parent_item_key,
            title=clean_title,
            note_html=note_html,
            note_text=f"{clean_title}\n\n{clean_content}",
            tags=normalized_tags,
            expires_at=expires_at,
        )

    def claim(
        self,
        preview_token: str,
        *,
        expected_digest: str,
        confirmed_by_user: bool,
    ) -> NoteWriteClaim:
        with self._lock:
            pending = self._pending.get(preview_token)
            if pending is None:
                raise PreviewNotFound("Preview token is unknown or expired")
            if pending.expires_at <= self._now():
                del self._pending[preview_token]
                raise PreviewExpired("Preview token has expired")
            if pending.state != "pending":
                raise PreviewAlreadyUsed("Preview is already used or being written")
            if confirmed_by_user is not True:
                raise WriteConfirmationRequired(
                    "write_child_note requires explicit user confirmation"
                )
            if not hmac.compare_digest(pending.digest, expected_digest):
                raise PreviewMismatch("Expected digest does not match the preview")
            pending.state = "in_progress"
            return NoteWriteClaim(
                preview_token=pending.preview_token,
                digest=pending.digest,
                server_id=pending.server_id,
                parent_item_key=pending.parent_item_key,
                payload=copy.deepcopy(pending.payload),
                write_token=pending.write_token,
            )

    def release(self, preview_token: str) -> None:
        with self._lock:
            pending = self._pending.get(preview_token)
            if pending is not None and pending.state == "in_progress":
                pending.state = "pending"

    def consume(self, preview_token: str) -> None:
        with self._lock:
            pending = self._pending.get(preview_token)
            if pending is None or pending.state != "in_progress":
                raise PreviewAlreadyUsed("Preview is not in a writable state")
            pending.state = "consumed"

    def _now(self) -> datetime:
        current = self._clock()
        if current.tzinfo is None:
            raise ValueError("preview clock must return a timezone-aware datetime")
        return current

    def _purge_expired_locked(self) -> None:
        now = self._now()
        expired = [token for token, pending in self._pending.items() if pending.expires_at <= now]
        for token in expired:
            del self._pending[token]


def _render_safe_note_html(title: str, content: str) -> str:
    escaped_title = html.escape(title, quote=True)
    paragraphs = re.split(r"\n\s*\n", content)
    rendered_paragraphs = []
    for paragraph in paragraphs:
        escaped_lines = [html.escape(line, quote=True) for line in paragraph.splitlines()]
        rendered_paragraphs.append(f"<p>{'<br/>'.join(escaped_lines)}</p>")
    return f"<h1>{escaped_title}</h1>{''.join(rendered_paragraphs)}"


def _normalize_tags(tags: list[str] | None) -> list[str]:
    normalized: list[str] = []
    for raw_tag in [*(tags or []), "zotero-research-mcp"]:
        tag = raw_tag.strip()
        if not tag:
            continue
        if len(tag) > 255:
            raise ValueError("tags must not exceed 255 characters")
        if tag not in normalized:
            normalized.append(tag)
    if len(normalized) > 20:
        raise ValueError("at most 20 tags are allowed")
    return normalized


def _payload_digest(payload: dict[str, Any]) -> str:
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()
