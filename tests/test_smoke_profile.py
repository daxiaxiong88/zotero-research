from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pymupdf
import pytest

from scripts import prepare_zotero_smoke
from scripts.prepare_zotero_smoke import FIXTURE_ID, PLUGIN_ID, launch, prepare


@pytest.mark.parametrize("native_checks", [False, True])
def test_smoke_profile_uses_only_new_synthetic_data_and_isolated_config(
    tmp_path: Path, native_checks: bool
) -> None:
    source = tmp_path / "research.xpi"
    executable = tmp_path / "bridge.exe"
    executable.write_bytes(b"test executable, never launched")
    original_config = {"bridgeExecutable": "original", "workingDirectory": "real-repository"}
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr(
            "manifest.json", json.dumps({"applications": {"zotero": {"id": PLUGIN_ID}}})
        )
        archive.writestr("config.json", json.dumps(original_config))
        archive.writestr("bootstrap.js", "/* synthetic package */")

    root, port = prepare(source, tmp_path / "artifacts", executable, native_checks=native_checks)

    assert root.is_relative_to(tmp_path / "artifacts")
    assert root.name.startswith("zotero-smoke-")
    assert 1 <= port <= 65535 and port != 23119
    assert (root / "data").is_dir()
    preferences = (root / "profile" / "user.js").read_text(encoding="utf-8")
    assert json.dumps(str(root / "data")) in preferences
    assert '"extensions.zoteroWinWordIntegration.skipInstallation", true' in preferences
    assert '"extensions.zoteroOpenOfficeIntegration.skipInstallation", true' in preferences
    assert f'"extensions.zotero.httpServer.port", {port}' in preferences
    with zipfile.ZipFile(root / "profile" / "extensions" / f"{PLUGIN_ID}.xpi") as archive:
        assert json.loads(archive.read("config.json")) == {
            "bridgeExecutable": str(executable),
            "workingDirectory": str(root),
        }
    with zipfile.ZipFile(source) as archive:
        assert json.loads(archive.read("config.json")) == original_config
    with zipfile.ZipFile(root / "profile" / "extensions" / f"{FIXTURE_ID}.xpi") as archive:
        fixture = json.loads(archive.read("fixture.json"))
        assert fixture["dataDirectory"] == str(root / "data")
        assert fixture["reportPath"] == str(root / "fixture-report.json")
        assert fixture["nativeChecks"] is native_checks
        assert "ZRM_SMOKE_ROOT" in archive.read("bootstrap.js").decode()
        assert "runSyntheticNativeChecks" in archive.read("native-checks.js").decode()
    with pymupdf.open(root / "synthetic.pdf") as document:
        assert len(document) == 2
        assert "not a real scientific paper" in document[0].get_text()


def test_native_smoke_rejects_missing_research_addon_before_creating_files(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="require the research addon"):
        prepare(
            tmp_path / "unused.xpi", tmp_path / "artifacts", tmp_path / "unused.exe",
            include_research=False, native_checks=True,
        )
    assert not (tmp_path / "artifacts").exists()


def test_smoke_launch_strips_real_assistant_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = tmp_path / "zotero.exe"
    executable.write_bytes(b"not executable")
    monkeypatch.setenv("ZRM_MODEL_API_KEY", "must-not-inherit")
    monkeypatch.setenv("ZRM_MODEL_BASE_URL", "https://example.test/v1")
    monkeypatch.setenv("ZRM_LOCAL_MODEL_NAME", "must-not-inherit")
    captured: dict[str, object] = {}

    def capture(arguments: list[str], **kwargs: object) -> object:
        captured.update({"args": arguments, **kwargs})
        return object()

    monkeypatch.setattr(subprocess, "Popen", capture)
    launch(executable, tmp_path, 23120)
    assert captured["args"] == [
        str(executable),
        "-no-remote",
        "-profile",
        str(tmp_path / "profile"),
        "-datadir",
        str(tmp_path / "data"),
    ]
    environment = captured["env"]
    assert isinstance(environment, dict)
    assert "ZRM_MODEL_API_KEY" not in environment
    assert "ZRM_MODEL_BASE_URL" not in environment
    assert "ZRM_LOCAL_MODEL_NAME" not in environment
    assert environment["ZRM_ZOTERO_BASE_URL"] == "http://127.0.0.1:23120/api/"
    assert environment["ZRM_STATE_DIRECTORY"] == str(tmp_path / "assistant-state")


def test_failed_smoke_report_returns_nonzero_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "fixture-report.json").write_text('{"status":"fixture_failed"}', encoding="utf-8")
    monkeypatch.setattr(
        prepare_zotero_smoke, "prepare", lambda *_args, **_kwargs: (tmp_path, 23120)
    )
    monkeypatch.setattr(prepare_zotero_smoke, "launch", lambda *_args: SimpleNamespace(pid=123))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "prepare_zotero_smoke.py",
            "--xpi",
            "unused.xpi",
            "--bridge-executable",
            "unused.exe",
            "--launch",
        ],
    )
    assert prepare_zotero_smoke.main() == 1
