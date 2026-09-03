"""Strict local MinerU CLI adapter.

MinerU's current command line client is an orchestration client around a local
``mineru-api`` process.  This adapter deliberately selects the local pipeline
backend, supplies a temporary ``mineru.json`` pointing at an already-existing
model directory, and reads the resulting legacy ``*_content_list.json`` file.
It never invokes a shell, accepts arbitrary command arguments, or modifies the
input PDF.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import pymupdf

from .models import PdfPage


class MinerUParserError(RuntimeError):
    """Raised when the local MinerU process or its structured output is unusable."""


class MinerUParser:
    """Run a fixed, offline MinerU pipeline command and return page text."""

    name = "mineru-local"
    is_local = True

    def __init__(
        self,
        model_path: Path | str | None = None,
        *,
        executable: Path | str = "mineru",
        timeout_seconds: float = 600.0,
    ) -> None:
        if isinstance(executable, Path):
            executable_value = str(executable)
        elif isinstance(executable, str) and executable.strip():
            executable_value = executable
        else:
            raise ValueError("MinerU executable must be a non-empty executable name or path")

        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("MinerU timeout_seconds must be a finite positive number")

        self._executable = executable_value
        self._model_path = (
            Path(model_path).expanduser().resolve() if model_path is not None else None
        )
        self._timeout_seconds = timeout_seconds

    def extract_pages(self, path: Path) -> list[PdfPage]:
        """Parse ``path`` with the local CLI and return one ``PdfPage`` per source page."""

        input_path = _resolve_input_pdf(path)
        model_path = self._model_path
        if model_path is None:
            raise MinerUParserError(
                "MinerU offline model path is required; construct MinerUParser "
                "with model_path=<existing pipeline model directory>."
            )
        if not model_path.is_dir():
            raise MinerUParserError(
                "MinerU offline model path does not exist or is not a directory: "
                f"{model_path}. Set model_path to the downloaded local pipeline model directory."
            )

        page_count = _source_page_count(input_path)
        with tempfile.TemporaryDirectory(prefix="zotero-mineru-") as temporary_directory:
            output_directory = Path(temporary_directory)
            config_path = output_directory / "mineru.json"
            _write_local_config(config_path, model_path)
            environment = _offline_environment(config_path)
            command = [
                self._executable,
                "-p",
                str(input_path),
                "-o",
                str(output_directory),
                "--backend",
                "pipeline",
                "--method",
                "auto",
                "--formula",
                "true",
                "--table",
                "true",
            ]
            _run_mineru(command, environment, self._timeout_seconds)
            content_list_path = _find_content_list(output_directory, input_path.stem)
            payload = _read_json(content_list_path)
            return _pages_from_content_list(payload, page_count)


def _resolve_input_pdf(path: Path) -> Path:
    try:
        input_path = path.expanduser().resolve()
    except (AttributeError, OSError, RuntimeError) as exc:
        raise MinerUParserError(f"Unable to resolve MinerU input PDF path: {exc}") from exc
    if not input_path.is_file():
        raise MinerUParserError(f"MinerU input PDF does not exist: {input_path}")
    return input_path


def _source_page_count(path: Path) -> int:
    try:
        with pymupdf.open(path) as document:  # type: ignore[no-untyped-call]
            if not document.is_pdf:
                raise MinerUParserError(
                    "MinerU input is not a PDF; PyMuPDF detected another document format."
                )
            if document.needs_pass:
                raise MinerUParserError("Encrypted PDF requires a password before MinerU parsing.")
            return int(document.page_count)
    except MinerUParserError:
        raise
    except (OSError, RuntimeError, ValueError, pymupdf.FileDataError) as exc:
        raise MinerUParserError(
            f"Unable to read source PDF before MinerU parsing: {path.name}"
        ) from exc


_REMOTE_ROUTE_ENVIRONMENT = {
    "HF_ENDPOINT",
    "HF_HUB_ENDPOINT",
    "MODELSCOPE_ENDPOINT",
    "MODELSCOPE_API_BASE",
    "OPENAI_API_BASE",
    "OPENAI_BASE_URL",
    "AZURE_OPENAI_ENDPOINT",
    "DASHSCOPE_BASE_URL",
}
_REMOTE_CREDENTIAL_ENVIRONMENT = {
    "AZURE_OPENAI_API_KEY",
    "DASHSCOPE_API_KEY",
    "HF_API_TOKEN",
    "HF_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
    "MODELSCOPE_API_TOKEN",
    "OPENAI_API_KEY",
}


def _offline_environment(config_path: Path) -> dict[str, str]:
    """Keep runtime basics while removing inherited network-routing settings."""

    environment: dict[str, str] = {}
    for key, value in os.environ.items():
        normalized_key = key.upper()
        if normalized_key.startswith("MINERU_"):
            # This adapter supplies the complete local configuration below;
            # no inherited MinerU flag may redirect parsing or override it.
            continue
        if normalized_key.endswith("_PROXY") or normalized_key in {
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "FTP_PROXY",
            "NO_PROXY",
        }:
            continue
        if normalized_key in _REMOTE_ROUTE_ENVIRONMENT:
            continue
        if normalized_key in _REMOTE_CREDENTIAL_ENVIRONMENT:
            continue
        environment[key] = value

    environment.update(
        {
            "MINERU_MODEL_SOURCE": "local",
            "MINERU_TOOLS_CONFIG_JSON": str(config_path),
            "HF_HUB_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
        }
    )
    return environment


def _write_local_config(path: Path, model_path: Path) -> None:
    payload = {
        "model-source": "local",
        "models-dir": {"pipeline": str(model_path)},
    }
    try:
        path.write_text(json.dumps(payload), encoding="utf-8")
    except OSError as exc:
        raise MinerUParserError(f"Unable to create temporary MinerU config: {exc}") from exc


def _run_mineru(
    command: list[str], environment: dict[str, str], timeout_seconds: float
) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            command,
            check=False,
            cwd=Path(command[command.index("-o") + 1]),
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout_seconds,
            shell=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except FileNotFoundError as exc:
        raise MinerUParserError(f"MinerU CLI executable was not found: {command[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise MinerUParserError(
            f"MinerU parsing exceeded the configured timeout ({timeout_seconds:g} seconds)."
        ) from exc
    except OSError as exc:
        raise MinerUParserError(f"Unable to execute local MinerU CLI: {exc}") from exc

    if completed.returncode != 0:
        raise MinerUParserError(
            "Local MinerU CLI failed with exit code "
            f"{completed.returncode}; inspect the local MinerU installation and model path."
        )
    return completed


def _find_content_list(output_directory: Path, document_stem: str) -> Path:
    expected_name = f"{document_stem}_content_list.json"
    exact_matches = [
        candidate
        for candidate in output_directory.rglob(expected_name)
        if candidate.is_file()
    ]
    if len(exact_matches) == 1:
        return exact_matches[0]
    if len(exact_matches) > 1:
        raise MinerUParserError(
            f"MinerU produced multiple content lists named {expected_name!r}; "
            "refusing an ambiguous result."
        )

    candidates = [
        candidate
        for candidate in output_directory.rglob("*_content_list.json")
        if candidate.is_file()
    ]
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise MinerUParserError(
            "MinerU completed without producing *_content_list.json; "
            "check the installed CLI version and local model completeness."
        )
    raise MinerUParserError(
        "MinerU produced multiple *_content_list.json files and none matched the input PDF name."
    )


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MinerUParserError(f"Unable to parse MinerU content list JSON: {path.name}") from exc


def _pages_from_content_list(payload: Any, page_count: int) -> list[PdfPage]:
    if not isinstance(payload, list):
        raise MinerUParserError("MinerU content list must be a top-level JSON array.")

    page_blocks: dict[int, list[str]] = {page: [] for page in range(page_count)}
    for block_index, block in enumerate(payload):
        if not isinstance(block, dict):
            raise MinerUParserError(f"MinerU content list block {block_index} is not an object.")
        page_index = block.get("page_idx")
        if isinstance(page_index, bool) or not isinstance(page_index, int) or page_index < 0:
            raise MinerUParserError(
                f"MinerU content list block {block_index} has an invalid page_idx; "
                "expected a zero-based integer."
            )
        if page_index >= page_count:
            raise MinerUParserError(
                f"MinerU content list block {block_index} references page_idx={page_index}, "
                f"but the source PDF has {page_count} pages."
            )
        page_blocks[page_index].extend(_block_text(block))

    return [
        PdfPage(number=page_index + 1, text="\n".join(page_blocks[page_index]).strip())
        for page_index in range(page_count)
    ]


def _block_text(block: dict[str, Any]) -> list[str]:
    block_type = block.get("type")
    text: list[str] = []

    if block_type in {
        "text",
        "equation",
        "header",
        "footer",
        "page_number",
        "aside_text",
        "page_footnote",
    }:
        _append_text(text, block.get("text"))
    elif block_type == "table":
        _append_text_list(text, block.get("table_caption"))
        _append_text(text, block.get("table_body"))
        _append_text_list(text, block.get("table_footnote"))
        _append_text(text, block.get("text"))
    elif block_type == "list":
        _append_text_list(text, block.get("list_items"))
        _append_text(text, block.get("text"))
    elif block_type == "code":
        _append_text_list(text, block.get("code_caption"))
        _append_text(text, block.get("code_body"))
        _append_text_list(text, block.get("code_footnote"))
        _append_text(text, block.get("text"))
    elif block_type in {"image", "chart"}:
        _append_text_list(text, block.get("image_caption"))
        _append_text_list(text, block.get("chart_caption"))
        _append_text_list(text, block.get("image_footnote"))
        _append_text_list(text, block.get("chart_footnote"))
        _append_text(text, block.get("content"))
    else:
        # Keep forward compatibility with a new textual block type while never
        # stringifying arbitrary objects into fake extraction output.
        _append_text(text, block.get("text"))
    return text


def _append_text(target: list[str], value: Any) -> None:
    if isinstance(value, str) and value.strip():
        target.append(value.strip())


def _append_text_list(target: list[str], value: Any) -> None:
    if isinstance(value, list):
        for entry in value:
            _append_text(target, entry)
