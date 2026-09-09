from __future__ import annotations

import hashlib
import importlib
import json
import os
import struct
import time
import zipfile
from pathlib import Path

import pytest

from scripts.build_addon import (
    DEFAULT_OUTPUT,
    PACKAGE_VERSION,
    REPO_ROOT,
    PackageError,
    build_addon,
    build_argument_parser,
    main,
)

_RUNTIME_FILES = (
    "manifest.json",
    "bootstrap.js",
    "prefs.js",
    "content/native.js",
    "content/relay.js",
    "content/katex.min.js",
    "content/katex.LICENSE.txt",
    "content/markdown.js",
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
        "version": PACKAGE_VERSION,
        "applications": {
            "zotero": {
                "id": "zotero-research@local.invalid",
                "strict_min_version": "10.0",
                "strict_max_version": "10.0.*",
                "update_url": "https://zotero-research.invalid/fixture-updates.json",
            }
        },
    }
    for relative_path in _RUNTIME_FILES:
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        if relative_path == "manifest.json":
            path.write_text(json.dumps(manifest), encoding="utf-8")
        else:
            path.write_text(f"// {relative_path}\n", encoding="utf-8")


def _write_release_package(
    path: Path,
    version: str,
    *,
    addon_id: str = "zotero-research@local.invalid",
    include_sidecars: bool = True,
    sidecar_version: str | None = None,
    sidecar_addon_id: str | None = None,
    sha_text: str | None = None,
    payload_marker: str = "",
) -> None:
    manifest = {
        "manifest_version": 2,
        "name": "Zotero Research",
        "version": version,
        "applications": {
            "zotero": {
                "id": addon_id,
                "strict_min_version": "10.0",
                "strict_max_version": "10.0.*",
                "update_url": "https://zotero-research.invalid/fixture-updates.json",
            }
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        for relative_path in sorted([*_DIRECTORY_ENTRIES, *_RUNTIME_FILES]):
            info = zipfile.ZipInfo(relative_path, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 0
            if relative_path.endswith("/"):
                archive.writestr(info, b"")
            elif relative_path == "manifest.json":
                archive.writestr(info, json.dumps(manifest).encode("utf-8"))
            else:
                archive.writestr(info, f"// {relative_path}{payload_marker}\n".encode())

    if not include_sidecars:
        return
    inventory = {
        "addon_id": addon_id if sidecar_addon_id is None else sidecar_addon_id,
        "files": sorted(_RUNTIME_FILES),
        "format": 1,
        "version": version if sidecar_version is None else sidecar_version,
        "zotero_min_version": "10.0",
        "zotero_max_version": "10.0.*",
    }
    path.with_name(path.name + ".manifest.json").write_text(
        json.dumps(inventory), encoding="utf-8"
    )
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    path.with_name(path.name + ".sha256").write_text(
        sha_text if sha_text is not None else f"{digest}  {path.name}\n",
        encoding="utf-8",
    )


def _packaged_manifest(path: Path) -> dict[str, object]:
    with zipfile.ZipFile(path) as archive:
        return json.loads(archive.read("manifest.json"))


def _corrupt_xpi_crc(path: Path, entry_name: str) -> None:
    payload = bytearray(path.read_bytes())
    entry_bytes = entry_name.encode("utf-8")
    for offset in range(len(payload) - 4):
        if payload[offset : offset + 4] != b"PK\x01\x02":
            continue
        name_length = struct.unpack_from("<H", payload, offset + 28)[0]
        name_start = offset + 46
        name_end = name_start + name_length
        if payload[name_start:name_end] == entry_bytes:
            struct.pack_into("<I", payload, offset + 16, 0)
            path.write_bytes(payload)
            return
    raise AssertionError(f"ZIP entry not found: {entry_name}")


def test_build_addon_injects_local_paths_and_writes_sidecars(tmp_path: Path) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    output = tmp_path / "dist" / f"zotero-research-{PACKAGE_VERSION}.xpi"

    result = build_addon(addon_dir=addon_dir, output=output)

    assert result.xpi_path == output.resolve()
    assert result.xpi_path.is_file()
    assert result.sha256_path == output.with_name(output.name + ".sha256")
    assert result.manifest_path == output.with_name(output.name + ".manifest.json")

    with zipfile.ZipFile(result.xpi_path) as archive:
        assert archive.namelist() == sorted([*_DIRECTORY_ENTRIES, *_RUNTIME_FILES])
        assert {info.date_time for info in archive.infolist()} == {(1980, 1, 1, 0, 0, 0)}
        assert {info.create_system for info in archive.infolist()} == {0}
        assert archive.read("manifest.json") == (addon_dir / "manifest.json").read_bytes()
        zipped_manifest = json.loads(archive.read("manifest.json"))
        assert (
            zipped_manifest["applications"]["zotero"]["update_url"]
            == "https://zotero-research.invalid/fixture-updates.json"
        )
        assert zipped_manifest["manifest_version"] == 2

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    assert result.sha256_path.read_text(encoding="utf-8") == f"{digest}  {output.name}\n"
    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert manifest == {
        "addon_id": "zotero-research@local.invalid",
        "files": sorted(_RUNTIME_FILES),
        "format": 1,
        "version": PACKAGE_VERSION,
        "zotero_min_version": "10.0",
        "zotero_max_version": "10.0.*",
    }



def test_item_pane_localization_messages_only_set_attributes() -> None:
    for relative_path in ("locale/en-US/zotero-research.ftl", "locale/zh-CN/zotero-research.ftl"):
        content = (REPO_ROOT / "addon" / relative_path).read_text(encoding="utf-8")
        assert "zotero-research-pane-header =\n" in content
        assert "zotero-research-pane-sidenav =\n" in content
        assert "zotero-research-pane-header = " not in content
        assert "zotero-research-pane-sidenav = " not in content


def test_build_addon_is_byte_for_byte_deterministic(tmp_path: Path) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    first_output = tmp_path / "first.xpi"
    second_output = tmp_path / "second.xpi"

    build_addon(addon_dir=addon_dir, output=first_output)
    build_addon(addon_dir=addon_dir, output=second_output)

    assert first_output.read_bytes() == second_output.read_bytes()


def test_build_addon_preserves_previous_release_and_sidecars(tmp_path: Path) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    output_dir = tmp_path / "dist"
    output_dir.mkdir()
    previous = {}
    for suffix in ("", ".sha256", ".manifest.json"):
        path = output_dir / f"zotero-research-previous-stable.xpi{suffix}"
        previous[path] = f"original previous release {suffix}".encode()
        path.write_bytes(previous[path])

    result = build_addon(
        addon_dir=addon_dir, output=output_dir / f"zotero-research-{PACKAGE_VERSION}.xpi"
    )

    assert result.xpi_path.is_file()
    for path, original in previous.items():
        assert path.read_bytes() == original


def test_build_addon_preserves_declared_main_update_url(tmp_path: Path) -> None:
    addon_dir, output = _valid_inputs(tmp_path)
    manifest_path = addon_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["applications"]["zotero"]["update_url"] = (
        "https://zotero-research.invalid/updates.json"
    )
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = build_addon(
        addon_dir=addon_dir,
        output=output,
    )

    with zipfile.ZipFile(result.xpi_path) as archive:
        packaged_manifest = json.loads(archive.read("manifest.json"))

    assert packaged_manifest["manifest_version"] == 2
    assert (
        packaged_manifest["applications"]["zotero"]["update_url"]
        == "https://zotero-research.invalid/updates.json"
    )


def test_build_addon_allows_omitted_update_url(tmp_path: Path) -> None:
    addon_dir, output = _valid_inputs(tmp_path)
    manifest_path = addon_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    del manifest["applications"]["zotero"]["update_url"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = build_addon(addon_dir=addon_dir, output=output)

    with zipfile.ZipFile(result.xpi_path) as archive:
        packaged_manifest = json.loads(archive.read("manifest.json"))
    assert "update_url" not in packaged_manifest["applications"]["zotero"]


def _valid_inputs(tmp_path: Path) -> tuple[Path, Path]:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    output = tmp_path / "dist" / "package.xpi"
    return addon_dir, output


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("manifest_version", 3, "manifest_version"),
        ("version", "0.3.1", "manifest version"),
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
    addon_dir, output = _valid_inputs(tmp_path)
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
            output=output,
        )


def test_build_addon_requires_exact_zotero_maximum_version(tmp_path: Path) -> None:
    addon_dir, output = _valid_inputs(tmp_path)
    manifest_path = addon_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    del manifest["applications"]["zotero"]["strict_max_version"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(PackageError, match="strict_max_version"):
        build_addon(
            addon_dir=addon_dir,
            output=output,
        )


@pytest.mark.parametrize(
    "missing",
    _RUNTIME_FILES,
)
def test_build_addon_requires_every_allowlisted_runtime_file(
    tmp_path: Path, missing: str
) -> None:
    addon_dir, output = _valid_inputs(tmp_path)
    (addon_dir / missing).unlink()

    with pytest.raises(PackageError, match="required addon runtime file is missing"):
        build_addon(
            addon_dir=addon_dir,
            output=output,
        )


def test_build_addon_rejects_sensitive_and_unlisted_files(tmp_path: Path) -> None:
    addon_dir, output = _valid_inputs(tmp_path)
    (addon_dir / ".env").write_text("TOKEN=not-for-packaging", encoding="utf-8")

    with pytest.raises(PackageError, match="sensitive file"):
        build_addon(
            addon_dir=addon_dir,
            output=output,
        )

    (addon_dir / ".env").unlink()
    node_module = addon_dir / "node_modules" / "package.js"
    node_module.parent.mkdir()
    node_module.write_text("unexpected", encoding="utf-8")
    with pytest.raises(PackageError, match="allowed addon runtime file"):
        build_addon(
            addon_dir=addon_dir,
            output=output,
        )


def test_build_addon_rejects_symlinks(tmp_path: Path) -> None:
    addon_dir, output = _valid_inputs(tmp_path)
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
            output=tmp_path / "package.xpi",
        )


def test_xpi_includes_locale_directories_for_jar_discovery(tmp_path: Path) -> None:
    addon_dir, output = _valid_inputs(tmp_path)
    result = build_addon(
        addon_dir=addon_dir,
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


def test_cli_defaults_are_repo_local_and_main_reports_outputs(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    addon_dir, output = _valid_inputs(tmp_path)
    arguments = build_argument_parser().parse_args([])
    assert arguments.addon_dir == REPO_ROOT / "addon"
    assert arguments.output == DEFAULT_OUTPUT

    assert (
        main(
            [
                "--addon-dir",
                str(addon_dir),
                "--output",
                str(output),
            ]
        )
        == 0
    )
    stdout = capsys.readouterr().out
    assert str(output.resolve()) in stdout


def test_build_addon_selects_highest_lower_manifest_version_not_mtime(tmp_path: Path) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    output_dir = tmp_path / "dist"
    output_dir.mkdir()
    older = output_dir / "arbitrary-old-name.xpi"
    nearer = output_dir / "arbitrary-near-name.xpi"
    same = output_dir / "zotero-research-same.xpi"
    future = output_dir / "zotero-research-future.xpi"
    unrelated = output_dir / "unrelated-addon.xpi"
    _write_release_package(older, "0.7.9")
    _write_release_package(nearer, "0.8.1")
    _write_release_package(same, PACKAGE_VERSION)
    _write_release_package(future, "0.8.3", sidecar_version="0.8.1")
    _write_release_package(
        unrelated,
        "0.8.1",
        addon_id="other@example.invalid",
        sidecar_addon_id="zotero-research@local.invalid",
    )

    now = time.time()
    os.utime(older, (now + 3, now + 3))
    os.utime(nearer, (now, now))
    os.utime(same, (now + 1, now + 1))
    os.utime(future, (now + 2, now + 2))
    os.utime(unrelated, (now + 4, now + 4))
    output = output_dir / f"zotero-research-{PACKAGE_VERSION}.xpi"

    build_addon(addon_dir=addon_dir, output=output)

    previous = output_dir / "zotero-research-previous-stable.xpi"
    previous_manifest = _packaged_manifest(previous)
    assert previous_manifest["version"] == "0.8.1"
    assert previous_manifest["applications"]["zotero"]["id"] == (
        "zotero-research@local.invalid"
    )
    previous_digest = hashlib.sha256(previous.read_bytes()).hexdigest()
    assert (output_dir / (previous.name + ".sha256")).read_text(encoding="utf-8") == (
        f"{previous_digest}  {previous.name}\n"
    )
    assert json.loads(
        (output_dir / (previous.name + ".manifest.json")).read_text(encoding="utf-8")
    )["addon_id"] == "zotero-research@local.invalid"


def test_build_addon_rebuilding_same_version_keeps_previous_lower_release(
    tmp_path: Path,
) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    output_dir = tmp_path / "dist"
    older = output_dir / "zotero-research-0.8.1.xpi"
    _write_release_package(older, "0.8.1")
    output = output_dir / f"zotero-research-{PACKAGE_VERSION}.xpi"

    build_addon(addon_dir=addon_dir, output=output)
    previous = output_dir / "zotero-research-previous-stable.xpi"
    first_previous = previous.read_bytes()
    first_sha = (output_dir / (previous.name + ".sha256")).read_bytes()
    first_manifest = (output_dir / (previous.name + ".manifest.json")).read_bytes()

    build_addon(addon_dir=addon_dir, output=output)

    assert previous.read_bytes() == first_previous
    assert (output_dir / (previous.name + ".sha256")).read_bytes() == first_sha
    assert (output_dir / (previous.name + ".manifest.json")).read_bytes() == first_manifest


def test_build_addon_prefers_valid_previous_slot_over_older_archive(
    tmp_path: Path,
) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    output_dir = tmp_path / "dist"
    previous = output_dir / "zotero-research-previous-stable.xpi"
    _write_release_package(previous, "0.8.1", payload_marker="-slot")
    _write_release_package(output_dir / "older.xpi", "0.8.0", payload_marker="-older")
    original_previous = previous.read_bytes()
    output = output_dir / f"zotero-research-{PACKAGE_VERSION}.xpi"

    build_addon(addon_dir=addon_dir, output=output)

    assert previous.read_bytes() == original_previous
    assert _packaged_manifest(previous)["version"] == "0.8.1"


def test_build_addon_prefers_existing_slot_for_same_version_tie(tmp_path: Path) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    output_dir = tmp_path / "dist"
    previous = output_dir / "zotero-research-previous-stable.xpi"
    same_version = output_dir / "other-0.8.1.xpi"
    _write_release_package(previous, "0.8.1", payload_marker="-slot")
    _write_release_package(same_version, "0.8.1", payload_marker="-other")
    original_previous = previous.read_bytes()
    output = output_dir / f"zotero-research-{PACKAGE_VERSION}.xpi"

    build_addon(addon_dir=addon_dir, output=output)

    assert previous.read_bytes() == original_previous


@pytest.mark.parametrize("corruption", ["crc", "duplicate"])
def test_build_addon_skips_corrupt_or_duplicate_release_candidates(
    tmp_path: Path, corruption: str
) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    output_dir = tmp_path / "dist"
    candidate = output_dir / "broken-0.8.1.xpi"
    _write_release_package(candidate, "0.8.1")
    if corruption == "crc":
        _corrupt_xpi_crc(candidate, "bootstrap.js")
    else:
        with zipfile.ZipFile(candidate, "a") as archive, pytest.warns(
            UserWarning, match="Duplicate name"
        ):
            archive.writestr("bootstrap.js", b"duplicate entry")
    output = output_dir / f"zotero-research-{PACKAGE_VERSION}.xpi"

    build_addon(addon_dir=addon_dir, output=output)

    assert not (output_dir / "zotero-research-previous-stable.xpi").exists()


def test_build_addon_restores_outputs_when_sidecar_write_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    addon_dir, output = _valid_inputs(tmp_path)
    result = build_addon(addon_dir=addon_dir, output=output)
    originals = {
        result.xpi_path: result.xpi_path.read_bytes(),
        result.sha256_path: result.sha256_path.read_bytes(),
        result.manifest_path: result.manifest_path.read_bytes(),
    }
    (addon_dir / "content" / "panel.js").write_text("// changed\n", encoding="utf-8")
    build_module = importlib.import_module("scripts.build_addon")
    real_write_text = build_module._write_text_atomically

    def fail_manifest_write(path: Path, text: str) -> None:
        if path == result.manifest_path:
            raise OSError("simulated manifest sidecar failure")
        real_write_text(path, text)

    monkeypatch.setattr(build_module, "_write_text_atomically", fail_manifest_write)
    with pytest.raises(OSError, match="simulated manifest sidecar failure"):
        build_addon(addon_dir=addon_dir, output=output)

    for path, content in originals.items():
        assert path.read_bytes() == content


@pytest.mark.parametrize("include_sidecars", [False, True])
def test_build_addon_rebuilds_rollback_sidecars_from_package(
    tmp_path: Path, include_sidecars: bool
) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    output_dir = tmp_path / "dist"
    older = output_dir / "zotero-research-0.8.1.xpi"
    _write_release_package(older, "0.8.1", include_sidecars=include_sidecars)
    if include_sidecars:
        (output_dir / (older.name + ".manifest.json")).write_text(
            json.dumps({"addon_id": "stale@example.invalid", "version": "0.1.0"}),
            encoding="utf-8",
        )
        (output_dir / (older.name + ".sha256")).write_text(
            "0" * 64 + "  stale-name.xpi\n", encoding="utf-8"
        )
    output = output_dir / f"zotero-research-{PACKAGE_VERSION}.xpi"

    build_addon(addon_dir=addon_dir, output=output)

    previous = output_dir / "zotero-research-previous-stable.xpi"
    previous_sha = output_dir / (previous.name + ".sha256")
    previous_manifest = output_dir / (previous.name + ".manifest.json")
    digest = hashlib.sha256(previous.read_bytes()).hexdigest()
    assert previous_sha.read_text(encoding="utf-8") == f"{digest}  {previous.name}\n"
    assert json.loads(previous_manifest.read_text(encoding="utf-8")) == {
        "addon_id": "zotero-research@local.invalid",
        "files": sorted(_RUNTIME_FILES),
        "format": 1,
        "version": "0.8.1",
        "zotero_min_version": "10.0",
        "zotero_max_version": "10.0.*",
    }


def test_build_addon_without_lower_candidate_preserves_existing_rollback(
    tmp_path: Path,
) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    output_dir = tmp_path / "dist"
    output_dir.mkdir()
    previous = output_dir / "zotero-research-previous-stable.xpi"
    previous_sha = output_dir / (previous.name + ".sha256")
    previous_manifest = output_dir / (previous.name + ".manifest.json")
    originals = {
        previous: b"existing rollback package",
        previous_sha: b"existing rollback sha\n",
        previous_manifest: b"existing rollback manifest\n",
    }
    for path, content in originals.items():
        path.write_bytes(content)
    _write_release_package(output_dir / "future.xpi", "0.8.3")
    _write_release_package(
        output_dir / "unrelated.xpi", "0.8.1", addon_id="other@example.invalid"
    )
    (output_dir / "broken.xpi").write_bytes(b"not a zip archive")
    output = output_dir / f"zotero-research-{PACKAGE_VERSION}.xpi"

    build_addon(addon_dir=addon_dir, output=output)

    for path, content in originals.items():
        assert path.read_bytes() == content


def test_build_addon_does_not_promote_when_xpi_build_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    output_dir = tmp_path / "dist"
    output_dir.mkdir()
    previous = output_dir / "zotero-research-previous-stable.xpi"
    previous.write_bytes(b"existing rollback package")
    (output_dir / (previous.name + ".sha256")).write_bytes(b"existing rollback sha")
    (output_dir / (previous.name + ".manifest.json")).write_bytes(
        b"existing rollback manifest"
    )
    _write_release_package(output_dir / "older.xpi", "0.8.1")
    output = output_dir / f"zotero-research-{PACKAGE_VERSION}.xpi"

    def fail_xpi_build(*_args: object, **_kwargs: object) -> None:
        raise OSError("simulated xpi build failure")

    monkeypatch.setattr("scripts.build_addon._write_xpi_atomically", fail_xpi_build)

    with pytest.raises(OSError, match="simulated xpi build failure"):
        build_addon(addon_dir=addon_dir, output=output)

    assert previous.read_bytes() == b"existing rollback package"
    assert (output_dir / (previous.name + ".sha256")).read_bytes() == b"existing rollback sha"
    assert (output_dir / (previous.name + ".manifest.json")).read_bytes() == (
        b"existing rollback manifest"
    )


def test_build_addon_promotes_nothing_without_a_previous_package(tmp_path: Path) -> None:
    addon_dir = tmp_path / "addon"
    _make_addon_tree(addon_dir)
    output_dir = tmp_path / "dist"
    output_dir.mkdir()

    build_addon(addon_dir=addon_dir, output=output_dir / f"zotero-research-{PACKAGE_VERSION}.xpi")

    assert not (output_dir / "zotero-research-previous-stable.xpi").exists()
