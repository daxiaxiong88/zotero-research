const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const asset = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

// No account or real AI requests: exercise the real userscript, native stream
// decoder, Zotero relay, and sidebar renderer against a deterministic SSE page.
test('DeepSeek multiple fragments reach the sidebar verbatim, including thinking, formulas and the final paragraph', async ({ context }) => {
  test.setTimeout(30000);
  const sidebar = await context.newPage();
  const web = await context.newPage();
  const errors = [];
  for (const page of [sidebar, web]) page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body></body>' }));
  await sidebar.goto('https://zotero-fixture.invalid/');
  await sidebar.addStyleTag({ content: asset('addon/content/panel.css') });
  for (const name of ['relay.js', 'katex.min.js', 'markdown.js', 'panel.js']) {
    await sidebar.addScriptTag({ content: asset('addon/content/' + name) });
  }
  await sidebar.evaluate(() => {
    window.store = ZoteroResearchRelay.createRelayStore();
    window.events = [];
    store.subscribe(event => events.push(event));
    const host = document.createElement('div');
    host.style.width = '360px';
    document.body.append(host);
    window.panel = ZoteroResearchPanel.mount(host, {
      relay: store, getProvider: () => 'deepseek', retrieveEvidence: async () => [],
      loadChatSession: async () => ({ messages: [] }), saveChatSession: async () => {},
    });
    panel.setContext({ item_key: 'DEEPSEEK', attachment_key: 'PDF00001', library_id: 1, title: 'DeepSeek relay fixture' });
  });
  await web.exposeFunction('relayRequest', payload => sidebar.evaluate(async value => {
    return value.action === 'poll' ? store.poll(value, 500) : store[value.action](value);
  }, payload));
  await web.addInitScript(() => {
    const values = new Map();
    window.__ZRA_TEST__ = {};
    window.GM_info = { script: { version: 'browser-test' } };
    window.GM_getValue = (key, fallback) => values.get(key) ?? fallback;
    window.GM_setValue = (key, value) => values.set(key, value);
    window.GM_addValueChangeListener = () => {};
    window.GM_registerMenuCommand = () => {};
    window.GM_notification = () => {};
    window.GM_xmlhttpRequest = options => {
      let cancelled = false;
      relayRequest(JSON.parse(options.data)).then(value => {
        if (!cancelled) options.onload({ status: 200, responseText: JSON.stringify(value) });
      }).catch(() => { if (!cancelled) options.onerror(); });
      return { abort() { cancelled = true; } };
    };
    window.unsafeWindow = window;
    window.fetch = async () => new Response(new ReadableStream({
      async start(controller) {
        const frames = [
          { v: { response: { fragments: [
            { type: 'THINK', content: '先核对原文。' },
            { type: 'RESPONSE', content: '' },
          ] } } },
          { p: 'response/fragments/-1/content', o: 'APPEND', v: '# 完整解释\n\n第一段。' },
          { response_message_id: 2 },
          { v: '\n\n第二段 🌍。' },
          { p: 'response', o: 'BATCH', v: [
            { p: 'accumulated_token_usage', v: 50 },
            { p: 'fragments', o: 'APPEND', v: [
              { type: 'RESPONSE', content: '\n\n$$\\frac{a}{b}$$\n\n' },
              { type: 'RESPONSE', content: '| 项目 | 结果 |\n| --- | --- |\n| 对照 | 保留 |' },
            ] },
          ] },
          { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '' }] },
          { p: 'response/fragments/-1/content', o: 'APPEND', v: '\n\n最后一段不能遗漏。' },
          { p: 'response/status', o: 'SET', v: 'FINISHED' },
        ];
        for (const frame of frames) {
          const bytes = new TextEncoder().encode('data: ' + JSON.stringify(frame) + '\r\n\r\n');
          // Split every UTF-8 codepoint and every SSE frame across reads.
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    document.addEventListener('DOMContentLoaded', () => {
      document.body.innerHTML = '<main><div class="_4f9bf79">旧问题</div><div>旧答案不能混入</div></main>'
        + '<form><textarea></textarea><button class="_52c986b" type="button">发送</button></form>';
      const input = document.querySelector('textarea');
      window.sends = 0;
      document.querySelector('button').addEventListener('click', () => {
        window.sends++;
        const turn = document.createElement('div');
        turn.className = '_4f9bf79'; turn.textContent = input.value;
        document.querySelector('main').append(turn);
        input.value = '';
        fetch('/api/v0/chat/completion', { method: 'POST' });
      });
    }, { once: true });
  });
  await web.addInitScript({ content: asset('userscripts/zotero-research-webai.user.js') });
  await web.goto('https://chat.deepseek.com/');
  await expect.poll(() => sidebar.evaluate(() => store.state().connected)).toBe(true);
  const input = sidebar.locator('[data-testid="webai-chat-input"]');
  await input.fill('请完整解释，不遗漏中间段落。');
  await input.press('Enter');
  await expect.poll(() => sidebar.evaluate(() => events.filter(event => event.type === 'answer').length), { timeout: 15000 }).toBe(1);
  const answer = await sidebar.evaluate(() => events.find(event => event.type === 'answer'));
  expect(answer.error).toBe('');
  expect(answer.text).toBe('<think>先核对原文。</think>\n# 完整解释\n\n第一段。\n\n第二段 🌍。\n\n$$\\frac{a}{b}$$\n\n'
    + '| 项目 | 结果 |\n| --- | --- |\n| 对照 | 保留 |\n\n最后一段不能遗漏。');
  const body = sidebar.locator('.zrp-message-assistant .zrp-md');
  for (const text of ['第一段。', '第二段 🌍。', '最后一段不能遗漏。']) await expect(body).toContainText(text);
  await expect(body.locator('table')).toHaveCount(1);
  await expect(body.locator('mfrac')).toHaveCount(1);
  await expect(sidebar.locator('.zrp-think-body')).toHaveText('先核对原文。');
  await expect(sidebar.locator('.zrp-message-error')).toHaveCount(0);
  await expect(input).toBeEnabled();
  expect(await web.evaluate(() => sends)).toBe(1);
  expect(errors).toEqual([]);
  await sidebar.evaluate(() => { panel.destroy(); store.destroy(); });
});
