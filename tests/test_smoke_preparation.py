from __future__ import annotations

import json
import zipfile
from pathlib import Path

from scripts.prepare_zotero_smoke import FIXTURE_ID, PLUGIN_ID, prepare


def _research_xpi(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "manifest.json",
            json.dumps({"applications": {"zotero": {"id": PLUGIN_ID}}}),
        )
        archive.writestr("bootstrap.js", "/* current production fixture */")
        archive.writestr(
            "config.json",
            json.dumps({"bridgeExecutable": "must-not-be-used", "apiKey": "must-not-leak"}),
        )


def test_prepare_marks_only_disposable_profile_and_data_directories(tmp_path: Path) -> None:
    source = tmp_path / "current.xpi"
    _research_xpi(source)

    root, port = prepare(source, tmp_path / "artifacts", native_checks=True)

    assert root.is_relative_to(tmp_path / "artifacts")
    assert (root / "profile").is_dir()
    assert (root / "data").is_dir()
    assert 1 <= port <= 65535 and port != 23119
    with zipfile.ZipFile(root / "profile" / "extensions" / f"{PLUGIN_ID}.xpi") as archive:
        assert "config.json" not in archive.namelist()
    fixture_xpi = root / "profile" / "extensions" / f"{FIXTURE_ID}.xpi"
    with zipfile.ZipFile(fixture_xpi) as archive:
        fixture = json.loads(archive.read("fixture.json"))
    assert fixture == {
        "profileDirectory": str(root / "profile"),
        "dataDirectory": str(root / "data"),
        "pdfPath": str(root / "synthetic.pdf"),
        "reportPath": str(root / "fixture-report.json"),
        "nativeChecks": True,
    }
    user_js = (root / "profile" / "user.js").read_text(encoding="utf-8")
    assert json.dumps(str(root / "data")) in user_js
    assert '"extensions.zotero.researchAssistant.apiKey", ""' in user_js
    assert '"extensions.zotero.researchAssistant.mineruExecutable", ""' in user_js


def test_prepare_accepts_retired_bridge_argument_without_resolving_or_launching(
    tmp_path: Path,
) -> None:
    source = tmp_path / "current.xpi"
    _research_xpi(source)

    root, _ = prepare(
        source,
        tmp_path / "artifacts",
        tmp_path / "does-not-exist" / "retired-bridge.exe",
    )

    assert root.is_dir()
    with zipfile.ZipFile(root / "profile" / "extensions" / f"{PLUGIN_ID}.xpi") as archive:
        assert "config.json" not in archive.namelist()
