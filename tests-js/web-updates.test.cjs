const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../userscripts/zotero-research-webai.user.js'), 'utf8');
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
function setup(t, store = new Map(), offline = false) {
  const dom = new JSDOM('<!doctype html><body><div contenteditable="true">未发送草稿</div></body>', { url: 'https://gemini.google.com/app/one', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const menus = new Map(), requests = [], notices = [];
  Object.assign(dom.window, {
    __ZRA_TEST__: {}, unsafeWindow: dom.window, GM_info: { script: { version: '1.1.1' } },
    GM_getValue: (key, value) => store.get(key) ?? value, GM_setValue: (key, value) => store.set(key, value),
    GM_addValueChangeListener() {}, GM_registerMenuCommand: (label, callback) => menus.set(label, callback),
    GM_notification: options => notices.push(options),
    GM_xmlhttpRequest: options => {
      if (options.url.includes('raw.githubusercontent.com')) {
        requests.push(options);
        queueMicrotask(() => offline ? options.onerror({}) : options.onload({ status: 200, responseText: JSON.stringify({ userscript: { version: '1.1.2', release: '0.9.2' } }) }));
      }
      return { abort() {} };
    },
  });
  dom.window.eval(source);
  dom.window.__ZRA_TEST__.connector.initDom();
  return { dom, store, menus, requests, notices };
}
test('userscript update popup appears once without changing drafts and manual check can reopen it', async t => {
  const h = setup(t); await wait();
  const notice = h.dom.window.document.querySelector('[data-zra-update-notice]');
  assert.ok(notice && !notice.hidden, 'Tampermonkey users must see a new-version prompt');
  assert.match(notice.shadowRoot.textContent, /1\.1\.2/);
  assert.equal(h.requests[0].method, 'GET'); assert.equal(h.requests[0].data, undefined);
  assert.equal(h.dom.window.document.querySelector('[contenteditable]').textContent, '未发送草稿');
  notice.shadowRoot.querySelector('button').click();
  const reloaded = setup(t, h.store); await wait();
  assert.equal(reloaded.requests.length, 0, 'reload must not query on every message/page');
  assert.equal(reloaded.dom.window.document.querySelector('[data-zra-update-notice]'), null);
  reloaded.menus.get('检查脚本更新')(); await wait();
  assert.equal(reloaded.requests.length, 1);
  assert.ok(reloaded.dom.window.document.querySelector('[data-zra-update-notice]'));
});
test('automatic update check fails quietly offline, manual check reports the failure', async t => {
  const h = setup(t, new Map(), true); await wait();
  assert.equal(h.notices.length, 0);
  assert.ok(h.menus.has('检查脚本更新'));
  h.menus.get('检查脚本更新')(); await wait();
  assert.match(JSON.stringify(h.notices), /无法检查/);
});
