"""Environment-backed configuration with private defaults."""

from __future__ import annotations

import os
from datetime import timedelta
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .disclosure import ContentConsentStore, MCPContentPolicy
from .mineru import MinerUParser
from .model import ModelClient, OpenAICompatibleModelClient
from .notes import NotePreviewStore
from .pdf import PdfExtractor
from .service import ResearchService
from .zotero import DEFAULT_LOCAL_API_URL, ZoteroLocalClient


class Settings(BaseSettings):
    """Runtime settings loaded from ``ZRM_*`` environment variables."""

    model_config = SettingsConfigDict(
        env_prefix="ZRM_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    zotero_base_url: str = DEFAULT_LOCAL_API_URL
    model_base_url: str | None = None
    model_name: str | None = None
    model_api_key: SecretStr | None = None
    model_trust: Literal["auto", "local", "external"] = "auto"
    local_model_base_url: str = "http://127.0.0.1:11434/v1"
    local_model_name: str | None = None
    mineru_model_path: Path | None = None
    mineru_executable: str = "mineru"
    mineru_timeout_seconds: float = Field(default=600.0, ge=1, le=1800)
    mcp_client: Literal["cloud", "local"] = "cloud"
    state_directory: Path = Field(
        default_factory=lambda: (
            Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".local"))) / "ZoteroResearch"
        )
    )
    model_timeout_seconds: float = Field(default=120.0, ge=1.0, le=600.0)
    note_preview_ttl_seconds: int = Field(default=600, ge=60, le=3600)

    @model_validator(mode="after")
    def validate_model_pair(self) -> Settings:
        if (self.model_base_url is None) != (self.model_name is None):
            raise ValueError("ZRM_MODEL_BASE_URL and ZRM_MODEL_NAME must be set together")
        return self


def build_service(settings: Settings | None = None) -> ResearchService:
    """Create the production service without performing network requests."""

    active = settings or Settings()
    model: ModelClient | None = None
    local_model: ModelClient | None = None
    if active.local_model_name:
        local_model = OpenAICompatibleModelClient(
            base_url=active.local_model_base_url,
            model=active.local_model_name,
            is_local=True,
            timeout=active.model_timeout_seconds,
        )
    if active.model_base_url is not None and active.model_name is not None:
        trust_override = {
            "auto": None,
            "local": True,
            "external": False,
        }[active.model_trust]
        model = OpenAICompatibleModelClient(
            base_url=active.model_base_url,
            model=active.model_name,
            api_key=(
                active.model_api_key.get_secret_value()
                if active.model_api_key is not None
                else None
            ),
            is_local=trust_override,
            timeout=active.model_timeout_seconds,
        )
    return ResearchService(
        zotero=ZoteroLocalClient(base_url=active.zotero_base_url),
        pdf_extractor=PdfExtractor(
            heavy_parser=MinerUParser(
                model_path=active.mineru_model_path,
                executable=active.mineru_executable,
                timeout_seconds=active.mineru_timeout_seconds,
            )
            if active.mineru_model_path
            else None
        ),
        model=model,
        local_model=local_model,
        note_previews=NotePreviewStore(ttl=timedelta(seconds=active.note_preview_ttl_seconds)),
    )


def build_content_policy(settings: Settings) -> MCPContentPolicy:
    return MCPContentPolicy(
        local_client=settings.mcp_client == "local",
        consents=ContentConsentStore(settings.state_directory / "content-consents"),
    )
