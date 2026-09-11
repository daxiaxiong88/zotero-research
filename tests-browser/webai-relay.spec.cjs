const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const asset = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=';

// All URLs are intercepted: this is a browser-engine integration fixture, not
// a test against a logged-in ChatGPT account. Only the site and GM API are fake;
// the sidebar, relay store, userscript, FileList, streams and renderer are real.
for (const scenario of [
  { provider: 'chatgpt', upload: 'file' },
  { provider: 'chatgpt', upload: 'drag' },
  { provider: 'gemini', upload: 'paste' },
  { provider: 'gemini', upload: 'paste', capture: 'xhr' },
  { provider: 'gemini', upload: 'paste', capture: 'network-lag' },
  { provider: 'gemini', upload: 'paste', capture: 'xhr-dom', fault: 'lost-callback' },
  { provider: 'gemini', upload: 'paste', capture: 'xhr-dom', fault: 'relay-timeout' },
  { provider: 'gemini', upload: 'paste', capture: 'xhr-dom', fault: 'background' },
  { provider: 'gemini', upload: 'paste', capture: 'xhr-dom', fault: 'background-retry' },
]) {
test(`${scenario.provider}/${scenario.upload}/${scenario.capture || 'dom'}/${scenario.fault || 'normal'}: image → one send → complete sidebar math`, async ({ context }) => {
  test.setTimeout(65000);
  const sidebar = await context.newPage();
  const web = await context.newPage();
  const errors = [];
  for (const page of [sidebar, web]) page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body></body>' }));
  if (scenario.capture?.startsWith('xhr')) {
    const result = []; result[1] = ['回答前半段\n\\[\\frac{a}{b}\\]\n完整回答的最后一句。'];
    const inner = []; inner[4] = [result];
    await context.route('**/*StreamGenerate*', route => route.fulfill({ contentType: 'text/plain',
      body: JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]) + '\n[["e",10,null,null,null]]',
    }));
  }
  await sidebar.goto('https://zotero-fixture.invalid/');
  await sidebar.addStyleTag({ content: asset('addon/content/panel.css') });
  for (const script of ['relay.js', 'katex.min.js', 'markdown.js', 'panel.js']) {
    await sidebar.addScriptTag({ content: asset('addon/content/' + script) });
  }
  await sidebar.evaluate(scenario => {
    window.clockOffset = 0;
    window.store = ZoteroResearchRelay.createRelayStore({ now: () => Date.now() + clockOffset });
    window.expireFirstProgress = scenario.fault === 'relay-timeout';
    window.events = [];
    store.subscribe(event => events.push({ ...event, receivedAt: Date.now() }));
    const host = document.createElement('div'); host.style.width = '360px'; document.body.append(host);
    window.panel = ZoteroResearchPanel.mount(host, {
      relay: store, getProvider: () => scenario.provider, retrieveEvidence: async () => [],
      loadChatSession: async () => ({ messages: [] }), saveChatSession: async () => {},
    });
    panel.setContext({ item_key: 'BROWSER1', attachment_key: 'PDF00001', library_id: 1, title: 'Browser regression fixture' });
    if (scenario.capture === 'network-lag') {
      const rendered = new MutationObserver(() => {
        if (host.querySelector('.zrp-message-assistant')?.textContent.includes('完整回答的最后一句。')) {
          window.answerRenderedAt = Date.now();
          rendered.disconnect();
        }
      });
      rendered.observe(host, { childList: true, subtree: true, characterData: true });
    }
  }, scenario);
  await web.exposeFunction('relayRequest', payload => sidebar.evaluate(async value => {
    if (value.action === 'poll') return store.poll(value, 500);
    const result = store[value.action](value);
    if (expireFirstProgress && value.action === 'update' && value.text && !value.isDone) {
      window.expireFirstProgress = false;
      window.clockOffset += 91000;
      await store.poll({ sessionSecret: value.sessionSecret }, 0);
    }
    return result;
  }, payload));
  await web.addInitScript(scenario => {
    const gemini = scenario.provider === 'gemini';
    const background = scenario.fault?.startsWith('background');
    const nativeTimeout = window.setTimeout.bind(window);
    const nativeInterval = window.setInterval.bind(window);
    window.fixtureBackground = false;
    // Deterministic hidden-page fixture: paint and ordinary page callbacks
    // stall, but the real network and Worker remain alive. No focus switch.
    if (background) {
      Object.defineProperty(document, 'visibilityState', { get: () => window.fixtureBackground ? 'hidden' : 'visible' });
      Object.defineProperty(document, 'hidden', { get: () => window.fixtureBackground });
      window.setTimeout = (fn, ms, ...args) => nativeTimeout(() => {
        if (!window.fixtureBackground) fn(...args);
      }, ms);
      window.setInterval = (fn, ms, ...args) => nativeInterval(() => {
        if (!window.fixtureBackground) fn(...args);
      }, ms);
    }
    window.notices = [];
    window.fixtureMenus = new Map();
    window.GM_info = { script: { version: 'browser-test' } };
    const values = new Map();
    window.GM_getValue = (key, fallback) => values.get(key) ?? fallback;
    window.GM_setValue = (key, value) => values.set(key, value);
    window.GM_registerMenuCommand = (name, handler) => fixtureMenus.set(name, handler);
    window.GM_addValueChangeListener = () => {};
    window.GM_notification = ({ text }) => notices.push(text);
    let dropped = false;
    window.GM_xmlhttpRequest = options => {
      let cancelled = false;
      const payload = JSON.parse(options.data);
      const dropCallback = ['lost-callback', 'background-retry'].includes(scenario.fault) && !dropped
        && payload.action === 'update' && payload.text && !payload.isDone;
      if (dropCallback) dropped = true;
      relayRequest(payload).then(value => {
        if (value.task) window.fixtureTask = value.task;
        if (dropCallback) return; // fetch mode supplies neither onload nor ontimeout
        if (!cancelled) options.onload({ status: 200, responseText: JSON.stringify(value) });
      }).catch(() => { if (!cancelled) options.onerror(); });
      return { abort() { cancelled = true; } };
    };
    window.unsafeWindow = window;
    // A genuine ReadableStream with an idle gap longer than the old 3.5s
    // cutoff. The DOM also pauses, then adds a formula and the final sentence.
    window.fetch = async () => new Response(new ReadableStream({
      async start(controller) {
        const write = text => {
          if (scenario.capture === 'network-lag') {
            const result = []; result[1] = [text];
            const inner = []; inner[4] = [result];
            controller.enqueue(new TextEncoder().encode(JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]) + '\n'));
          } else {
            controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ message: {
              id: 'answer-new', author: { role: 'assistant' }, channel: 'final',
              content: { content_type: 'text', parts: [text] },
            } }) + '\n\n'));
          }
        };
        write('回答前半段');
        await new Promise(resolve => setTimeout(resolve, scenario.capture === 'network-lag' ? 600 : 4200));
        window.answerAvailableAt = Date.now();
        window.appendAnswer();
        // Do not close the network until the test has seen the advanced DOM
        // answer arrive and display in the sidebar. Waiting for DONE cannot
        // accidentally make this latency regression pass.
        if (scenario.capture === 'network-lag') {
          await new Promise(resolve => { window.finishFixtureStream = resolve; });
        }
        write('回答前半段\n\\[\\frac{a}{b}\\]\n完整回答的最后一句。');
        controller.enqueue(new TextEncoder().encode(scenario.capture === 'network-lag' ? '\n[["e",10,null]]' : 'data: [DONE]\n\n')); controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    document.addEventListener('DOMContentLoaded', () => {
      const old = gemini ? '<model-response><message-content>旧回答不能串入本轮</message-content><button aria-label="Copy">Copy</button></model-response>'
        : '<article><div data-message-author-role="assistant" data-message-id="old">旧回答不能串入本轮</div><button aria-label="Copy">Copy</button></article>';
      document.body.innerHTML = '<main>' + old + '</main><div id="composer-shell"><div id="cards"></div>'
        + '<form><div class="input-editor"><rich-textarea><div class="textarea" id="prompt-textarea" contenteditable="true" style="min-height:30px"></div></rich-textarea></div>'
        + (scenario.upload === 'file' ? '<input type="file" accept="image/*" hidden>' : '')
        + '<button type="button" class="send-button" data-testid="send-button" disabled>Send</button></form></div>';
      const input = document.querySelector('#prompt-textarea');
      const send = document.querySelector('[data-testid="send-button"]');
      let textReady = false, imageReady = false;
      window.uploads = 0; window.sends = 0; window.imagePastes = 0;
      input.addEventListener('input', () => { textReady = !!input.textContent; send.disabled = !(textReady && imageReady); });
      const acceptUpload = files => {
        if (!(files instanceof FileList) || files[0]?.type !== 'image/png') throw Error('Not a native image FileList');
        window.uploads++;
        setTimeout(() => {
          const card = document.createElement('div');
          // No attachment class/test-id and no img: a CSS thumbnail outside
          // the inner form must still be recognized as the uploaded image.
          card.style.cssText = 'width:100px;height:80px;background-image:url("' + URL.createObjectURL(files[0]) + '")';
          card.setAttribute('aria-busy', 'true');
          card.innerHTML = '<button aria-label="Remove screenshot.png">×</button>'; document.querySelector('#cards').append(card);
          setTimeout(() => { card.removeAttribute('aria-busy'); imageReady = true; send.disabled = !textReady; }, 600);
        }, 2800);
      };
      input.addEventListener('paste', event => {
        const files = event.clipboardData?.files;
        if (files?.length) {
          window.imagePastes++;
          if (scenario.upload === 'paste') { event.preventDefault(); acceptUpload(files); }
        } else if (!gemini && event.clipboardData?.getData('text/plain')) {
          event.preventDefault();
          setTimeout(() => { input.textContent = event.clipboardData.getData('text/plain'); textReady = true; send.disabled = !imageReady; }, 100);
        }
      });
      document.querySelector('input[type=file]')?.addEventListener('change', event => acceptUpload(event.target.files));
      if (scenario.upload === 'drag') input.addEventListener('dragenter', () => {
        setTimeout(() => {
          const overlay = document.createElement('div'); overlay.id = 'drop-overlay';
          overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(255,255,255,.9)';
          overlay.textContent = '添加任意内容'; document.body.append(overlay);
          overlay.addEventListener('dragover', event => event.preventDefault());
          overlay.addEventListener('drop', event => { event.preventDefault(); acceptUpload(event.dataTransfer.files); });
          overlay.addEventListener('dragleave', () => overlay.remove());
        }, 50);
      });
      send.addEventListener('click', () => {
        window.sends++; send.disabled = true;
        // A slow UI acknowledgement must not produce a premature manual-send notice.
        setTimeout(() => {
          document.querySelector('main').insertAdjacentHTML('beforeend', gemini
            ? '<user-query><div class="query-text" data-message-id="user-new"></div></user-query><model-response id="new-turn">'
              + (scenario.capture === 'xhr' ? '<fixture-response data-message-id="answer-new"><p>回答前半段</p></fixture-response>'
                : '<message-content data-message-id="answer-new"><p>回答前半段</p></message-content>')
              + (scenario.capture === 'xhr-dom' ? '<div hidden aria-busy="true"></div>' : '') + '</model-response>'
            : '<article><div data-message-author-role="user" data-message-id="user-new"></div></article><article id="new-turn"><div data-message-author-role="assistant" data-message-id="answer-new"><p>回答前半段</p></div></article>');
          document.querySelector('[data-message-id="user-new"]').textContent = input.textContent; input.textContent = '';
          send.setAttribute('data-testid', 'stop-button'); send.setAttribute('aria-label', 'Stop generating');
          // Deliberately outside the Gemini hook: the actual DOM fallback,
          // not a conveniently recognized network response, must return it.
          if (scenario.capture?.startsWith('xhr')) {
            // Native page XHR is deliberately different from the constructor
            // visible inside the userscript closure. No recognized DOM body
            // is present: only a correctly installed page hook can return it.
            const request = new XMLHttpRequest();
            request.open('POST', '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate');
            request.onload = () => window.appendAnswer();
            nativeTimeout(() => request.send('fixture'), scenario.capture === 'xhr-dom' ? 600 : 0);
            if (background) window.fixtureBackground = true;
          } else {
            const url = scenario.capture === 'network-lag'
              ? '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
              : (gemini ? '/fixture-unintercepted-response' : '/backend-api/f/conversation');
            void fetch(url).then(response => response.text());
          }
        }, 3000);
      });
      window.appendAnswer = () => {
        if (background) return; // Gemini leaves its DOM and Stop button stale until foregrounded
        document.querySelector('[data-message-id="answer-new"]').insertAdjacentHTML('beforeend', '<div data-math-source="\\frac{a}{b}"><span class="katex-display"><span class="katex"><span class="katex-html">重复字形</span></span></span></div><p>完整回答的最后一句。</p>');
        if (scenario.capture !== 'xhr-dom') document.querySelector('#new-turn').insertAdjacentHTML('beforeend', gemini
          ? '<button aria-label="Copy response"><mat-icon data-mat-icon-name="copy"></mat-icon></button>'
          : '<button data-testid="copy-turn-action-button">Copy</button>');
        send.setAttribute('data-testid', 'send-button'); send.removeAttribute('aria-label'); send.disabled = false;
      };
    }, { once: true });
  }, scenario);
  const userscript = asset('userscripts/zotero-research-webai.user.js');
  await web.addInitScript({ content: scenario.capture === 'xhr'
    ? '(function(XMLHttpRequest) {\n' + userscript + '\n})(class SandboxXHR { open() {} });'
    : userscript });
  await web.goto(scenario.provider === 'gemini' ? 'https://gemini.google.com/app' : 'https://chatgpt.com/');
  await expect.poll(() => sidebar.evaluate(() => store.state().connected)).toBe(true);
  if (scenario.provider === 'gemini') {
    await expect.poll(() => sidebar.evaluate(() => store._pollWaiters.length)).toBe(1);
    const connectedAt = await sidebar.evaluate(() => store.state().connectedAt);
    // The real menu aborts the old browser request. Its server waiter must
    // also be retired before the next screenshot can be delivered reliably.
    await web.evaluate(() => fixtureMenus.get('🔗 连接 Zotero')());
    await expect.poll(() => sidebar.evaluate(() => store.state().connectedAt)).toBeGreaterThan(connectedAt);
    await expect.poll(() => sidebar.evaluate(() => store._pollWaiters.length)).toBe(1);
  }
  const input = sidebar.locator('[data-testid="webai-chat-input"]');
  await input.fill('解释这张图和公式，并保留最后的结论。');
  await input.evaluate((element, png) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(png), value => value.charCodeAt(0))], 'screenshot.png', { type: 'image/png' }));
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    element.dispatchEvent(event);
  }, PNG);
  await expect(sidebar.locator('.zrp-image-chip')).toBeVisible();
  await input.press('Enter');
  if (scenario.capture === 'network-lag') {
    await expect(sidebar.locator('.zrp-message-assistant')).toContainText('完整回答的最后一句。', { timeout: 20000 });
    const progressAt = await sidebar.evaluate(() => events.find(event => event.type === 'progress'
      && event.text?.includes('完整回答的最后一句。'))?.receivedAt);
    const availableAt = await web.evaluate(() => window.answerAvailableAt);
    const renderedAt = await sidebar.evaluate(() => window.answerRenderedAt);
    expect(progressAt - availableAt).toBeLessThan(1000);
    expect(renderedAt - availableAt).toBeLessThan(1000);
    expect(await sidebar.evaluate(() => events.some(event => event.type === 'answer'))).toBe(false);
    test.info().annotations.push({ type: 'relay-latency-ms', description: String(progressAt - availableAt) });
    test.info().annotations.push({ type: 'display-latency-ms', description: String(renderedAt - availableAt) });
    await web.evaluate(() => window.finishFixtureStream());
  }
  await expect.poll(() => sidebar.evaluate(() => events.filter(event => event.type === 'answer' && !event.error).length), { timeout: 45000 }).toBe(1);
  const result = await sidebar.evaluate(() => ({
    answer: events.findLast(event => event.type === 'answer'),
    notices: events.filter(event => event.notice),
    fractions: document.querySelectorAll('mfrac').length,
    width: document.querySelector('.zrp-panel').clientWidth,
    scroll: document.querySelector('.zrp-panel').scrollWidth,
  }));
  const inputDiagnostic = result.answer.error ? await web.evaluate(() => {
    const editor = document.querySelector('#prompt-textarea');
    const wanted = fixtureTask.messages.filter(message => message.type === 'text').map(message => message.text).join('\n\n');
    const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
    const actual = normalize(editor.innerText || editor.textContent);
    const expected = normalize(wanted);
    let offset = 0; while (offset < Math.min(actual.length, expected.length) && actual[offset] === expected[offset]) offset++;
    return { actualLength: actual.length, expectedLength: expected.length, offset,
      actual: actual.slice(Math.max(0, offset - 40), offset + 100), expected: expected.slice(Math.max(0, offset - 40), offset + 100) };
  }) : null;
  expect(result.answer.error, JSON.stringify(inputDiagnostic)).toBe('');
  expect(result.answer.text).toContain('完整回答的最后一句。');
  expect(result.answer.text).not.toMatch(/旧回答|重复字形/);
  if (scenario.fault?.startsWith('background')) {
    expect(await web.evaluate(() => document.visibilityState)).toBe('hidden');
    await expect(web.locator('message-content[data-message-id="answer-new"]')).toHaveText('回答前半段');
    await expect(web.locator('button[aria-label="Stop generating"]')).toHaveCount(1);
  }
  expect(result.fractions).toBe(1);
  await expect(sidebar.locator('.zrp-message-error')).toHaveCount(0);
  await expect(input).toBeEnabled();
  if (scenario.fault === 'relay-timeout') {
    expect(await sidebar.evaluate(() => events.some(event => event.type === 'answer' && event.error))).toBe(true);
    await expect(sidebar.getByText('网页联动失败；请查看上方提示。')).toHaveCount(0);
  }
  expect(result.notices).toEqual([]);
  expect(result.scroll).toBeLessThanOrEqual(result.width + 1);
  expect(await web.evaluate(() => ({ uploads, sends, imagePastes }))).toEqual({ uploads: 1, sends: 1, imagePastes: scenario.upload === 'file' ? 0 : 1 });
  await expect(web.locator('#drop-overlay')).toHaveCount(0);
  expect(await web.evaluate(() => notices.filter(text => /失败|未能|手动/.test(text)))).toEqual([]);
  expect(errors).toEqual([]);
  await sidebar.evaluate(() => { panel.destroy(); store.destroy(); });
});
}
