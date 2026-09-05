"""FastMCP adapter for the Zotero reading service."""

from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from .analysis import AnalysisTask, PaperAnalysis
from .config import Settings, build_service
from .model import ModelResponseError
from .models import (
    EvidenceResults,
    HealthReport,
    ItemContext,
    PdfExtraction,
    ReadingCard,
    SearchResults,
)
from .pdf_geometry import QuoteLocation
from .service import ResearchService

_READ_ONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
_MODEL_PROCESSING = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=True,
)
_T = TypeVar('_T')


def _safe_content_call(operation: Callable[[], _T]) -> _T:
    """Return short, actionable errors without leaking local implementation details."""

    try:
        return operation()
    except ModelResponseError as exc:
        raise ValueError('模型结果格式无效，未返回内容。') from exc
    except httpx.HTTPError as exc:
        raise ValueError('Zotero 或模型连接失败，请检查配置。') from exc
    except (OSError, RuntimeError) as exc:
        raise ValueError('本地 PDF 处理失败，请检查附件和解析器配置。') from exc
    except ValueError as exc:
        raise ValueError('当前附件或请求不满足处理要求。') from exc
    except Exception as exc:
        raise ValueError('处理失败，未返回内部错误详情。') from exc


def create_mcp_server(*, service: ResearchService) -> FastMCP[None]:
    """Register the focused Zotero reading tool contract around an injected service."""

    server: FastMCP[None] = FastMCP(
        'Zotero Research MCP',
        instructions=(
            '通过官方 Zotero Local API 读取条目和附件；不要访问 sqlite 或任意路径。'
            'PDF 工具返回带物理页码的证据，模型回答应引用这些证据。'
            '网页 AI 连续对话从 Zotero 侧栏发起。'
        ),
        log_level='WARNING',
    )

    @server.tool(
        description='检查 Zotero 连接、PDF 解析器和可用模型。',
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def health_check() -> HealthReport:
        return service.health_check()

    @server.tool(
        description='通过官方 Local API 搜索 Zotero 顶层文献。',
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def search_items(query: str, limit: int = 20) -> SearchResults:
        return service.search_items(query, limit=limit)

    @server.tool(
        description='读取一条 Zotero 文献及其附件、子笔记元数据。',
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def get_item_context(item_key: str) -> ItemContext:
        return _safe_content_call(lambda: service.get_item_context(item_key))

    @server.tool(
        description='提取 PDF 的逐页文字；必要时可启用配置好的重解析器。',
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def extract_pdf(
        attachment_key: str,
        allow_heavy_fallback: bool = False,
        force_heavy: bool = False,
    ) -> PdfExtraction:
        return _safe_content_call(
            lambda: service.extract_pdf(
                attachment_key,
                allow_heavy_fallback=allow_heavy_fallback,
                force_heavy=force_heavy,
            )
        )

    @server.tool(
        description='检索带稳定附件编号和物理页码的 PDF 证据片段。',
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def retrieve_evidence(
        attachment_key: str,
        query: str,
        top_k: int = 5,
        allow_heavy_fallback: bool = False,
        force_heavy: bool = False,
    ) -> EvidenceResults:
        return _safe_content_call(
            lambda: service.retrieve_evidence(
                attachment_key,
                query,
                top_k=top_k,
                allow_heavy_fallback=allow_heavy_fallback,
                force_heavy=force_heavy,
            )
        )

    @server.tool(
        description='生成四部分证据关联的论文阅读卡。',
        annotations=_MODEL_PROCESSING,
        structured_output=True,
    )
    def generate_reading_card(
        item_key: str,
        attachment_key: str | None = None,
        allow_heavy_fallback: bool = False,
        force_heavy: bool = False,
    ) -> ReadingCard:
        return _safe_content_call(
            lambda: service.generate_reading_card(
                item_key,
                attachment_key=attachment_key,
                allow_heavy_fallback=allow_heavy_fallback,
                force_heavy=force_heavy,
            )
        )

    @server.tool(
        description='基于 PDF 证据进行精读、问答、解释、翻译或同行评审。',
        annotations=_MODEL_PROCESSING,
        structured_output=True,
    )
    def analyze_paper(
        item_key: str,
        attachment_key: str | None = None,
        mode: AnalysisTask = 'reading',
        question: str = '',
        selected_text: str = '',
        selection_page: int | None = None,
        allow_heavy_fallback: bool = False,
        force_heavy: bool = False,
    ) -> PaperAnalysis:
        return _safe_content_call(
            lambda: service.analyze_paper(
                item_key,
                attachment_key=attachment_key,
                mode=mode,
                question=question,
                selected_text=selected_text,
                selection_page=selection_page,
                allow_heavy_fallback=allow_heavy_fallback,
                force_heavy=force_heavy,
            )
        )

    @server.tool(
        description='定位 PDF 指定页上的唯一原文，不写入标注。',
        annotations=_READ_ONLY,
        structured_output=True,
    )
    def locate_quote(attachment_key: str, page: int, quote: str) -> QuoteLocation:
        return _safe_content_call(
            lambda: service.locate_quote(attachment_key, page=page, quote=quote)
        )

    return server


def main() -> None:
    settings = Settings()
    service = build_service(settings)
    server = create_mcp_server(service=service)
    try:
        server.run(transport='stdio')
    finally:
        service.close()
