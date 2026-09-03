"""Authenticated loopback IPC for the native Zotero sidebar, not a public web API."""

from __future__ import annotations

import hmac
import json
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Annotated, Any, cast

import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError

from .analysis import AnalysisTask
from .citations import CitationRequest
from .config import Settings, build_service
from .disclosure import ContentConsentStore
from .model import ModelResponseError
from .models import DocumentSensitivity
from .notes import NotePreviewError
from .pdf import PdfExtractionError
from .privacy import PrivacyViolation
from .service import ResearchService
from .zotero import LocalWriteAuthorizationRequired, LocalWriteOutcomeUnknown

ItemKey = Annotated[str, Field(pattern=r"^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$")]


class _Params(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _Envelope(_Params):
    method: str = Field(min_length=1, max_length=64)
    params: dict[str, Any] = Field(default_factory=dict)
    expected_server_id: str | None = Field(default=None, max_length=128)


class _Item(_Params):
    item_key: ItemKey


class _Reading(_Item):
    attachment_key: ItemKey | None = None
    sensitivity: DocumentSensitivity = "sensitive"
    allow_cloud: StrictBool = False
    allow_heavy_fallback: StrictBool = False
    force_heavy: StrictBool = False


class _Analysis(_Reading):
    mode: AnalysisTask = "reading"
    question: str = Field(default="", max_length=8000)
    selected_text: str = Field(default="", max_length=12_000)
    selection_page: int | None = Field(default=None, ge=1)


class _Evidence(_Params):
    attachment_key: ItemKey
    query: str = Field(min_length=1, max_length=8000)
    top_k: int = Field(default=5, ge=1, le=20)
    allow_heavy_fallback: StrictBool = False
    force_heavy: StrictBool = False


class _Locate(_Params):
    attachment_key: ItemKey
    page: int = Field(ge=1, le=100_000)
    quote: str = Field(min_length=1, max_length=12_000)


class _Citations(_Params):
    requests: list[CitationRequest] = Field(min_length=1, max_length=20)
    allow_network: StrictBool = False


class _PreviewNote(_Params):
    parent_item_key: ItemKey
    title: str = Field(min_length=1, max_length=500)
    content: str = Field(min_length=1, max_length=100_000)
    tags: list[str] | None = Field(default=None, max_length=20)


class _WriteNote(_Params):
    preview_token: str = Field(min_length=20, max_length=128)
    expected_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    confirmed_by_user: StrictBool = False


class _Grant(_Item):
    confirmed_public: StrictBool = False
    include_notes: StrictBool = False


_PARAMETERS: dict[str, type[BaseModel]] = {
    "health": _Params,
    "item_context": _Item,
    "analyze": _Analysis,
    "reading_card": _Reading,
    "evidence": _Evidence,
    "locate": _Locate,
    "audit_citations": _Citations,
    "preview_note": _PreviewNote,
    "authorize_write": _Params,
    "write_note": _WriteNote,
    "grant_cloud_access": _Grant,
    "revoke_cloud_access": _Item,
    "shutdown": _Params,
}


class InstanceMismatch(ValueError):
    pass


class BridgeApplication:
    """Only named research operations, with the originating library pinned first."""

    def __init__(self, service: ResearchService, consents: ContentConsentStore) -> None:
        self.service = service
        self.consents = consents
        self._write_lock = threading.Lock()

    def dispatch(self, body: object) -> object:
        envelope = _Envelope.model_validate(body)
        method = envelope.method
        if method not in _PARAMETERS:
            raise ValueError("未知的科研助手操作。")
        parameters = _PARAMETERS[method].model_validate(envelope.params)
        args = parameters.model_dump()
        if method == "health":
            report = self.service.health_check().model_dump(mode="json")
            return {
                **report,
                "models": self.service.model_status(),
                "parsers": self.service.parser_status(),
            }
        if method == "shutdown":
            return {"stopping": True}
        if not envelope.expected_server_id:
            raise InstanceMismatch("请先从当前 Zotero 实例重新连接科研助手。")
        try:
            self.service.verify_instance(envelope.expected_server_id)
        except ValueError as exc:
            raise InstanceMismatch("扩展和后端连接的 Zotero 文献库不一致，操作已停止。") from exc
        if method == "item_context":
            return self.service.get_item_context(**args)
        if method == "analyze":
            return self.service.analyze_paper(**args)
        if method == "reading_card":
            return self.service.generate_reading_card(**args)
        if method == "evidence":
            return self.service.retrieve_evidence(**args)
        if method == "locate":
            return self.service.locate_quote(**args)
        if method == "audit_citations":
            citation_params = cast(_Citations, parameters)
            return self.service.audit_citations(
                citation_params.requests, allow_network=citation_params.allow_network
            )
        if method == "preview_note":
            return self.service.preview_child_note(**args)
        if method == "authorize_write":
            with self._write_lock:
                return self.service.request_write_authorization()
        if method == "write_note":
            with self._write_lock:
                return self.service.write_child_note(**args)
        if method == "grant_cloud_access":
            if not args["confirmed_public"]:
                raise PrivacyViolation("请在 Zotero 本地明确确认论文公开并允许云端读取。")
            context = self.service.get_item_context(args["item_key"])
            return self.consents.grant_public(
                server_id=envelope.expected_server_id,
                parent_item_key=context.item.key,
                attachment_keys=[entry.key for entry in context.attachments],
                confirmed_public=True,
                include_notes=args["include_notes"],
            )
        if method == "revoke_cloud_access":
            self.consents.revoke(
                server_id=envelope.expected_server_id, parent_item_key=args["item_key"]
            )
            return {"revoked": True}
        raise ValueError("未知的科研助手操作。")


class BridgeHTTPServer(ThreadingHTTPServer):
    """A random-port, per-process capability protected endpoint."""

    daemon_threads = True
    block_on_close = False
    request_queue_size = 8

    def __init__(self, application: BridgeApplication) -> None:
        self.application = application
        self._token = secrets.token_urlsafe(32)
        self.slots = threading.BoundedSemaphore(4)
        super().__init__(("127.0.0.1", 0), _Handler)

    def startup_info(self) -> dict[str, Any]:
        return {
            "protocol": 1,
            "url": f"http://127.0.0.1:{self.server_port}",
            "token": self._token,
        }

    def is_authorized(self, authorization: str) -> bool:
        return hmac.compare_digest(
            authorization.encode("utf-8"), f"Bearer {self._token}".encode("ascii")
        )


class _Handler(BaseHTTPRequestHandler):
    server_version = "ZoteroResearchBridge"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(5)
        self._body_consumed = False

    def log_message(self, format: str, *args: Any) -> None:
        # URLs, body, API errors and headers can contain sensitive context.
        return

    def do_GET(self) -> None:
        self._error(405, "method_not_allowed", "仅支持经过本地授权的 POST 请求。")

    def do_POST(self) -> None:
        server = cast(BridgeHTTPServer, self.server)
        if self.headers.get("Origin") is not None:
            self._error(403, "origin_denied", "浏览器页面不能访问此本机桥接。")
            return
        if self.headers.get("Host") != f"127.0.0.1:{server.server_port}":
            self._error(403, "host_denied", "不接受此 Host。")
            return
        if not server.is_authorized(self.headers.get("Authorization", "")):
            self._error(401, "unauthorized", "需要当前扩展进程的本机连接令牌。")
            return
        if self.path != "/rpc":
            self._error(404, "not_found", "接口不存在。")
            return
        if self.headers.get("Transfer-Encoding"):
            self._error(400, "invalid_request", "不接受流式请求体。")
            return
        if self.headers.get_content_type() != "application/json":
            self._error(415, "invalid_content_type", "请求必须是 JSON。")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= 512_000:
            self._error(413, "request_too_large", "请求为空或超过大小限制。")
            return
        if not server.slots.acquire(blocking=False):
            self._error(503, "busy", "处理队列已满，请等待当前任务完成。")
            return
        try:
            try:
                data = self.rfile.read(length)
                self._body_consumed = True
                if len(data) != length:
                    raise ValueError("Incomplete request")
                body = json.loads(data)
                result = server.application.dispatch(body)
                if isinstance(result, BaseModel):
                    result = result.model_dump(mode="json")
                self._json(200, {"ok": True, "result": result})
                if isinstance(body, dict) and body.get("method") == "shutdown":
                    threading.Thread(target=server.shutdown, daemon=True).start()
            except InstanceMismatch:
                self._error(409, "instance_mismatch", "Zotero 实例不一致，请重新连接。")
            except PrivacyViolation as exc:
                self._error(403, "privacy_denied", str(exc))
            except LocalWriteOutcomeUnknown:
                self._error(
                    409, "write_outcome_unknown", "写入结果不确定。请先检查 Zotero，不要重复提交。"
                )
            except LocalWriteAuthorizationRequired:
                self._error(403, "write_authorization_required", "请在 Zotero 中重新授权这次写入。")
            except NotePreviewError:
                self._error(409, "preview_invalid", "预览已过期、已使用或内容不匹配，请重新预览。")
            except ModelResponseError:
                self._error(
                    422, "model_response_invalid", "模型结果缺少可靠证据或格式无效，本次未保存。"
                )
            except PdfExtractionError:
                self._error(
                    422,
                    "pdf_processing_failed",
                    "PDF 解析失败。若使用重解析，请检查 MinerU 可执行文件及完整本地模型目录；"
                    "没有自动上传或下载。",
                )
            except (ValidationError, ValueError, UnicodeError, RecursionError):
                self._error(400, "invalid_request", "请求参数无效，或当前文献/选文不满足要求。")
            except httpx.HTTPError:
                self._error(502, "upstream_unavailable", "Zotero 或模型连接失败，请检查本机配置。")
            except PermissionError:
                self._error(403, "permission_denied", "当前操作没有得到必要授权。")
            except Exception:
                self._error(500, "processing_failed", "处理失败，未自动重试；请检查配置和原文。")
        finally:
            server.slots.release()

    def _error(self, status: int, code: str, message: str) -> None:
        # Windows may reset a connection closed with unread request data, hiding
        # the denial response. Discard a bounded body, without parsing or logging it.
        if not self._body_consumed:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if 0 < length <= 512_000:
                    self.connection.settimeout(1)
                    self.rfile.read(length)
                self._body_consumed = True
            except (OSError, ValueError):
                pass
        self._json(status, {"ok": False, "error": {"code": code, "message": message}})

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True


def create_bridge_server(
    *, service: ResearchService, consents: ContentConsentStore
) -> BridgeHTTPServer:
    return BridgeHTTPServer(BridgeApplication(service, consents))


def main() -> None:
    settings = Settings()
    service = build_service(settings)
    server = create_bridge_server(
        service=service,
        consents=ContentConsentStore(settings.state_directory / "content-consents"),
    )

    def watch_parent_pipe() -> None:
        try:
            if sys.stdin is not None:
                while sys.stdin.buffer.read(1):
                    pass
        finally:
            server.shutdown()

    # A Zotero crash closes its child stdin handle, preventing an orphan bridge.
    threading.Thread(target=watch_parent_pipe, daemon=True).start()
    print(json.dumps(server.startup_info()), flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        service.close()


if __name__ == "__main__":
    main()
