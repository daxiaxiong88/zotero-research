from __future__ import annotations

import hashlib
import json
import os
import zipfile
from pathlib import Path

import pytest

from scripts.build_addon import (
    DEFAULT_OUTPUT,
    REPO_ROOT,
    PackageError,
    build_addon,
    build_argument_parser,
    main,
)

_RUNTIME_FILES = (
    "manifest.json",
    "bootstrap.js",
    "config.json",
    "prefs.js",
    "content/native.js",
    "content/bridge-client.js",
    "content/panel.js",
    "content/panel.css",
    "content/icon.svg",
    "content/preferences.xhtml",
    "content/preferences.js",
    "locale/en-US/zotero-research.ftl",
    "locale/zh-CN/zotero-research.ftl",
)
_DIRECTORY_ENTRIES = (
    "content/",
    "locale/",
    "locale/en-US/",
    "locale/zh-CN/",
)


def _make_addon_tree(root: Path) -> None:
    manifest = {
        "manifest_version": 2,
        "name": "Zotero Research",
        "version": "0.2.0",
        "applications": {
            "zotero": {
                "id": "zotero-research@local.invalid",
                "strict_min_version": "10.0",
                "strict_max_version": "10.0.*",
                "update_url": "https://zotero-research.invalid/fixture-updates.json",
            }
        },
    }
    config = {
        "bridgeExecutable": "template-placeholder",
        "workingDirectory": "template-placeholder",
    }
    for relative_path in _RUNTIME_FILES:
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        if relative_path == "manifest.json":
            path.write_text(json.dumps(manifest), encoding="utf-8")
        elif relative_path == "config.json":
            path.write_text(json.dumps(config), encoding="utf-8")
        else:
            path.write_text(f"// {relative_path}\n", encoding="utf-8")


def test_build_addon_injects_local_paths_and_writes_sidecars(tmp_path: Path) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    bridge_executable = tmp_path / "bin" / "bridge.exe"
    bridge_executable.parent.mkdir()
    bridge_executable.write_bytes(b"synthetic executable")
    working_directory = tmp_path / "repository"
    working_directory.mkdir()
    output = tmp_path / "dist" / "zotero-research-0.2.0.xpi"
    template_config = (addon_dir / "config.json").read_bytes()

    result = build_addon(
        addon_dir=addon_dir,
        bridge_executable=bridge_executable,
        working_directory=working_directory,
        output=output,
    )

    assert result.xpi_path == output.resolve()
    assert result.xpi_path.is_file()
    assert result.sha256_path == output.with_name(output.name + ".sha256")
    assert result.manifest_path == output.with_name(output.name + ".manifest.json")

    with zipfile.ZipFile(result.xpi_path) as archive:
        assert archive.namelist() == sorted([*_DIRECTORY_ENTRIES, *_RUNTIME_FILES])
        assert {info.date_time for info in archive.infolist()} == {(1980, 1, 1, 0, 0, 0)}
        assert {info.create_system for info in archive.infolist()} == {0}
        config = json.loads(archive.read("config.json"))
        assert config == {
            "bridgeExecutable": str(bridge_executable.resolve()),
            "workingDirectory": str(working_directory.resolve()),
        }
        assert archive.read("manifest.json") == (addon_dir / "manifest.json").read_bytes()
        zipped_manifest = json.loads(archive.read("manifest.json"))
        assert (
            zipped_manifest["applications"]["zotero"]["update_url"]
            == "https://zotero-research.invalid/fixture-updates.json"
        )
        assert zipped_manifest["manifest_version"] == 2

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    assert result.sha256_path.read_text(encoding="utf-8") == f"{digest}  {output.name}\n"
    assert (addon_dir / "config.json").read_bytes() == template_config
    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert manifest == {
        "addon_id": "zotero-research@local.invalid",
        "files": sorted(_RUNTIME_FILES),
        "format": 1,
        "version": "0.2.0",
        "zotero_min_version": "10.0",
        "zotero_max_version": "10.0.*",
    }
    assert str(bridge_executable) not in result.manifest_path.read_text(encoding="utf-8")
    assert "workingDirectory" not in result.manifest_path.read_text(encoding="utf-8")


def test_build_addon_is_byte_for_byte_deterministic(tmp_path: Path) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    bridge_executable = tmp_path / "bridge.exe"
    bridge_executable.write_bytes(b"synthetic executable")
    working_directory = tmp_path / "repository"
    working_directory.mkdir()
    first_output = tmp_path / "first.xpi"
    second_output = tmp_path / "second.xpi"

    build_addon(
        addon_dir=addon_dir,
        bridge_executable=bridge_executable,
        working_directory=working_directory,
        output=first_output,
    )
    build_addon(
        addon_dir=addon_dir,
        bridge_executable=bridge_executable,
        working_directory=working_directory,
        output=second_output,
    )

    assert first_output.read_bytes() == second_output.read_bytes()


def test_build_addon_preserves_declared_main_update_url(tmp_path: Path) -> None:
    addon_dir, bridge_executable, working_directory, output = _valid_inputs(tmp_path)
    manifest_path = addon_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["applications"]["zotero"]["update_url"] = (
        "https://zotero-research.invalid/updates.json"
    )
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = build_addon(
        addon_dir=addon_dir,
        bridge_executable=bridge_executable,
        working_directory=working_directory,
        output=output,
    )

    with zipfile.ZipFile(result.xpi_path) as archive:
        packaged_manifest = json.loads(archive.read("manifest.json"))

    assert packaged_manifest["manifest_version"] == 2
    assert (
        packaged_manifest["applications"]["zotero"]["update_url"]
        == "https://zotero-research.invalid/updates.json"
    )


def _valid_inputs(tmp_path: Path) -> tuple[Path, Path, Path, Path]:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    bridge_executable = tmp_path / "bridge.exe"
    bridge_executable.write_bytes(b"synthetic executable")
    working_directory = tmp_path / "repository"
    working_directory.mkdir()
    output = tmp_path / "dist" / "package.xpi"
    return addon_dir, bridge_executable, working_directory, output


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("manifest_version", 3, "manifest_version"),
        ("version", "0.2.1", "manifest version"),
        ("zotero_id", "", "applications.zotero.id"),
        ("zotero_id", "zotero-research@example.invalid", "applications.zotero.id"),
        ("strict_min_version", "9.9", "strict_min_version"),
        ("strict_max_version", "10.1.*", "strict_max_version"),
        ("zotero_update_url", "", "update_url"),
    ],
)
def test_build_addon_validates_manifest_identity_and_zotero_versions(
    tmp_path: Path, field: str, value: object, message: str
) -> None:
    addon_dir, bridge_executable, working_directory, output = _valid_inputs(tmp_path)
    manifest_path = addon_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if field == "zotero_id":
        manifest["applications"]["zotero"]["id"] = value
    elif field == "strict_min_version":
        manifest["applications"]["zotero"]["strict_min_version"] = value
    elif field == "strict_max_version":
        manifest["applications"]["zotero"]["strict_max_version"] = value
    elif field == "zotero_update_url":
        manifest["applications"]["zotero"]["update_url"] = value
    else:
        manifest[field] = value
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(PackageError, match=message):
        build_addon(
            addon_dir=addon_dir,
            bridge_executable=bridge_executable,
            working_directory=working_directory,
            output=output,
        )


def test_build_addon_requires_exact_zotero_maximum_version(tmp_path: Path) -> None:
    addon_dir, bridge_executable, working_directory, output = _valid_inputs(tmp_path)
    manifest_path = addon_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    del manifest["applications"]["zotero"]["strict_max_version"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(PackageError, match="strict_max_version"):
        build_addon(
            addon_dir=addon_dir,
            bridge_executable=bridge_executable,
            working_directory=working_directory,
            output=output,
        )


@pytest.mark.parametrize(
    "missing",
    _RUNTIME_FILES,
)
def test_build_addon_requires_every_allowlisted_runtime_file(
    tmp_path: Path, missing: str
) -> None:
    addon_dir, bridge_executable, working_directory, output = _valid_inputs(tmp_path)
    (addon_dir / missing).unlink()

    with pytest.raises(PackageError, match="required addon runtime file is missing"):
        build_addon(
            addon_dir=addon_dir,
            bridge_executable=bridge_executable,
            working_directory=working_directory,
            output=output,
        )


def test_build_addon_rejects_sensitive_and_unlisted_files(tmp_path: Path) -> None:
    addon_dir, bridge_executable, working_directory, output = _valid_inputs(tmp_path)
    (addon_dir / ".env").write_text("TOKEN=not-for-packaging", encoding="utf-8")

    with pytest.raises(PackageError, match="sensitive file"):
        build_addon(
            addon_dir=addon_dir,
            bridge_executable=bridge_executable,
            working_directory=working_directory,
            output=output,
        )

    (addon_dir / ".env").unlink()
    node_module = addon_dir / "node_modules" / "package.js"
    node_module.parent.mkdir()
    node_module.write_text("unexpected", encoding="utf-8")
    with pytest.raises(PackageError, match="allowed addon runtime file"):
        build_addon(
            addon_dir=addon_dir,
            bridge_executable=bridge_executable,
            working_directory=working_directory,
            output=output,
        )


def test_build_addon_rejects_symlinks(tmp_path: Path) -> None:
    addon_dir, bridge_executable, working_directory, output = _valid_inputs(tmp_path)
    external = tmp_path / "outside.js"
    external.write_text("outside", encoding="utf-8")
    link = addon_dir / "content" / "native.js"
    link.unlink()
    try:
        os.symlink(external, link)
    except OSError as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")

    with pytest.raises(PackageError, match="symlink"):
        build_addon(
            addon_dir=addon_dir,
            bridge_executable=bridge_executable,
            working_directory=working_directory,
            output=output,
        )


def test_build_addon_rejects_symlinked_addon_root(tmp_path: Path) -> None:
    real_addon = tmp_path / "real-addon"
    _make_addon_tree(real_addon)
    addon_link = tmp_path / "addon-link"
    try:
        os.symlink(real_addon, addon_link, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")
    bridge_executable = tmp_path / "bridge.exe"
    bridge_executable.write_bytes(b"synthetic executable")
    working_directory = tmp_path / "repository"
    working_directory.mkdir()

    with pytest.raises(PackageError, match="symlink"):
        build_addon(
            addon_dir=addon_link,
            bridge_executable=bridge_executable,
            working_directory=working_directory,
            output=tmp_path / "package.xpi",
        )


def test_build_addon_rejects_credentials_in_config_template(tmp_path: Path) -> None:
    addon_dir, bridge_executable, working_directory, output = _valid_inputs(tmp_path)
    config_path = addon_dir / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["apiKey"] = "real-secret"
    config_path.write_text(json.dumps(config), encoding="utf-8")

    with pytest.raises(PackageError, match="sensitive config key"):
        build_addon(
            addon_dir=addon_dir,
            bridge_executable=bridge_executable,
            working_directory=working_directory,
            output=output,
        )


def test_build_addon_rejects_unknown_config_fields(tmp_path: Path) -> None:
    addon_dir, bridge_executable, working_directory, output = _valid_inputs(tmp_path)
    config_path = addon_dir / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["host"] = "127.0.0.1"
    config_path.write_text(json.dumps(config), encoding="utf-8")

    with pytest.raises(PackageError, match="unknown config field"):
        build_addon(
            addon_dir=addon_dir,
            bridge_executable=bridge_executable,
            working_directory=working_directory,
            output=output,
        )


def test_xpi_includes_locale_directories_for_jar_discovery(tmp_path: Path) -> None:
    addon_dir, bridge_executable, working_directory, output = _valid_inputs(tmp_path)
    result = build_addon(
        addon_dir=addon_dir,
        bridge_executable=bridge_executable,
        working_directory=working_directory,
        output=output,
    )

    with zipfile.ZipFile(result.xpi_path) as archive:
        jar_directory_names = [
            name for name in archive.namelist() if name.endswith("/")
        ]

    assert set(_DIRECTORY_ENTRIES).issubset(jar_directory_names)
    assert {name for name in jar_directory_names if name.startswith("locale/")} >= {
        "locale/en-US/",
        "locale/zh-CN/",
    }


def test_build_addon_requires_absolute_existing_exe_and_repository(tmp_path: Path) -> None:
    addon_dir, bridge_executable, working_directory, output = _valid_inputs(tmp_path)

    with pytest.raises(PackageError, match=r"absolute local \.exe"):
        build_addon(
            addon_dir=addon_dir,
            bridge_executable=Path("bridge.exe"),
            working_directory=working_directory,
            output=output,
        )
    with pytest.raises(PackageError, match="does not exist"):
        build_addon(
            addon_dir=addon_dir,
            bridge_executable=tmp_path / "missing.exe",
            working_directory=working_directory,
            output=output,
        )
    with pytest.raises(PackageError, match="absolute local path"):
        build_addon(
            addon_dir=addon_dir,
            bridge_executable=bridge_executable,
            working_directory=Path("repository"),
            output=output,
        )


def test_cli_defaults_are_repo_local_and_main_reports_outputs(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    addon_dir, bridge_executable, working_directory, output = _valid_inputs(tmp_path)
    arguments = build_argument_parser().parse_args(
        [
            "--bridge-executable",
            str(bridge_executable),
            "--working-directory",
            str(working_directory),
        ]
    )
    assert arguments.addon_dir == REPO_ROOT / "addon"
    assert arguments.output == DEFAULT_OUTPUT

    assert (
        main(
            [
                "--addon-dir",
                str(addon_dir),
                "--bridge-executable",
                str(bridge_executable),
                "--working-directory",
                str(working_directory),
                "--output",
                str(output),
            ]
        )
        == 0
    )
    stdout = capsys.readouterr().out
    assert str(output.resolve()) in stdout
