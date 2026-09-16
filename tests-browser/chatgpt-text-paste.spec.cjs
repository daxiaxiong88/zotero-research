const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const asset = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

// Disposable pages only; every URL is mocked. This exercises the actual
// knowledge-distillation button, relay, paste transaction and answer renderer.
for (const label of ['Pasted text', '已粘贴的文本']) {
  test(`ChatGPT knowledge distillation through ${label} returns a complete answer`, async ({ context }) => {
    const sidebar = await context.newPage();
    const web = await context.newPage();
    const errors = [];
    for (const page of [sidebar, web]) page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body></body>',
    }));
    await sidebar.goto('https://zotero-fixture.invalid/');
    await sidebar.addStyleTag({ content: asset('addon/content/panel.css') });
    for (const file of ['relay.js', 'katex.min.js', 'markdown.js', 'panel.js']) {
      await sidebar.addScriptTag({ content: asset('addon/content/' + file) });
    }
    await sidebar.evaluate(() => {
      window.store = ZoteroResearchRelay.createRelayStore();
      window.events = [];
      store.subscribe(event => events.push(event));
      const host = document.createElement('div'); host.style.width = '420px'; document.body.append(host);
      const messages = Array.from({ length: 12 }, (_, index) => [
        { role: 'user', content: `KEEP_QUESTION_${index}: How does the method work?` },
        { role: 'assistant', content: 'The complete explanation. '.repeat(80) + `KEEP_ANSWER_${index}` },
      ]).flat();
      window.panel = ZoteroResearchPanel.mount(host, {
        relay: store, getProvider: () => 'chatgpt', retrieveEvidence: async () => [],
        loadChatSession: async () => ({ messages }), saveChatSession: async () => {},
      });
      panel.setContext({ item_key: 'TEXT0001', attachment_key: 'PDF00001', library_id: 1, title: 'SeisMoLLM fixture' });
    });
    await web.exposeFunction('relayRequest', payload => sidebar.evaluate(async value => {
      return value.action === 'poll' ? store.poll(value, 500) : store[value.action](value);
    }, payload));
    await web.addInitScript(label => {
      const values = new Map();
      window.notices = []; window.pastes = 0; window.sends = 0;
      window.GM_info = { script: { version: 'text-paste-fixture' } };
      window.GM_getValue = (key, fallback) => values.get(key) ?? fallback;
      window.GM_setValue = (key, value) => values.set(key, value);
      window.GM_addValueChangeListener = window.GM_registerMenuCommand = () => {};
      window.GM_notification = ({ text }) => notices.push(text);
      window.GM_xmlhttpRequest = options => {
        let aborted = false;
        relayRequest(JSON.parse(options.data)).then(body => {
          if (!aborted) options.onload({ status: 200, responseText: JSON.stringify(body) });
        }).catch(() => { if (!aborted) options.onerror(); });
        return { abort() { aborted = true; } };
      };
      window.unsafeWindow = window;
      window.fetch = async () => new Response(new ReadableStream({
        async start(controller) {
          const write = (text, status) => controller.enqueue(new TextEncoder().encode('data: '
            + JSON.stringify({ message: { id: 'text-answer', author: { role: 'assistant' }, channel: 'final',
              content: { content_type: 'text', parts: [text] }, status } }) + '\n\n'));
          write('# 知识沉淀\n\n开头', 'in_progress');
          await new Promise(resolve => setTimeout(resolve, 300));
          const answer = '# 知识沉淀\n\n核心公式：\\[\\frac{a}{b}\\]\n\n完整沉淀的最后一句。';
          write(answer, 'finished_successfully');
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close();
          document.querySelector('#answer').textContent = answer;
          document.querySelector('#turn').insertAdjacentHTML('beforeend', '<button data-testid="copy-turn-action-button">Copy</button>');
          const send = document.querySelector('#composer-submit-button');
          send.removeAttribute('aria-label'); send.disabled = true;
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
      document.addEventListener('DOMContentLoaded', () => {
        document.body.innerHTML = '<main></main><form id="composer"><div id="cards"></div>'
          + '<div id="prompt-textarea" contenteditable="true" style="min-height:40px"></div>'
          + '<button id="composer-submit-button" type="button" disabled>Send</button></form>';
        const input = document.querySelector('#prompt-textarea');
        const send = document.querySelector('#composer-submit-button');
        input.addEventListener('paste', event => {
          event.preventDefault(); window.pastes++;
          window.receivedPrompt = event.clipboardData.getData('text/plain');
          if (receivedPrompt.length < 8000) throw Error('Not a long knowledge-distillation request');
          const card = document.createElement('div'); card.setAttribute('role', 'button');
          const title = document.createElement('span'); title.textContent = '论文：SeisMoLLM...';
          const caption = document.createElement('span'); caption.textContent = label;
          const progress = document.createElement('progress');
          card.append(title, caption, progress); document.querySelector('#cards').append(card);
          // A remounted editor in the same composer is a valid transaction.
          if (label !== 'Pasted text') input.replaceWith(input.cloneNode(true));
          setTimeout(() => { progress.remove(); send.disabled = false; }, 300);
        });
        send.addEventListener('click', () => {
          window.sends++;
          if (document.querySelector('progress')) throw Error('Sent before text attachment ready');
          if (document.querySelector('#prompt-textarea').textContent) throw Error('Prompt was duplicated into editor');
          document.querySelector('main').innerHTML = '<article><div data-message-author-role="user">知识沉淀</div></article>'
            + '<article id="turn"><div id="answer" data-message-author-role="assistant" data-message-id="text-answer"></div></article>';
          document.querySelector('#cards').replaceChildren();
          send.disabled = true; send.setAttribute('aria-label', 'Stop generating');
          void fetch('/backend-api/f/conversation').then(response => response.text());
        });
      }, { once: true });
    }, label);
    await web.addInitScript({ content: asset('userscripts/zotero-research-webai.user.js') });
    await web.goto('https://chatgpt.com/');
    await expect.poll(() => sidebar.evaluate(() => store.state().connected)).toBe(true);
    await sidebar.locator('[data-testid="quick-distill"]').click();
    await expect.poll(() => sidebar.evaluate(() => events.filter(event => event.type === 'answer' && !event.error).length),
      { timeout: 20000 }).toBe(1);
    await expect(sidebar.locator('.zrp-message-assistant').last()).toContainText('完整沉淀的最后一句。');
    await expect(sidebar.locator('.zrp-message-assistant').last().locator('mfrac')).toHaveCount(1);
    await expect(sidebar.locator('[data-zrp-action="distill-note"]')).toBeVisible();
    await expect(sidebar.locator('.zrp-message-error')).toHaveCount(0);
    const sent = await web.evaluate(() => ({ prompt: receivedPrompt, pastes, sends, notices }));
    expect(sent.prompt).toContain('KEEP_QUESTION_0');
    expect(sent.prompt).toContain('KEEP_ANSWER_11');
    expect(sent.pastes).toBe(1); expect(sent.sends).toBe(1);
    expect(sent.notices.filter(text => /失败|未能|手动/.test(text))).toEqual([]);
    expect(errors).toEqual([]);
    await sidebar.evaluate(() => { panel.destroy(); store.destroy(); });
  });
}
