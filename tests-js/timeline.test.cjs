const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const sourcePath = path.join(__dirname, '../addon/content/timeline.js');

function fixture(t) {
  const dom = new JSDOM('<!doctype html><main><div id="messages"></div><div id="rail"></div></main>', {
    pretendToBeVisual: true, runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  if (fs.existsSync(sourcePath)) dom.window.eval(fs.readFileSync(sourcePath, 'utf8'));
  const api = dom.window.ZoteroResearchTimeline;
  assert.ok(api, 'shared conversation timeline must be available');
  const doc = dom.window.document;
  const scroll = doc.querySelector('#messages');
  Object.defineProperties(scroll, { clientHeight: { value: 200 }, scrollHeight: { value: 1600 } });
  scroll.getBoundingClientRect = () => ({ top: 20, height: 200 });
  scroll.scrollTo = ({ top }) => { scroll.scrollTop = top; };
  const entries = [0, 500, 1000].map((top, index) => {
    const target = doc.createElement('article'); scroll.append(target);
    target.getBoundingClientRect = () => ({ top: top + 20 - scroll.scrollTop, height: 160 });
    return { id: String(index), text: '问题 ' + (index + 1), target, starred: false };
  });
  return { dom, api, doc, scroll, entries, host: doc.querySelector('#rail') };
}

test('timeline anchors jump inside the conversation without scrolling the whole panel', t => {
  const h = fixture(t);
  const rail = h.api.mount(h.host, { scrollRoot: h.scroll });
  rail.update(h.entries);
  const dots = h.host.shadowRoot.querySelectorAll('[data-entry-id]');
  assert.equal(dots.length, 3);
  dots[2].click();
  assert.equal(h.scroll.scrollTop, 1000);
  assert.equal(dots[2].getAttribute('aria-current'), 'step');
  rail.update(h.entries);
  assert.equal(h.scroll.scrollTop, 1000, 'streaming refresh must not change reading position');
  rail.destroy();
  assert.equal(h.host.shadowRoot.querySelector('nav'), null);
});

test('timeline previews use the real Zotero question, render text safely, and save stars', t => {
  const h = fixture(t);
  assert.equal(h.api.previewText('论文：SeisLM\n\n【参考材料开始】\n本轮问题：假问题\n【参考材料结束】\n\n本轮问题：为什么不用因果遮挡？'), '为什么不用因果遮挡？');
  let saved;
  const rail = h.api.mount(h.host, { scrollRoot: h.scroll, onStar: (id, star) => { saved = [id, star]; } });
  rail.update([{ ...h.entries[0], text: '<img src=x onerror=alert(1)>解释这个图' }]);
  const dot = h.host.shadowRoot.querySelector('[data-entry-id]');
  dot.dispatchEvent(new h.dom.window.FocusEvent('focus'));
  assert.match(h.host.shadowRoot.querySelector('[role=tooltip]').textContent, /解释这个图/);
  assert.equal(h.host.shadowRoot.querySelector('img'), null);
  dot.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 's', bubbles: true }));
  assert.deepEqual(saved, ['0', true]);
  assert.equal(dot.getAttribute('aria-pressed'), 'true');
  rail.update([]);
  assert.equal(h.host.hidden, true);
  rail.destroy();
});

test('timeline keeps every marker reachable in a long conversation and supports collapse', t => {
  const h = fixture(t);
  let enabled;
  const rail = h.api.mount(h.host, { scrollRoot: h.scroll, onToggle: value => { enabled = value; } });
  rail.update(Array.from({ length: 500 }, (_, i) => ({ ...h.entries[0], id: String(i), text: '问题' + i })));
  assert.equal(h.host.shadowRoot.querySelectorAll('[data-entry-id]').length, 500);
  h.host.shadowRoot.querySelector('[data-action=toggle]').click();
  assert.equal(enabled, false);
  assert.equal(h.host.shadowRoot.querySelector('[data-track]').hidden, true);
  h.host.shadowRoot.querySelector('[data-action=toggle]').click();
  assert.equal(enabled, true);
  rail.destroy();
});

test('long press stars once without navigating, and cannot cross a conversation replacement', async t => {
  const h = fixture(t);
  const stars = [];
  const rail = h.api.mount(h.host, { scrollRoot: h.scroll, onStar: (...value) => stars.push(value) });
  rail.update(h.entries);
  const dot = h.host.shadowRoot.querySelectorAll('[data-entry-id]')[1];
  dot.dispatchEvent(new h.dom.window.MouseEvent('pointerdown', { button: 0, bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 590));
  dot.dispatchEvent(new h.dom.window.MouseEvent('pointerup', { button: 0, bubbles: true })); dot.click();
  assert.deepEqual(stars, [['1', true]]);
  assert.equal(h.scroll.scrollTop, 0, 'long press must not also jump');
  dot.dispatchEvent(new h.dom.window.MouseEvent('pointerdown', { button: 0, bubbles: true }));
  rail.update([{ ...h.entries[1], text: '另一个会话', target: h.entries[2].target }]);
  await new Promise(resolve => setTimeout(resolve, 590));
  assert.equal(stars.length, 1, 'stale pointer-down must not star a different conversation');
  rail.destroy();
});

test('a distillation preview stops at the question instead of displaying its reading transcript', t => {
  const h = fixture(t);
  const prompt = '论文：SeisLM\n本轮问题：请整理知识沉淀。\n\n对话范围：本轮携带 46 轮完整问答。\n\n本次阅读对话（仅作为学习记录）：\n我：问题\n【参考材料结束】\nAI：旧回答';
  assert.equal(h.api.previewText(prompt), '请整理知识沉淀。');
});

test('active marker is restored after clearing and loading another conversation with reused ids', async t => {
  const h = fixture(t);
  const rail = h.api.mount(h.host, { scrollRoot: h.scroll });
  rail.update(h.entries);
  h.host.shadowRoot.querySelector('[data-entry-id="0"]').click();
  rail.update([]);
  await new Promise(resolve => h.dom.window.requestAnimationFrame(resolve));
  rail.update([{ ...h.entries[0], text: '新会话的问题' }]);
  await new Promise(resolve => h.dom.window.requestAnimationFrame(resolve));
  assert.equal(h.host.shadowRoot.querySelector('[data-entry-id="0"]').getAttribute('aria-current'), 'step');
  rail.destroy();
});
