from __future__ import annotations

import hashlib
import importlib
import json
import re
from pathlib import Path

import pytest

from scripts.build_addon import build_addon

ROOT = Path(__file__).resolve().parents[1]
REPO = 'https://github.com/daxiaxiong88/zotero-research'


def test_built_release_can_be_discovered_by_native_and_userscript_updaters(tmp_path: Path) -> None:
    source = ROOT / 'scripts/build_release_metadata.py'
    assert source.is_file(), 'Release metadata generator is missing'
    module = importlib.import_module('scripts.build_release_metadata')
    package = build_addon(output=tmp_path / 'release.xpi')
    update_path, meta_path = module.build_metadata(package.xpi_path, tmp_path)
    feed = json.loads(update_path.read_text(encoding='utf-8'))
    addon = json.loads((ROOT / 'addon/manifest.json').read_text(encoding='utf-8'))
    update = feed['addons'][addon['applications']['zotero']['id']]['updates'][0]
    assert update['version'] == addon['version']
    digest = hashlib.sha256(package.xpi_path.read_bytes()).hexdigest()
    assert update['update_hash'] == 'sha256:' + digest
    assert update['update_link'] == (
        f"{REPO}/releases/download/v{addon['version']}/zotero-research-{addon['version']}.xpi"
    )
    assert update['applications']['zotero']['strict_max_version'] == '10.0.*'
    assert addon['applications']['zotero']['update_url'] == 'https://raw.githubusercontent.com/daxiaxiong88/zotero-research/main/updates.json'
    meta = meta_path.read_text(encoding='utf-8')
    script = (ROOT / 'userscripts/zotero-research-webai.user.js').read_text(encoding='utf-8')
    assert meta.strip() == script.split('// ==/UserScript==')[0].strip() + '\n// ==/UserScript=='
    assert re.search(r'@version\s+' + re.escape(feed['userscript']['version']) + r'\s', meta)
    assert f'@updateURL    {REPO}/releases/latest/download/zotero-research-webai.meta.js' in meta
    assert f'@downloadURL  {REPO}/releases/latest/download/zotero-research-webai.user.js' in meta


def test_metadata_check_detects_stale_feed_and_package(tmp_path: Path) -> None:
    module = importlib.import_module('scripts.build_release_metadata')
    package = build_addon(output=tmp_path / 'release.xpi')
    update_path, _ = module.build_metadata(package.xpi_path, tmp_path)
    module.build_metadata(package.xpi_path, tmp_path, check=True)
    update_path.write_text('{}', encoding='utf-8')
    with pytest.raises(ValueError, match='stale'):
        module.build_metadata(package.xpi_path, tmp_path, check=True)


def test_checked_in_update_feed_and_meta_advertise_the_current_release() -> None:
    feed = json.loads((ROOT / 'updates.json').read_text(encoding='utf-8'))
    manifest = json.loads((ROOT / 'addon/manifest.json').read_text(encoding='utf-8'))
    version = manifest['version']
    addon_id = manifest['applications']['zotero']['id']
    assert feed['addons'][addon_id]['updates'][0]['version'] == version
    assert feed['userscript']['release'] == version
    script = (ROOT / 'userscripts/zotero-research-webai.user.js').read_text(encoding='utf-8')
    meta = (ROOT / 'userscripts/zotero-research-webai.meta.js').read_text(encoding='utf-8')
    assert meta.strip() == script.split('// ==/UserScript==')[0].strip() + '\n// ==/UserScript=='
    assert re.search(r'@version\s+' + re.escape(feed['userscript']['version']) + r'\s', meta)
