const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const asset = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('Gemini Quill model receives one text paste and sends despite an unrelated Stop control', async ({ context }) => {
  const sidebar = await context.newPage();
  const web = await context.newPage();
  const errors = [];
  for (const page of [sidebar, web]) page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body></body>' }));
  await sidebar.goto('https://zotero-fixture.invalid/');
  for (const name of ['relay.js', 'katex.min.js', 'markdown.js', 'panel.js']) {
    await sidebar.addScriptTag({ content: asset('addon/content/' + name) });
  }
  await sidebar.evaluate(() => {
    window.store = ZoteroResearchRelay.createRelayStore();
    window.events = [];
    store.subscribe(event => events.push(event));
    const host = document.createElement('div'); document.body.append(host);
    window.panel = ZoteroResearchPanel.mount(host, { relay: store,
      getProvider: () => 'gemini', retrieveEvidence: async () => [] });
    panel.setContext({ item_key: 'QUILL001', attachment_key: 'PDF00001', library_id: 1, title: 'Gemini editor regression' });
  });
  await web.exposeFunction('relayRequest', payload => sidebar.evaluate(value => value.action === 'poll'
    ? store.poll(value, 500) : store[value.action](value), payload));
  await web.goto('https://gemini.google.com/app');
  await web.addScriptTag({ content: fs.readFileSync(require.resolve('quill/dist/quill.js'), 'utf8') });
  await web.evaluate(() => {
    window.__ZRA_TEST__ = {};
    window.GM_info = { script: { version: 'editor-fixture' } };
    const values = new Map();
    window.GM_getValue = (key, fallback) => values.get(key) ?? fallback;
    window.GM_setValue = (key, value) => values.set(key, value);
    window.GM_registerMenuCommand = () => {};
    window.GM_addValueChangeListener = () => {};
    window.GM_notification = () => {};
    window.GM_xmlhttpRequest = options => {
      let cancelled = false;
      relayRequest(JSON.parse(options.data)).then(value => {
        if (!cancelled) options.onload({ status: 200, responseText: JSON.stringify(value) });
      }).catch(() => { if (!cancelled) options.onerror(); });
      return { abort() { cancelled = true; } };
    };
    window.unsafeWindow = window;
    document.body.innerHTML = '<main><user-query><div class="query-text">旧问题</div></user-query><model-response><message-content>旧答案</message-content></model-response></main>'
      + '<aside><button class="send-button" aria-label="Stop generating">停止无关操作</button></aside>'
      + '<div class="input-area"><form><rich-textarea><div id="editor" style="min-height:40px"></div></rich-textarea>'
      + '</form><div hidden><button class="send-button" type="button">隐藏按钮</button></div>'
      + '<button class="send-button" id="send" type="button" disabled>发送</button></div>';
    window.quill = new Quill('#editor', { modules: { toolbar: false } });
    quill.root.classList.add('textarea', 'new-input-ui');
    const send = document.querySelector('#send');
    window.pastes = 0; window.sends = 0;
    quill.root.addEventListener('paste', () => pastes++);
    quill.on('text-change', () => { send.disabled = !quill.getText().trim(); });
    // Validate the editor transaction with Quill's real model, rather than
    // teaching a fake input handler to accept the userscript's DOM mutation.
    window.fetch = async () => new Response(new ReadableStream({ start(controller) {
      const result = []; result[1] = ['## 完整回答\n\n| 任务 | 数据集 |\n| --- | --- |\n| 分类 | Parihaka |\n\n\\[\\frac{a}{b}\\]\n最后的结论。'];
      const inner = []; inner[4] = [result];
      controller.enqueue(new TextEncoder().encode(JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]) + '\n[["e",10,null,null,null]]'));
      controller.close();
    } }), { headers: { 'Content-Type': 'text/plain' } });
    send.addEventListener('click', () => {
      if (!quill.getText().trim()) throw Error('Quill model did not receive the prompt');
      window.sends++; window.sentText = quill.getText().trim();
      const user = document.createElement('user-query');
      const content = document.createElement('div'); content.className = 'query-text'; content.textContent = sentText;
      user.append(content); document.querySelector('main').append(user);
      quill.setText('');
      void fetch('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate').then(response => response.text());
    });
  });
  await web.addScriptTag({ content: asset('userscripts/zotero-research-webai.user.js') });
  await expect.poll(() => sidebar.evaluate(() => store.state().connected)).toBe(true);
  await sidebar.locator('[data-testid="webai-chat-input"]').fill('请解释这篇论文，保留完整表格和公式。');
  await sidebar.locator('[data-testid="webai-chat-input"]').press('Enter');
  await expect.poll(() => web.evaluate(() => sends), { timeout: 10000 }).toBe(1);
  expect(await web.evaluate(() => pastes)).toBe(1);
  expect(await web.evaluate(() => sentText)).toContain('请解释这篇论文，保留完整表格和公式。');
  await expect(sidebar.locator('.zrp-message-assistant')).toContainText('最后的结论。', { timeout: 10000 });
  await expect(sidebar.locator('.zrp-md table')).toHaveCount(1);
  await expect(sidebar.locator('mfrac')).toHaveCount(1);
  await expect.poll(() => web.evaluate(() => __ZRA_TEST__.connector.currentTaskId)).toBe(null);
  expect(await web.evaluate(() => __ZRA_TEST__.connector.lastTask.send.acknowledgement)).toBe('new-user-turn');
  expect(errors).toEqual([]);
  await sidebar.evaluate(() => { panel.destroy(); store.destroy(); });
});
