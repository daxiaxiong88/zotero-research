"""Prepare/launch a separate Zotero profile containing only synthetic test material.

No main-profile files are read or changed. The generated fixture extension refuses
to create items unless Zotero confirms the exact, explicitly marked data directory.
The fixture extension is never included in the distributable research XPI.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

import pymupdf

PLUGIN_ID = "zotero-research@local.invalid"
FIXTURE_ID = "zotero-research-smoke@local.invalid"


def prepare(
    xpi: Path,
    artifact_directory: Path,
    bridge_executable: Path,
    *,
    include_research: bool = True,
    native_checks: bool = False,
) -> tuple[Path, int]:
    if native_checks and not include_research:
        raise ValueError("Native integration checks require the research addon")
    xpi = xpi.resolve(strict=True)
    bridge_executable = bridge_executable.resolve(strict=True)
    artifact_directory.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="zotero-smoke-", dir=artifact_directory.resolve()))
    profile = root / "profile"
    data = root / "data"
    extensions = profile / "extensions"
    extensions.mkdir(parents=True)
    data.mkdir()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    if port == 23119:
        raise RuntimeError("Refusing to use the primary Zotero port")

    preferences = {
        "extensions.zotero.useDataDir": True,
        "extensions.zotero.dataDir": str(data),
        "extensions.zotero.httpServer.port": port,
        "extensions.zotero.httpServer.localAPI.enabled": True,
        "extensions.zotero.firstRun2": False,
        "extensions.zotero.firstRunGuidance": False,
        "extensions.zotero.automaticScraperUpdates": False,
        "extensions.zotero.sync.autoSync": False,
        # Do not let a fresh test profile install/replace the user's Word/LibreOffice add-ins.
        "extensions.zoteroWinWordIntegration.skipInstallation": True,
        "extensions.zoteroOpenOfficeIntegration.skipInstallation": True,
        # Developer-generated extensions in this empty, never-signed-in test profile only.
        "extensions.autoDisableScopes": 0,
        "extensions.enabledScopes": 1,
    }
    (profile / "user.js").write_text(
        "\n".join(
            f"user_pref({json.dumps(key)}, {json.dumps(value)});"
            for key, value in preferences.items()
        ),
        encoding="utf-8",
    )
    pdf_path = root / "synthetic.pdf"
    with pymupdf.open() as document:
        for text in [
            "Zotero Research Synthetic Test\n\n"
            "This is generated test material, not a real scientific paper.\n"
            "Results: The simulated treatment improved the endpoint by twelve percent.\n"
            "The values are fictional. No scientific conclusion should be inferred.\n"
            "Limitation: This fixture tests software integration only.",
            "Synthetic Methods\n\n"
            "A simulated randomized allocation used twenty-four fictional records.\n"
            "Assessors were masked in this synthetic scenario.\n"
            "No real participants, measurements or unpublished results are included.",
        ]:
            page = document.new_page(width=600, height=800)
            page.insert_textbox(pymupdf.Rect(60, 65, 540, 730), text, fontsize=12)
        document.save(pdf_path)

    if include_research:
        with (
            zipfile.ZipFile(xpi) as source,
            zipfile.ZipFile(extensions / f"{PLUGIN_ID}.xpi", "w") as destination,
        ):
            manifest = json.loads(source.read("manifest.json"))
            if manifest.get("applications", {}).get("zotero", {}).get("id") != PLUGIN_ID:
                raise ValueError("Expected the research plugin, not an arbitrary extension")
            for entry in source.infolist():
                content = source.read(entry.filename)
                if entry.filename == "config.json":
                    content = json.dumps(
                        {
                            "bridgeExecutable": str(bridge_executable),
                            # No .env here: real model keys/config must not affect this test.
                            "workingDirectory": str(root),
                        }
                    ).encode("utf-8")
                destination.writestr(entry, content)

    fixture_source = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "zotero_smoke"
    fixture_config = {
        "dataDirectory": str(data),
        "pdfPath": str(pdf_path),
        "reportPath": str(root / "fixture-report.json"),
        "nativeChecks": native_checks,
    }
    with zipfile.ZipFile(extensions / f"{FIXTURE_ID}.xpi", "w") as archive:
        for name in ("manifest.json", "bootstrap.js", "native-checks.js"):
            archive.write(fixture_source / name, name)
        archive.writestr("fixture.json", json.dumps(fixture_config))
    return root, port


def launch(zotero_executable: Path, root: Path, port: int) -> subprocess.Popen[bytes]:
    environment = {
        key: value for key, value in os.environ.items() if not key.upper().startswith("ZRM_")
    }
    environment.update(
        {
            "MOZ_NO_REMOTE": "1",
            "ZRM_SMOKE_ROOT": str(root),
            "ZRM_ZOTERO_BASE_URL": f"http://127.0.0.1:{port}/api/",
            "ZRM_STATE_DIRECTORY": str(root / "assistant-state"),
            "PYTHONUTF8": "1",
        }
    )
    return subprocess.Popen(
        [
            str(zotero_executable.resolve(strict=True)),
            "-no-remote",
            "-profile",
            str(root / "profile"),
            "-datadir",
            str(root / "data"),
        ],
        cwd=root,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xpi", type=Path, required=True)
    parser.add_argument("--bridge-executable", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, default=Path("artifacts"))
    parser.add_argument(
        "--zotero-executable", type=Path, default=Path(r"C:\Program Files\Zotero\zotero.exe")
    )
    parser.add_argument("--launch", action="store_true")
    parser.add_argument("--without-research-addon", action="store_true", help="A/B control only")
    parser.add_argument(
        "--native-checks",
        action="store_true",
        help="Verify the production bridge and write one highlight in the generated PDF only",
    )
    args = parser.parse_args()
    root, port = prepare(
        args.xpi,
        args.artifacts,
        args.bridge_executable,
        include_research=not args.without_research_addon,
        native_checks=args.native_checks,
    )
    info = {"root": str(root), "port": port, "status": "prepared"}
    if args.launch:
        child = launch(args.zotero_executable, root, port)
        info["pid"] = child.pid
        print(json.dumps(info), flush=True)
        deadline = time.monotonic() + 90
        report = root / "fixture-report.json"
        # On Windows Zotero's launcher exits after starting its real child.
        # Observe the fixture report, not the launcher's early zero exit.
        while time.monotonic() < deadline:
            if report.exists():
                try:
                    observed = json.loads(report.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    observed = {}
                if observed.get("status") in {"fixture_ready", "fixture_failed"}:
                    info["status"] = str(observed["status"])
                    print(json.dumps(info), flush=True)
                    return 0 if info["status"] == "fixture_ready" else 1
            time.sleep(0.5)
        info["status"] = "fixture_timeout"
    print(json.dumps(info), flush=True)
    return 1 if args.launch else 0


if __name__ == "__main__":
    raise SystemExit(main())
