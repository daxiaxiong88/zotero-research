"""Build a deterministic, safety-checked Zotero XPI with the Python stdlib."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import tempfile
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_VERSION = "0.8.3"
EXPECTED_ADDON_ID = "zotero-research@local.invalid"
EXPECTED_ZOTERO_MIN_VERSION = "10.0"
EXPECTED_ZOTERO_MAX_VERSION = "10.0.*"
DEFAULT_OUTPUT = REPO_ROOT / "dist" / f"zotero-research-{PACKAGE_VERSION}.xpi"
_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
# Rollback copy kept next to the release: the highest valid package version
# below the build being produced, so a bad release can be undone without
# rebuilding from an older checkout.
PREVIOUS_STABLE_NAME = "zotero-research-previous-stable.xpi"

ALLOWED_RUNTIME_FILES = frozenset(
    {
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
    }
)
REQUIRED_RUNTIME_FILES = ALLOWED_RUNTIME_FILES
_DIRECTORY_ENTRIES = (
    "content/",
    "locale/",
    "locale/en-US/",
    "locale/zh-CN/",
)
_SENSITIVE_SUFFIXES = frozenset(
    {".crt", ".db", ".der", ".jks", ".key", ".pem", ".pfx", ".p12", ".secret", ".sqlite"}
)
_SENSITIVE_NAMES = frozenset(
    {"credentials.json", "secrets.json", "token.json", "auth.json", "config.local.json"}
)
_SENSITIVE_CONFIG_KEY_PARTS = (
    "accesskey",
    "apikey",
    "credential",
    "password",
    "privatekey",
    "secret",
    "token",
)
_SECRET_VALUE_PREFIXES = ("AKIA", "ghp_", "sk-", "xoxb-")


class PackageError(ValueError):
    """Raised when an addon tree cannot be packaged safely."""


@dataclass(frozen=True)
class PackageResult:
    """Paths emitted by one package build."""

    xpi_path: Path
    sha256_path: Path
    manifest_path: Path


@dataclass(frozen=True)
class _ReleaseCandidate:
    """A validated release snapshot eligible for rollback promotion."""

    path: Path
    payload: bytes
    inventory: dict[str, Any]
    version_key: tuple[int, ...]


def build_addon(
    *,
    addon_dir: Path | str | None = None,
    output: Path | str | None = None,
) -> PackageResult:
    """Validate the addon tree and build one deterministic XPI."""

    source_input = Path(addon_dir or REPO_ROOT / "addon").expanduser()
    if source_input.is_symlink():
        raise PackageError("addon directory must not be a symlink")
    source_dir = _resolve_directory(source_input, "addon directory")
    output_path = _resolve_output(output or DEFAULT_OUTPUT)
    if _is_relative_to(output_path, source_dir):
        raise PackageError("output must not be inside addon directory")

    source_files = _validate_addon_tree(source_dir)
    manifest = _read_manifest(source_dir / "manifest.json")

    file_bytes = {
        relative_path: (source_dir / Path(relative_path)).read_bytes()
        for relative_path in source_files
    }
    target_version = manifest["version"]
    assert isinstance(target_version, str)
    candidate = _select_previous_release(output_path, target_version)
    sha256_path = output_path.with_name(output_path.name + ".sha256")
    manifest_path = output_path.with_name(output_path.name + ".manifest.json")
    original_artifacts = _snapshot_artifacts((output_path, sha256_path, manifest_path))
    try:
        _write_xpi_atomically(output_path, file_bytes)

        digest = hashlib.sha256(output_path.read_bytes()).hexdigest()
        _write_text_atomically(sha256_path, f"{digest}  {output_path.name}\n")

        inventory = _inventory_for_manifest(manifest, file_bytes)
        _write_text_atomically(manifest_path, _json_text(inventory))
    except Exception:
        _restore_artifacts(original_artifacts)
        raise
    if candidate is not None:
        _promote_previous_release(output_path, candidate)
    return PackageResult(
        xpi_path=output_path,
        sha256_path=sha256_path,
        manifest_path=manifest_path,
    )


def _promote_previous_release(
    output_path: Path, candidate: _ReleaseCandidate | None = None
) -> Path | None:
    """Commit a validated release snapshot to the rollback slot.

    The package manifest is authoritative. Candidate sidecars are never
    copied: the digest and inventory are regenerated from the package bytes so
    missing or stale sidecars cannot describe the wrong rollback artifact.
    """

    if candidate is None:
        candidate = _select_previous_release(output_path, PACKAGE_VERSION)
    if candidate is None:
        return None

    previous = output_path.parent / PREVIOUS_STABLE_NAME
    digest = hashlib.sha256(candidate.payload).hexdigest()
    artifacts = {
        previous: candidate.payload,
        previous.with_name(previous.name + ".sha256"):
        f"{digest}  {previous.name}\n".encode(),
        previous.with_name(previous.name + ".manifest.json"):
        _json_bytes(candidate.inventory),
    }
    _replace_artifacts_with_restore(artifacts)
    return previous


def _select_previous_release(output_path: Path, target_version: str) -> _ReleaseCandidate | None:
    """Find the highest valid release below ``target_version``.

    File names, mtimes, and sidecars are not release identity. Each XPI,
    including an existing rollback slot, is inspected directly; only a
    package with the expected addon id and a numerically lower manifest
    version can be selected.
    """

    target_key = _version_key(target_version)
    if target_key is None:
        raise PackageError(f"manifest version is not a comparable release: {target_version!r}")
    output_dir = output_path.parent
    if not output_dir.is_dir():
        return None

    candidates: list[_ReleaseCandidate] = []
    candidate_paths = [
        output_dir / PREVIOUS_STABLE_NAME,
        *sorted(output_dir.glob("*.xpi"), key=lambda value: value.name),
    ]
    seen_paths: set[Path] = set()
    for path in candidate_paths:
        if (
            path in seen_paths
            or not path.is_file()
            or path.is_symlink()
        ):
            continue
        seen_paths.add(path)
        candidate = _inspect_release(path)
        if candidate is None or candidate.version_key >= target_key:
            continue
        candidates.append(candidate)
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda value: (
            value.version_key,
            value.path.name == PREVIOUS_STABLE_NAME,
            value.path.name,
        ),
    )


def _inspect_release(path: Path) -> _ReleaseCandidate | None:
    """Read candidate identity from the XPI, tolerating bad sidecars."""

    try:
        payload = path.read_bytes()
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                return None
            if archive.testzip() is not None:
                return None
            manifest_infos = [info for info in infos if info.filename == "manifest.json"]
            if len(manifest_infos) != 1:
                return None
            manifest = json.loads(archive.read(manifest_infos[0]).decode("utf-8"))
            files = [info.filename for info in infos if not info.is_dir()]
    except (
        OSError,
        UnicodeDecodeError,
        ValueError,
        KeyError,
        RuntimeError,
        zipfile.BadZipFile,
    ):
        return None

    if not isinstance(manifest, dict) or manifest.get("manifest_version") != 2:
        return None
    version = manifest.get("version")
    version_key = _version_key(version)
    if version_key is None:
        return None
    try:
        addon_id = _zotero_manifest(manifest).get("id")
    except (AssertionError, KeyError, TypeError):
        return None
    if addon_id != EXPECTED_ADDON_ID:
        return None
    return _ReleaseCandidate(
        path=path,
        payload=payload,
        inventory=_inventory_for_manifest(manifest, files),
        version_key=version_key,
    )


def _version_key(version: Any) -> tuple[int, ...] | None:
    if not isinstance(version, str) or not version or version != version.strip():
        return None
    parts = version.split(".")
    if not parts or any(not part.isdecimal() for part in parts):
        return None
    key = tuple(int(part) for part in parts)
    while len(key) > 1 and key[-1] == 0:
        key = key[:-1]
    return key


def _resolve_directory(value: Path | str, description: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise PackageError(f"{description} must be an absolute local path: {path}")
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise PackageError(f"{description} does not exist: {path}") from exc
    if not resolved.is_dir():
        raise PackageError(f"{description} is not a directory: {resolved}")
    return resolved


def _resolve_output(value: Path | str) -> Path:
    path = Path(value).expanduser()
    if path.suffix.lower() != ".xpi":
        raise PackageError(f"output must have an .xpi suffix: {path}")
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path.resolve()


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _validate_addon_tree(addon_dir: Path) -> list[str]:
    files: list[str] = []
    for root, directory_names, file_names in os.walk(addon_dir, followlinks=False):
        root_path = Path(root)
        for name in directory_names:
            directory = root_path / name
            if directory.is_symlink():
                raise PackageError(f"symlink is not allowed in addon tree: {directory}")
        for name in file_names:
            file_path = root_path / name
            if file_path.is_symlink():
                raise PackageError(f"symlink is not allowed in addon tree: {file_path}")
            relative_path = file_path.relative_to(addon_dir).as_posix()
            if _is_sensitive_path(relative_path):
                raise PackageError(f"sensitive file is not allowed in addon tree: {relative_path}")
            if relative_path not in ALLOWED_RUNTIME_FILES:
                raise PackageError(f"file is not an allowed addon runtime file: {relative_path}")
            if not file_path.is_file():
                raise PackageError(f"addon runtime path is not a regular file: {relative_path}")
            files.append(relative_path)

    missing = sorted(REQUIRED_RUNTIME_FILES.difference(files))
    if missing:
        raise PackageError(f"required addon runtime file is missing: {', '.join(missing)}")
    return sorted(files)


def _is_sensitive_path(relative_path: str) -> bool:
    path = Path(relative_path)
    name = path.name.lower()
    return (
        name.startswith(".env")
        or name in _SENSITIVE_NAMES
        or path.suffix.lower() in _SENSITIVE_SUFFIXES
    )


def _read_json_object(path: Path, description: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackageError(f"{description} must be valid UTF-8 JSON: {path.name}") from exc
    if not isinstance(payload, dict):
        raise PackageError(f"{description} must be a JSON object: {path.name}")
    return payload


def _read_manifest(path: Path) -> dict[str, Any]:
    manifest = _read_json_object(path, "manifest.json")
    if manifest.get("manifest_version") != 2:
        raise PackageError("manifest_version must be 2")
    version = manifest.get("version")
    if version != PACKAGE_VERSION:
        raise PackageError(
            f"manifest version must be {PACKAGE_VERSION!r}, got {version!r}"
        )
    applications = manifest.get("applications")
    if not isinstance(applications, dict):
        raise PackageError("manifest must declare applications.zotero")
    zotero = applications.get("zotero")
    if not isinstance(zotero, dict):
        raise PackageError("manifest must declare applications.zotero")
    addon_id = zotero.get("id")
    if not _is_nonempty_text(addon_id):
        raise PackageError("manifest applications.zotero.id must be a non-empty string")
    if addon_id != EXPECTED_ADDON_ID:
        raise PackageError(
            "manifest applications.zotero.id must be "
            f"{EXPECTED_ADDON_ID!r}, got {addon_id!r}"
        )
    minimum = zotero.get("strict_min_version")
    if minimum != EXPECTED_ZOTERO_MIN_VERSION:
        raise PackageError(
            "manifest applications.zotero.strict_min_version must be "
            f"{EXPECTED_ZOTERO_MIN_VERSION!r}, got {minimum!r}"
        )
    maximum = zotero.get("strict_max_version")
    if maximum != EXPECTED_ZOTERO_MAX_VERSION:
        raise PackageError(
            "manifest applications.zotero.strict_max_version must be "
            f"{EXPECTED_ZOTERO_MAX_VERSION!r}, got {maximum!r}"
        )
    if "update_url" in zotero and not _is_nonempty_text(zotero["update_url"]):
        raise PackageError(
            "manifest applications.zotero.update_url must be a non-empty string"
        )
    return manifest


def _is_nonempty_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and not any(
        character in value for character in "\r\n\x00"
    )


def _zotero_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    applications = manifest["applications"]
    assert isinstance(applications, dict)
    zotero = applications["zotero"]
    assert isinstance(zotero, dict)
    return zotero


def _zotero_id(manifest: dict[str, Any]) -> str:
    value = _zotero_manifest(manifest)["id"]
    assert isinstance(value, str)
    return value


def _zotero_min_version(manifest: dict[str, Any]) -> str:
    value = _zotero_manifest(manifest)["strict_min_version"]
    assert isinstance(value, str)
    return value


def _zotero_max_version(manifest: dict[str, Any]) -> str:
    value = _zotero_manifest(manifest)["strict_max_version"]
    assert isinstance(value, str)
    return value


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def _json_bytes(value: Any) -> bytes:
    return _json_text(value).encode("utf-8")


def _inventory_for_manifest(
    manifest: dict[str, Any], files: Sequence[str]
) -> dict[str, Any]:
    zotero = _zotero_manifest(manifest)
    inventory: dict[str, Any] = {
        "addon_id": _zotero_id(manifest),
        "files": sorted(files),
        "format": 1,
        "version": manifest["version"],
    }
    for manifest_key, inventory_key in (
        ("strict_min_version", "zotero_min_version"),
        ("strict_max_version", "zotero_max_version"),
    ):
        value = zotero.get(manifest_key)
        if isinstance(value, str):
            inventory[inventory_key] = value
    return inventory


def _replace_artifacts_with_restore(artifacts: dict[Path, bytes]) -> None:
    original_artifacts = _snapshot_artifacts(artifacts)
    temporary_paths: list[tuple[Path, Path]] = []
    try:
        for target, payload in artifacts.items():
            temporary_path = _temporary_path(target)
            temporary_path.write_bytes(payload)
            temporary_paths.append((target, temporary_path))
        for target, temporary_path in temporary_paths:
            os.replace(temporary_path, target)
    except Exception:
        with contextlib.suppress(Exception):
            _restore_artifacts(original_artifacts)
        raise
    finally:
        for _target, temporary_path in temporary_paths:
            temporary_path.unlink(missing_ok=True)


def _snapshot_artifacts(paths: Sequence[Path]) -> dict[Path, bytes | None]:
    return {path: path.read_bytes() if path.is_file() else None for path in paths}


def _write_bytes_atomically(path: Path, payload: bytes) -> None:
    temporary_path = _temporary_path(path)
    try:
        temporary_path.write_bytes(payload)
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _restore_artifacts(snapshot: dict[Path, bytes | None]) -> None:
    for path, payload in snapshot.items():
        if payload is None:
            path.unlink(missing_ok=True)
    existing = {path: payload for path, payload in snapshot.items() if payload is not None}
    for path, payload in existing.items():
        assert payload is not None
        _write_bytes_atomically(path, payload)


def _write_xpi_atomically(output: Path, files: dict[str, bytes]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = _temporary_path(output)
    try:
        with zipfile.ZipFile(temporary_path, "w", compression=zipfile.ZIP_STORED) as archive:
            for relative_path in sorted((*_DIRECTORY_ENTRIES, *files)):
                info = zipfile.ZipInfo(relative_path, date_time=_ZIP_TIMESTAMP)
                info.compress_type = zipfile.ZIP_STORED
                info.create_system = 0
                if relative_path.endswith("/"):
                    info.external_attr = (0o40755 << 16) | 0x10
                    archive.writestr(info, b"")
                else:
                    info.external_attr = 0o100644 << 16
                    archive.writestr(info, files[relative_path])
        os.replace(temporary_path, output)
    finally:
        temporary_path.unlink(missing_ok=True)


def _write_text_atomically(path: Path, text: str) -> None:
    temporary_path = _temporary_path(path)
    try:
        temporary_path.write_text(text, encoding="utf-8", newline="\n")
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _temporary_path(target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    os.close(file_descriptor)
    return Path(name)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--addon-dir",
        type=Path,
        default=REPO_ROOT / "addon",
        help="addon source directory (default: repo/addon)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"XPI output path (default: dist/zotero-research-{PACKAGE_VERSION}.xpi)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    arguments = parser.parse_args(argv)
    try:
        result = build_addon(
            addon_dir=arguments.addon_dir,
            output=arguments.output,
        )
    except PackageError as exc:
        parser.error(str(exc))
    print(f"Created {result.xpi_path}")
    print(f"SHA-256 {result.sha256_path}")
    print(f"Manifest {result.manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
