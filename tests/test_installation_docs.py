from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlparse

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "https://github.com/daxiaxiong88/zotero-research"
ADDON_VERSION = json.loads((ROOT / "addon/manifest.json").read_text(encoding="utf-8"))["version"]
SCRIPT_HEADER = (ROOT / "userscripts/zotero-research-webai.user.js").read_text(encoding="utf-8")
SCRIPT_VERSION = re.findall(r"^// @version\s+(\S+)", SCRIPT_HEADER, re.MULTILINE)[0]
INSTALLATION_DOCS = ("README.md", "docs/USAGE_ZOTERO10.md")


@pytest.mark.parametrize("document", INSTALLATION_DOCS)
def test_installation_docs_only_describe_current_versions(document: str) -> None:
    text = (ROOT / document).read_text(encoding="utf-8")
    versions = set(re.findall(r"(?<![\d.])\d+\.\d+\.\d+(?![\d.])", text))
    assert versions == {ADDON_VERSION, SCRIPT_VERSION}
    assert "候选版" not in text


@pytest.mark.parametrize("document", INSTALLATION_DOCS)
def test_installation_links_use_current_release_and_existing_local_files(document: str) -> None:
    path = ROOT / document
    links = re.findall(r"\[[^\]]*\]\(([^)\s]+)\)", path.read_text(encoding="utf-8"))
    for link in links:
        url = urlparse(link)
        if not url.scheme and url.path:
            assert (path.parent / url.path).is_file(), link
        if "zotero-research" not in url.path or url.netloc != "github.com":
            continue
        assert link.startswith(REPOSITORY + "/"), link
        if "/releases/" in url.path:
            assert link in {
                REPOSITORY + "/releases/latest",
                f"{REPOSITORY}/releases/tag/v{ADDON_VERSION}",
            } or link.startswith(f"{REPOSITORY}/releases/download/v{ADDON_VERSION}/"), link


def test_readme_offers_matching_release_assets_not_development_script() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    release = f"{REPOSITORY}/releases/download/v{ADDON_VERSION}/"
    assert release + f"zotero-research-{ADDON_VERSION}.xpi" in readme
    assert release + "zotero-research-webai.user.js" in readme
    assert "/raw/" not in readme
    assert "RELEASE_AUDIT.md" not in readme
