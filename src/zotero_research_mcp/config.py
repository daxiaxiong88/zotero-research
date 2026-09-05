"""Environment-backed configuration for the read-only Zotero MCP service."""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .mineru import MinerUParser
from .pdf import PdfExtractor
from .service import ResearchService
from .zotero import DEFAULT_LOCAL_API_URL, ZoteroLocalClient


class Settings(BaseSettings):
    """Runtime settings loaded from ``ZRM_*`` environment variables."""

    model_config = SettingsConfigDict(
        env_prefix='ZRM_',
        env_file='.env',
        env_file_encoding='utf-8',
        extra='ignore',
    )

    zotero_base_url: str = DEFAULT_LOCAL_API_URL
    mineru_model_path: Path | None = None
    mineru_executable: str = 'mineru'
    mineru_timeout_seconds: float = Field(default=600.0, ge=1, le=1800)


def build_service(settings: Settings | None = None) -> ResearchService:
    """Create the production service without performing network requests."""

    active = settings or Settings()
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
    )
