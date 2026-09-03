"""The MCP response boundary is an independent content-disclosure boundary."""

from __future__ import annotations

import hashlib
import os
import tempfile
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .privacy import PrivacyViolation


class PublicContentGrant(BaseModel):
    """A local UI receipt, never something an MCP tool can mint."""

    model_config = ConfigDict(extra="forbid")
    server_id: str = Field(min_length=1, max_length=128)
    parent_item_key: str = Field(pattern=r"^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$")
    attachment_keys: list[str] = Field(max_length=100)
    include_notes: bool = False
    issued_at: datetime
    expires_at: datetime

    @model_validator(mode="after")
    def validate_receipt(self) -> PublicContentGrant:
        import re

        if any(
            not re.fullmatch(r"[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}", key)
            for key in self.attachment_keys
        ):
            raise ValueError("Invalid attachment key in consent")
        if self.issued_at.tzinfo is None or self.expires_at.tzinfo is None:
            raise ValueError("Consent timestamps must have timezones")
        if not timedelta(0) < self.expires_at - self.issued_at <= timedelta(minutes=10):
            raise ValueError("Consent must expire within 10 minutes")
        return self


class ContentConsentStore:
    """Short-lived, per-paper local receipts shared by the bridge and MCP process.

    This protects this application's tool boundary, not against another process
    with the same OS user's filesystem privileges. No document text is stored.
    """

    def __init__(self, directory: Path, *, clock: Callable[[], datetime] | None = None) -> None:
        self.directory = directory
        self._clock = clock or (lambda: datetime.now(UTC))

    def grant_public(
        self,
        *,
        server_id: str,
        parent_item_key: str,
        attachment_keys: list[str],
        confirmed_public: bool,
        include_notes: bool = False,
    ) -> PublicContentGrant:
        if not confirmed_public:
            raise PrivacyViolation("必须在本地界面确认这篇论文公开并允许内容进入云端。")
        now = self._clock()
        receipt = PublicContentGrant(
            server_id=server_id,
            parent_item_key=parent_item_key,
            attachment_keys=attachment_keys,
            include_notes=include_notes,
            issued_at=now,
            expires_at=now + timedelta(minutes=10),
        )
        self.directory.mkdir(parents=True, exist_ok=True)
        target = self._receipt_path(server_id, parent_item_key)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.directory, suffix=".tmp", delete=False
            ) as output:
                temporary = Path(output.name)
                output.write(receipt.model_dump_json())
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return receipt

    def revoke(self, *, server_id: str, parent_item_key: str) -> None:
        self._receipt_path(server_id, parent_item_key).unlink(missing_ok=True)

    def allows(self, subject_key: str, *, server_id: str, notes: bool = False) -> bool:
        now = self._clock()
        try:
            candidates = list(self.directory.glob("*.json"))
        except OSError:
            return False
        if len(candidates) > 1000:
            return False
        for path in candidates:
            try:
                if path.stat().st_size > 16_384:
                    continue
                receipt = PublicContentGrant.model_validate_json(path.read_bytes())
            except (OSError, ValueError, ValidationError):
                continue
            if receipt.server_id != server_id:
                continue
            if not receipt.issued_at <= now < receipt.expires_at:
                continue
            if notes:
                if subject_key == receipt.parent_item_key and receipt.include_notes:
                    return True
            elif subject_key in [receipt.parent_item_key, *receipt.attachment_keys]:
                return True
        return False

    def _receipt_path(self, server_id: str, parent_item_key: str) -> Path:
        name = hashlib.sha256(f"{server_id}\0{parent_item_key}".encode()).hexdigest()
        return self.directory / f"{name}.json"


class MCPContentPolicy:
    """Default-deny content output to cloud-backed MCP clients such as Codex."""

    def __init__(self, *, consents: ContentConsentStore | None = None) -> None:
        self._consents = consents

    def require(
        self,
        subject_key: str,
        *,
        allow_cloud: bool,
        server_id: Callable[[], str | None],
        notes: bool = False,
    ) -> None:
        if allow_cloud and self._consents is not None:
            instance = server_id()
            if instance and self._consents.allows(subject_key, server_id=instance, notes=notes):
                return
        raise PrivacyViolation(
            "内容默认不会返回云端 MCP 客户端。请在 Zotero 本地侧边栏确认论文公开并授权，"
            "然后在本次调用设置 allow_cloud=true。敏感材料请在本地侧边栏处理。"
        )
