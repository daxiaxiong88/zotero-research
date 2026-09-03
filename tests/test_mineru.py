from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pymupdf as fitz
import pytest

from zotero_research_mcp.mineru import MinerUParser, MinerUParserError


def _save_blank_pdf(path: Path) -> None:
    document = fitz.open()
    document.new_page()
    document.new_page()
    document.save(path)
    document.close()


def test_mineru_parser_runs_fixed_local_cli_and_reads_structured_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pdf_path = tmp_path / "synthetic.pdf"
    _save_blank_pdf(pdf_path)
    model_path = tmp_path / "pipeline-model"
    model_path.mkdir()
    original_digest = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
    seen: dict[str, object] = {}

    def fake_run(
        command: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        seen["command"] = command
        seen["kwargs"] = kwargs
        output_directory = Path(command[command.index("-o") + 1])
        config_path = Path(str(kwargs["env"]["MINERU_TOOLS_CONFIG_JSON"]))  # type: ignore[index]
        config = json.loads(config_path.read_text(encoding="utf-8"))
        assert config == {
            "model-source": "local",
            "models-dir": {"pipeline": str(model_path.resolve())},
        }
        content_path = output_directory / "synthetic" / "synthetic_content_list.json"
        content_path.parent.mkdir()
        content_path.write_text(
            json.dumps(
                [
                    {
                        "type": "text",
                        "text": "Recovered text",
                        "page_idx": 0,
                    },
                    {
                        "type": "table",
                        "table_caption": ["Table caption"],
                        "table_body": "<table><tr><td>42</td></tr></table>",
                        "page_idx": 0,
                    },
                    {
                        "type": "equation",
                        "text": "E = mc^2",
                        "page_idx": 1,
                    },
                ]
            ),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("zotero_research_mcp.mineru.subprocess.run", fake_run)
    monkeypatch.setenv("MINERU_MODEL_SOURCE", "modelscope")
    monkeypatch.setenv("MINERU_API_URL", "https://remote.example/api")
    monkeypatch.setenv("MINERU_FORMULA_ENABLE", "false")
    monkeypatch.setenv("MINERU_TOOLS_CONFIG_JSON", "remote-mineru.json")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:8080")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://remote.example/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "paper-secret")
    pages = MinerUParser(model_path=model_path).extract_pages(pdf_path)

    command = seen["command"]
    kwargs = seen["kwargs"]
    assert isinstance(command, list)
    assert "--api-url" not in command
    assert command[command.index("--backend") + 1] == "pipeline"
    assert command[command.index("--method") + 1] == "auto"
    assert command[command.index("--formula") + 1] == "true"
    assert command[command.index("--table") + 1] == "true"
    assert kwargs["shell"] is False  # type: ignore[index]
    environment = kwargs["env"]
    assert isinstance(environment, dict)
    assert environment["MINERU_MODEL_SOURCE"] == "local"
    assert "MINERU_API_URL" not in environment
    assert "MINERU_FORMULA_ENABLE" not in environment
    assert environment["MINERU_TOOLS_CONFIG_JSON"] != "remote-mineru.json"
    assert "HTTPS_PROXY" not in environment
    assert "OPENAI_BASE_URL" not in environment
    assert "OPENAI_API_KEY" not in environment
    assert kwargs["stdout"] is subprocess.DEVNULL  # type: ignore[index]
    assert kwargs["stderr"] is subprocess.DEVNULL  # type: ignore[index]
    assert kwargs["creationflags"] == getattr(subprocess, "CREATE_NO_WINDOW", 0)  # type: ignore[index]
    assert pages[0].text == "Recovered text\nTable caption\n<table><tr><td>42</td></tr></table>"
    assert pages[1].text == "E = mc^2"
    assert hashlib.sha256(pdf_path.read_bytes()).hexdigest() == original_digest
    assert not Path(str(command[command.index("-o") + 1])).exists()


def test_mineru_parser_requires_an_existing_explicit_offline_model_path(tmp_path: Path) -> None:
    pdf_path = tmp_path / "synthetic.pdf"
    _save_blank_pdf(pdf_path)

    with pytest.raises(MinerUParserError, match="offline model path is required"):
        MinerUParser().extract_pages(pdf_path)

    with pytest.raises(MinerUParserError, match="does not exist"):
        MinerUParser(model_path=tmp_path / "missing").extract_pages(pdf_path)


def test_mineru_parser_converts_timeout_to_actionable_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pdf_path = tmp_path / "synthetic.pdf"
    _save_blank_pdf(pdf_path)
    model_path = tmp_path / "pipeline-model"
    model_path.mkdir()

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    monkeypatch.setattr("zotero_research_mcp.mineru.subprocess.run", fake_run)
    with pytest.raises(MinerUParserError, match="configured timeout"):
        MinerUParser(model_path=model_path, timeout_seconds=0.1).extract_pages(pdf_path)


def test_mineru_failure_does_not_expose_process_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pdf_path = tmp_path / "synthetic.pdf"
    _save_blank_pdf(pdf_path)
    model_path = tmp_path / "pipeline-model"
    model_path.mkdir()
    secret = "paper body and secret-token"

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 17, stdout=secret, stderr=secret)

    monkeypatch.setattr("zotero_research_mcp.mineru.subprocess.run", fake_run)
    with pytest.raises(MinerUParserError) as error:
        MinerUParser(model_path=model_path).extract_pages(pdf_path)
    assert secret not in str(error.value)
