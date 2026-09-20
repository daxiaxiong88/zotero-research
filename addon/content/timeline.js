/* Shared by the Zotero panel and the bundled userscript. No network or chat writes.
 * Interaction inspired by Reborn14/chatgpt-conversation-timeline (MIT).
 * This implementation uses public DOM nodes, not framework-internal state. */
(function attachConversationTimeline(global) {
  'use strict';
  const NS = 'http://www.w3.org/1999/xhtml';

  function previewText(value) {
    let text = String(value || '').trim();
    // Only unwrap our own envelope; a normal question may contain these words.
    if (/^论文[：:]/.test(text)) {
      const transcript = text.indexOf('\n\n对话范围：本轮携带 ');
      if (transcript >= 0) { text = text.slice(0, transcript); }
      const end = text.lastIndexOf('【参考材料结束】');
      const question = text.indexOf('本轮问题：', end < 0 ? 0 : end);
      if (question >= 0) { text = text.slice(question + 5); }
      const history = text.indexOf('【阅读对话');
      if (history >= 0) { text = text.slice(0, history); }
    }
    text = text.replace(/^(?:You said|你说|你說)[：:]\s*/i, '').replace(/\s+/g, ' ').trim();
    return text.length > 240 ? text.slice(0, 240) + '…' : (text || '图片或附件');
  }

  function fingerprint(value) {
    let hash = 2166136261;
    for (const character of String(value)) { hash = Math.imul(hash ^ character.codePointAt(0), 16777619); }
    return (hash >>> 0).toString(36);
  }

  function scrollParent(node) {
    const doc = node.ownerDocument;
    for (let parent = node.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
      const style = doc.defaultView.getComputedStyle(parent);
      if (/(auto|scroll|overlay)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) { return parent; }
    }
    return doc.scrollingElement || doc.documentElement;
  }

  function mount(host, options = {}) {
    const doc = host.ownerDocument;
    const view = doc.defaultView;
    const shadow = host.attachShadow({ mode: 'open' });
    const create = (tag, attrs, text) => {
      const node = doc.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attrs || {})) { node.setAttribute(key, value); }
      if (text !== undefined) { node.textContent = text; }
      return node;
    };
    const style = create('style', {}, `
      :host { --ink:var(--zrp-ink,#514a66); --line:var(--zrp-line,#d8d3e5); --accent:var(--zrp-accent,#7567d8); --paper:var(--zrp-card,#fff); --star:#9b6700;
        display:block; width:28px; min-width:28px; position:relative; color:var(--ink);
        font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
      :host([hidden]) { display:none!important; }
      :host([data-mode="web"]) { position:fixed; right:8px; top:18vh; height:64vh; z-index:2147483645; }
      :host([data-dark="true"]) { --ink:#e4def0; --line:#60596c; --accent:#b9a9ff; --paper:#26232e; --star:#ffce73; }
      * { box-sizing:border-box; }
      [hidden] { display:none!important; }
      nav { position:relative; height:100%; min-height:48px; }
      button { appearance:none; border:0; padding:0; font:inherit; cursor:pointer; color:inherit;
        background:transparent; touch-action:pan-y; user-select:none; }
      button:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; border-radius:5px; }
      [data-action="toggle"] { width:28px; height:26px; background:var(--paper); border-radius:5px; }
      [data-track] { position:absolute; inset:28px 0 0; overflow-y:auto; overflow-x:hidden; scrollbar-width:none; overscroll-behavior:contain; }
      [data-track]::-webkit-scrollbar { display:none; }
      .markers { display:flex; flex-direction:column; min-height:100%; justify-content:space-between; align-items:center; }
      [data-entry-id] { width:26px; height:24px; min-height:24px; position:relative; flex-shrink:0; }
      [data-entry-id]::before { content:""; position:absolute; width:2px; top:0; bottom:0; left:12px; background:var(--line); }
      .tick { position:relative; display:inline-block; width:9px; height:9px; border:2px solid var(--paper);
        border-radius:50%; background:var(--line); vertical-align:middle; }
      [aria-current="step"] .tick { background:var(--accent); width:13px; height:13px; }
      [aria-pressed="true"] .tick { background:none; border:none; width:16px; height:20px; color:var(--star); }
      [aria-pressed="true"] .tick::after { content:"★"; font-size:16px; }
      [role="tooltip"] { position:fixed; width:260px; max-width:calc(100vw - 48px); padding:10px 12px;
        border:1px solid var(--line); border-radius:8px; background:var(--paper); color:var(--ink);
        box-shadow:0 3px 16px #0002; overflow-wrap:anywhere; white-space:pre-wrap; pointer-events:none; z-index:1; }
      .help { display:block; margin-top:5px; font-size:11px; opacity:.8; }
      @media (prefers-reduced-motion:reduce) { * { scroll-behavior:auto!important; } }
    `);
    const nav = create('nav', { 'aria-label': '对话时间轴' });
    const toggle = create('button', { type: 'button', 'data-action': 'toggle' }, '⋮');
    const track = create('div', { 'data-track': '' });
    const markers = create('div', { class: 'markers' });
    const tooltip = create('div', { role: 'tooltip', id: 'timeline-preview', hidden: '' });
    track.appendChild(markers); nav.append(toggle, track, tooltip); shadow.append(style, nav);
    host.setAttribute('data-mode', options.web ? 'web' : 'panel');
    let entries = [], nodes = new Map(), enabled = options.enabled !== false;
    let destroyed = false, frame = null, pressTimer = null, suppressed = null, previewId = null;
    let scrollRoot = options.scrollRoot || doc.scrollingElement || doc.documentElement;
    let activeId = null;
    const cleanups = [];
    const listen = (node, event, handler, opts) => {
      node.addEventListener(event, handler, opts);
      cleanups.push(() => node.removeEventListener(event, handler, opts));
    };
    const reducedMotion = () => view.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const isPage = () => scrollRoot === doc.documentElement || scrollRoot === doc.body;
    const topEdge = () => isPage() ? 0 : scrollRoot.getBoundingClientRect().top + (scrollRoot.clientTop || 0);
    function activate(id, reveal) {
      const changed = activeId !== id;
      if (changed) {
        nodes.get(activeId)?.removeAttribute('aria-current');
        activeId = id; nodes.get(id)?.setAttribute('aria-current', 'step');
      }
      if (reveal && changed) {
        const dot = nodes.get(id);
        if (dot && (dot.offsetTop < track.scrollTop || dot.offsetTop + 24 > track.scrollTop + track.clientHeight)) {
          track.scrollTop = Math.max(0, dot.offsetTop - track.clientHeight / 2);
        }
      }
    }
    function syncPosition() {
      if (destroyed || !enabled || doc.hidden) { return; }
      const reference = topEdge() + Math.min(100, (scrollRoot.clientHeight || view.innerHeight) * .25);
      let current = entries[0];
      for (const entry of entries) {
        if (entry.target?.isConnected && entry.target.getBoundingClientRect().top <= reference) { current = entry; }
      }
      if (current) { activate(current.id, true); }
    }
    function schedulePosition() {
      if (frame !== null || destroyed) { return; }
      frame = view.requestAnimationFrame(() => { frame = null; syncPosition(); });
    }
    function showPreview(entry) {
      previewId = entry.id;
      const dot = nodes.get(entry.id);
      tooltip.textContent = (entries.indexOf(entry) + 1) + '. ' + previewText(entry.text);
      tooltip.appendChild(create('span', { class: 'help' }, '点击跳转 · 长按或按 S 标星'));
      tooltip.hidden = false;
      const rect = dot.getBoundingClientRect();
      tooltip.style.left = Math.max(8, Math.min(view.innerWidth - 276, rect.left - 270)) + 'px';
      tooltip.style.top = Math.max(8, Math.min(view.innerHeight - tooltip.offsetHeight - 8, rect.top - 12)) + 'px';
      dot.setAttribute('aria-describedby', 'timeline-preview');
    }
    function hidePreview() {
      nodes.get(previewId)?.removeAttribute('aria-describedby');
      previewId = null; tooltip.hidden = true;
    }
    function star(entry) {
      entry.starred = !entry.starred;
      nodes.get(entry.id)?.setAttribute('aria-pressed', String(entry.starred));
      options.onStar?.(entry.id, entry.starred);
    }
    function cancelPress() { view.clearTimeout(pressTimer); pressTimer = null; }
    function jump(entry) {
      if (!entry.target?.isConnected) { return; }
      const top = Math.max(0, entry.target.getBoundingClientRect().top - topEdge() + scrollRoot.scrollTop);
      if (typeof scrollRoot.scrollTo === 'function') { scrollRoot.scrollTo({ top, behavior: reducedMotion() ? 'instant' : 'smooth' }); }
      else { scrollRoot.scrollTop = top; }
      activate(entry.id, true); hidePreview();
    }
    function setEnabled(value) {
      enabled = Boolean(value); track.hidden = !enabled;
      toggle.setAttribute('aria-expanded', String(enabled));
      toggle.setAttribute('aria-label', enabled ? '收起对话时间轴' : '展开对话时间轴');
      toggle.title = enabled ? '收起时间轴' : '展开时间轴';
      hidePreview(); if (enabled) { schedulePosition(); }
    }
    listen(toggle, 'click', () => { setEnabled(!enabled); options.onToggle?.(enabled); });
    listen(markers, 'click', event => {
      const id = event.target.closest('[data-entry-id]')?.getAttribute('data-entry-id');
      if (suppressed === id) { suppressed = null; return; }
      const entry = entries.find(value => value.id === id);
      if (entry) { jump(entry); }
    });
    listen(markers, 'keydown', event => {
      const dot = event.target.closest('[data-entry-id]');
      if (!dot) { return; }
      const index = entries.findIndex(entry => entry.id === dot.getAttribute('data-entry-id'));
      if (index < 0) { return; }
      if (event.key.toLowerCase() === 's') { event.preventDefault(); star(entries[index]); }
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (step) { event.preventDefault(); nodes.get(entries[Math.max(0, Math.min(entries.length - 1, index + step))].id)?.focus(); }
      if (event.key === 'Escape') { hidePreview(); }
    });
    listen(markers, 'pointerdown', event => {
      if (event.button !== 0) { return; }
      const id = event.target.closest('[data-entry-id]')?.getAttribute('data-entry-id');
      const entry = entries.find(value => value.id === id);
      suppressed = null; cancelPress();
      if (entry) {
        pressTimer = view.setTimeout(() => {
          const current = entries.find(value => value.id === id);
          if (current && current.target === entry.target && current.text === entry.text) {
            suppressed = id; star(current);
          }
          pressTimer = null;
        }, 550);
      }
    });
    for (const name of ['pointerup', 'pointercancel', 'pointerleave']) { listen(markers, name, cancelPress); }
    listen(track, 'scroll', () => { cancelPress(); hidePreview(); }, { passive: true });
    listen(doc, 'scroll', schedulePosition, { capture: true, passive: true });
    listen(view, 'resize', () => { hidePreview(); schedulePosition(); });
    listen(doc, 'visibilitychange', schedulePosition);
    const themeMedia = view.matchMedia?.('(prefers-color-scheme: dark)');
    function syncTheme() {
      const html = doc.documentElement, body = doc.body;
      const explicit = html.getAttribute('data-theme') || body?.getAttribute('data-theme')
        || (html.classList.contains('dark') || body?.classList.contains('dark-theme') ? 'dark' : '')
        || (html.classList.contains('light') || body?.classList.contains('light-theme') ? 'light' : '');
      const dark = explicit ? /dark/i.test(explicit) : Boolean(themeMedia?.matches);
      host.setAttribute('data-dark', String(dark));
    }
    if (themeMedia?.addEventListener) { listen(themeMedia, 'change', syncTheme); }
    const themeObserver = new view.MutationObserver(syncTheme);
    themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    if (doc.body) { themeObserver.observe(doc.body, { attributes: true, attributeFilter: ['class', 'data-theme'] }); }
    syncTheme();
    let resizeObserver;
    if (view.ResizeObserver) { resizeObserver = new view.ResizeObserver(schedulePosition); }
    setEnabled(enabled);
    return {
      update(next, root) {
        if (destroyed) { return; }
        if (root) { scrollRoot = root; }
        entries = next.map(entry => ({ ...entry, id: String(entry.id) }));
        const ids = new Set(entries.map(entry => entry.id));
        for (const [id, node] of nodes) { if (!ids.has(id)) { node.remove(); nodes.delete(id); } }
        if (!ids.has(activeId)) { activeId = null; }
        if (previewId && !ids.has(previewId)) { hidePreview(); }
        entries.forEach((entry, index) => {
          let dot = nodes.get(entry.id);
          if (!dot) {
            dot = create('button', { type: 'button', 'data-entry-id': entry.id });
            dot.appendChild(create('span', { class: 'tick', 'aria-hidden': 'true' }));
            for (const event of ['mouseenter', 'focus']) {
              dot.addEventListener(event, () => {
                const current = entries.find(value => value.id === entry.id);
                if (current) { showPreview(current); }
              });
            }
            for (const event of ['mouseleave', 'blur']) { dot.addEventListener(event, hidePreview); }
            nodes.set(entry.id, dot);
          }
          dot.setAttribute('aria-label', (index + 1) + '. ' + previewText(entry.text));
          dot.setAttribute('aria-pressed', String(Boolean(entry.starred)));
          // Avoid moving unchanged buttons: that steals focus/hover during streaming.
          if (markers.children[index] !== dot) { markers.insertBefore(dot, markers.children[index] || null); }
        });
        host.hidden = !entries.length;
        resizeObserver?.disconnect();
        if (entries.length) { resizeObserver?.observe(scrollRoot); }
        schedulePosition();
      },
      setEnabled,
      destroy() {
        destroyed = true; cancelPress(); view.cancelAnimationFrame(frame);
        resizeObserver?.disconnect(); cleanups.forEach(cleanup => cleanup());
        themeObserver.disconnect();
        shadow.replaceChildren(); nodes.clear(); entries = [];
      },
    };
  }
  global.ZoteroResearchTimeline = { mount, previewText, fingerprint, scrollParent };
})(this);
