/* Shared release discovery. Native installation remains Zotero's responsibility. */
(function attachReleaseUpdates(global) {
  'use strict';
  const REPO = 'https://github.com/daxiaxiong88/zotero-research';
  const URL = 'https://raw.githubusercontent.com/daxiaxiong88/zotero-research/main/updates.json';
  const validVersion = value => typeof value === 'string' && /^\d+(?:\.\d+){1,3}$/.test(value);
  function compare(a, b) {
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if ((left[i] || 0) !== (right[i] || 0)) { return (left[i] || 0) - (right[i] || 0); }
    }
    return 0;
  }
  function available(catalog, options) {
    if (!validVersion(options.currentVersion)) { throw new Error('Unknown installed version'); }
    if (options.kind === 'userscript') {
      const item = catalog?.userscript;
      if (!validVersion(item?.version) || !validVersion(item?.release)) { throw new Error('Invalid script release'); }
      return compare(item.version, options.currentVersion) > 0 ? {
        version: item.version, url: REPO + '/releases/download/v' + item.release + '/zotero-research-webai.user.js',
        notesUrl: REPO + '/releases/tag/v' + item.release,
      } : null;
    }
    const items = catalog?.addons?.['zotero-research@local.invalid']?.updates;
    if (!Array.isArray(items) || !items.length) { throw new Error('Invalid addon release'); }
    const candidates = items.filter(item => {
      if (!validVersion(item.version)
        || item.update_link !== REPO + '/releases/download/v' + item.version + '/zotero-research-' + item.version + '.xpi') {
        throw new Error('Invalid addon download');
      }
      return compare(item.version, options.currentVersion) > 0 && (!options.compatible || options.compatible(item));
    }).sort((a, b) => compare(b.version, a.version));
    return candidates.length ? {
      version: candidates[0].version, url: candidates[0].update_link,
      notesUrl: REPO + '/releases/tag/v' + candidates[0].version,
    } : null;
  }
  function createChecker(options) {
    let memory = {}, pending = null;
    const now = options.now || Date.now;
    function read() {
      try {
        const raw = options.readState();
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (value && typeof value === 'object' && !Array.isArray(value)) { memory = value; }
      } catch (_) { /* memory-only fallback */ }
      return memory;
    }
    function write(value) { memory = value; try { options.writeState(value); } catch (_) { /* checking must not block reading */ } }
    function result(force) {
      const saved = read();
      if (saved.error) { return { status: 'unavailable' }; }
      try {
        const release = available(saved.catalog, options);
        return release ? { status: 'available', ...release, notify: force || saved.notified !== release.version }
          : { status: 'current' };
      } catch (_) { return { status: 'unavailable' }; }
    }
    return {
      check(force = false) {
        if (pending) { return pending.then(() => result(force)); }
        if (!force && Number(read().nextCheckAt) > now()) { return Promise.resolve(result(false)); }
        write({ ...read(), nextCheckAt: now() + 3600000 });
        pending = (async () => {
          try {
            const catalog = await options.fetchCatalog(URL);
            available(catalog, options);
            write({ ...read(), catalog, error: false, nextCheckAt: now() + 86400000 });
          } catch (_) { write({ ...read(), error: true }); }
        })().finally(() => { pending = null; });
        return pending.then(() => result(force));
      },
      markNotified(version) { write({ ...read(), notified: version }); },
    };
  }
  function showNotice(host, release, options = {}) {
    const doc = host.ownerDocument;
    const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    shadow.replaceChildren(); host.hidden = false;
    const make = (tag, text) => {
      const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag);
      if (text) { node.textContent = text; } return node;
    };
    const css = make('style', `
      :host { display:block; color:#25232b; font:13px/1.5 system-ui,sans-serif; margin:8px 0; }
      :host([hidden]) { display:none!important; }
      :host([data-floating]) { position:fixed; top:16px; right:48px; width:320px; max-width:calc(100vw - 64px); z-index:2147483646; }
      section { background:#f8f6ff; padding:12px; border:1px solid #c6bfea; border-radius:8px; box-shadow:0 3px 14px #0002; }
      p { margin:5px 0; } a { color:#5842b0; margin-right:14px; } button { float:right; border:0; color:inherit; background:transparent; cursor:pointer; font:inherit; }
      @media (prefers-color-scheme:dark) { section { background:#26232e; color:#eee; } a { color:#c5b8ff; } }
    `);
    const card = make('section'); card.setAttribute('role', 'status');
    const close = make('button', '×'); close.type = 'button'; close.setAttribute('aria-label', '稍后更新');
    close.addEventListener('click', () => { host.hidden = true; });
    card.append(close, make('strong', '发现新版本 ' + release.version));
    card.append(make('p', options.kind === 'addon'
      ? '科研助手可更新。也可在“工具 → 插件”中检查更新。'
      : 'Zotero 网页连接脚本可更新。安装后刷新 AI 网页即可，无需清空对话。'));
    for (const [label, href] of [['下载更新', release.url], ['更新说明', release.notesUrl]]) {
      const link = make('a', label); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      if (options.open) { link.addEventListener('click', event => { event.preventDefault(); options.open(href); }); }
      card.appendChild(link);
    }
    host.toggleAttribute('data-floating', Boolean(options.floating));
    shadow.append(css, card);
  }
  global.ZoteroResearchUpdates = { createChecker, showNotice, validVersion };
})(this);
