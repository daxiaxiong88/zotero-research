"""Generate the public update feed from a built XPI, never a guessed hash."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "https://github.com/daxiaxiong88/zotero-research"


def metadata_contents(xpi_path: Path) -> tuple[str, str]:
    manifest = json.loads((ROOT / "addon/manifest.json").read_text(encoding="utf-8"))
    with zipfile.ZipFile(xpi_path) as archive:
        if json.loads(archive.read("manifest.json")) != manifest:
            raise ValueError("XPI manifest does not match the current release")
        for name in archive.namelist():
            if not name.endswith("/") and (
                archive.read(name) != (ROOT / "addon" / name).read_bytes()
            ):
                raise ValueError(f"XPI source is stale: {name}")
    script = (ROOT / "userscripts/zotero-research-webai.user.js").read_text(encoding="utf-8")
    header = script.split("// ==/UserScript==", 1)[0] + "// ==/UserScript==\n"
    script_version = re.search(r"^// @version\s+(\S+)", header, re.MULTILINE)
    if not script_version or not re.fullmatch(r"\d+(?:\.\d+){1,3}", script_version[1]):
        raise ValueError("Missing stable userscript version")
    version = manifest["version"]
    zotero = manifest["applications"]["zotero"]
    feed = {
        "addons": {
            zotero["id"]: {
                "updates": [{
                    "version": version,
                    "update_link": (
                        f"{REPOSITORY}/releases/download/v{version}/zotero-research-{version}.xpi"
                    ),
                    "update_hash": "sha256:" + hashlib.sha256(xpi_path.read_bytes()).hexdigest(),
                    "update_info_url": f"{REPOSITORY}/releases/tag/v{version}",
                    "applications": {"zotero": {
                        "strict_min_version": zotero["strict_min_version"],
                        "strict_max_version": zotero["strict_max_version"],
                    }},
                }],
            },
        },
        "userscript": {"version": script_version[1], "release": version},
    }
    return json.dumps(feed, ensure_ascii=False, indent=2) + "\n", header


def build_metadata(xpi_path: Path, output: Path, *, check: bool = False) -> tuple[Path, Path]:
    feed, header = metadata_contents(xpi_path)
    update_path = output / "updates.json"
    meta_path = output / "userscripts/zotero-research-webai.meta.js"
    for path, content in ((update_path, feed), (meta_path, header)):
        if check:
            if not path.is_file() or path.read_text(encoding="utf-8") != content:
                raise ValueError(f"Release metadata is stale: {path}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
    return update_path, meta_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    current = json.loads((ROOT / "addon/manifest.json").read_text(encoding="utf-8"))["version"]
    parser.add_argument("--xpi", type=Path, default=ROOT / f"dist/zotero-research-{current}.xpi")
    parser.add_argument("--output", type=Path, default=ROOT)
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    for result in build_metadata(arguments.xpi, arguments.output, check=arguments.check):
        print(result)
