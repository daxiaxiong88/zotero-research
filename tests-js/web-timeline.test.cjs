const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../userscripts/zotero-research-webai.user.js'), 'utf8');
const sites = [
  ['chatgpt.com/c/one', '<article data-turn="user" data-turn-id="u1"><div data-message-author-role="user" data-message-id="u1">问题一</div></article>', '<div data-message-author-role="assistant">不是提问</div>'],
  ['gemini.google.com/app/one', '<user-query id="u1"><user-query-content><div class="user-query-container"><div class="query-text">问题一</div></div></user-query-content></user-query>', '<model-response>不是提问</model-response>'],
  ['chat.deepseek.com/a/chat/s/one', '<div data-um-id="u1"><div class="ds-message">问题一</div></div>', '<div class="ds-message">不是提问</div>'],
  ['www.kimi.com/chat/one', '<div class="chat-content-item chat-content-item-user" data-message-id="u1"><div class="segment-user">问题一</div></div>', '<div class="chat-content-item chat-content-item-assistant">不是提问</div>'],
  ['kimi.moonshot.cn/chat/one', '<div class="chat-content-item chat-content-item-user" data-message-id="u1">问题一</div>', '<div class="chat-content-item chat-content-item-assistant">不是提问</div>'],
  ['claude.ai/chat/one', '<div data-test-render-count="1"><div data-testid="user-message" data-message-id="u1">问题一</div></div>', '<div data-test-render-count="1"><div class="font-claude-message">不是提问</div></div>'],
  ['aistudio.google.com/prompts/one', '<ms-chat-turn data-turn-role="user" id="u1"><div class="user-prompt-container">问题一</div></ms-chat-turn>', '<ms-chat-turn data-turn-role="model">不是提问</ms-chat-turn>'],
];
function setup(t, url, html, store = new Map()) {
  const dom = new JSDOM('<!doctype html><body><main>' + html + '</main><form><div contenteditable="true">草稿</div></form></body>', { url: 'https://' + url, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  Object.assign(dom.window, {
    __ZRA_TEST__: {}, unsafeWindow: dom.window,
    GM_getValue: (key, fallback) => store.get(key) ?? fallback,
    GM_setValue: (key, value) => store.set(key, value),
    GM_addValueChangeListener: () => {}, GM_registerMenuCommand: () => {}, GM_notification: () => {},
    GM_xmlhttpRequest: () => ({ abort() {} }), GM_info: { script: { version: 'test' } },
  });
  dom.window.eval(source);
  dom.window.__ZRA_TEST__.connector.initDom();
  return { dom, store, host: dom.window.document.querySelector('[data-zra-web-timeline]') };
}
const wait = () => new Promise(resolve => setTimeout(resolve, 320));
for (const [url, user, assistant] of sites) {
  test('web timeline identifies only user turns on ' + url, async t => {
    const h = setup(t, url, user + assistant);
    assert.ok(h.host, 'every supported host must get the timeline even while Zotero is offline');
    await wait();
    const dots = h.host.shadowRoot.querySelectorAll('[data-entry-id]');
    assert.equal(dots.length, 1, 'nested user wrappers must not produce duplicate anchors');
    assert.match(dots[0].getAttribute('aria-label'), /问题一/);
    assert.doesNotMatch(dots[0].getAttribute('aria-label'), /不是提问|草稿/);
  });
}
test('web stars survive reload, while SPA navigation rebuilds without leaking stars', async t => {
  const [url, user, assistant] = sites[0];
  const h = setup(t, url, user + assistant); assert.ok(h.host);
  await wait();
  h.host.shadowRoot.querySelector('[data-entry-id]').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 's', bubbles: true }));
  const next = setup(t, url, user + assistant, h.store); await wait();
  assert.equal(next.host.shadowRoot.querySelector('[data-entry-id]').getAttribute('aria-pressed'), 'true');
  next.dom.window.history.pushState({}, '', '/c/two');
  next.dom.window.document.querySelector('main').innerHTML = user.replaceAll('u1', 'u2').replace('问题一', '新会话');
  await wait();
  const dot = next.host.shadowRoot.querySelector('[data-entry-id]');
  assert.match(dot.getAttribute('aria-label'), /新会话/);
  assert.equal(dot.getAttribute('aria-pressed'), 'false');
  assert.equal(next.dom.window.document.querySelector('form').textContent, '草稿');
});

test('SPA route reuse of a user wrapper with a new message ID does not hide the new conversation', async t => {
  const h = setup(t, sites[0][0], sites[0][1]); assert.ok(h.host); await wait();
  h.dom.window.history.pushState({}, '', '/c/two');
  const user = h.dom.window.document.querySelector('article');
  user.setAttribute('data-turn-id', 'different-conversation-turn');
  // A text mutation accompanies React's commit even if the question is repeated.
  user.querySelector('div').textContent = '问题一';
  await wait();
  assert.equal(h.host.shadowRoot.querySelectorAll('[data-entry-id]').length, 1);
});

test('initial composer-only pages do not index drafts, and pagehide/pageshow resumes a single timeline', async t => {
  const h = setup(t, 'chatgpt.com/', ''); assert.ok(h.host); await wait();
  assert.equal(h.host.hidden, true);
  h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pagehide', { persisted: true }));
  h.dom.window.document.querySelector('main').innerHTML = sites[0][1];
  await wait();
  assert.equal(h.host.shadowRoot.querySelectorAll('[data-entry-id]').length, 0);
  h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  await wait();
  assert.equal(h.host.shadowRoot.querySelectorAll('[data-entry-id]').length, 1);
  assert.equal(h.dom.window.document.querySelectorAll('[data-zra-web-timeline]').length, 1);
});
