"""Build a deterministic, safety-checked Zotero XPI with the Python stdlib."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_VERSION = "0.4.7"
EXPECTED_ADDON_ID = "zotero-research@local.invalid"
EXPECTED_ZOTERO_MIN_VERSION = "10.0"
EXPECTED_ZOTERO_MAX_VERSION = "10.0.*"
DEFAULT_OUTPUT = REPO_ROOT / "dist" / f"zotero-research-{PACKAGE_VERSION}.xpi"
_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)

ALLOWED_RUNTIME_FILES = frozenset(
    {
        "manifest.json",
        "bootstrap.js",
        "prefs.js",
        "content/native.js",
        "content/relay.js",
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
    _write_xpi_atomically(output_path, file_bytes)

    digest = hashlib.sha256(output_path.read_bytes()).hexdigest()
    sha256_path = output_path.with_name(output_path.name + ".sha256")
    _write_text_atomically(sha256_path, f"{digest}  {output_path.name}\n")

    manifest_path = output_path.with_name(output_path.name + ".manifest.json")
    inventory = {
        "addon_id": _zotero_id(manifest),
        "files": sorted(file_bytes),
        "format": 1,
        "version": manifest["version"],
        "zotero_min_version": _zotero_min_version(manifest),
        "zotero_max_version": _zotero_max_version(manifest),
    }
    _write_text_atomically(manifest_path, _json_text(inventory))
    return PackageResult(
        xpi_path=output_path,
        sha256_path=sha256_path,
        manifest_path=manifest_path,
    )


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
    update_url = zotero.get("update_url")
    if not _is_nonempty_text(update_url):
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
        help="XPI output path (default: dist/zotero-research-0.4.6.xpi)",
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
