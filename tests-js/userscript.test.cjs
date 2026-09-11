const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', 'zotero-research-webai.user.js'),
  'utf8',
);
const fixtureWindows = new Set();
test.after(() => { for (const window of fixtureWindows) window.close(); });

function setup(url = 'https://gemini.google.com/app', html = '<!doctype html><body></body>', beforeEval) {
  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  fixtureWindows.add(dom.window);
  dom.window.__ZRA_TEST__ = {};
  dom.window.GM_getValue = () => '';
  dom.window.GM_setValue = () => {};
  dom.window.GM_addValueChangeListener = () => {};
  dom.window.GM_registerMenuCommand = () => {};
  dom.window.GM_notification = () => {};
  dom.window.GM_xmlhttpRequest = () => ({ abort: () => {} });
  dom.window.GM_info = { script: { version: 'test' } };
  dom.window.unsafeWindow = dom.window;
  dom.window.TextDecoder = TextDecoder;
  dom.window.TextEncoder = TextEncoder;
  // Parser-only fixtures do not run browser lifecycle timers.
  dom.window.setInterval = () => 0;
  // jsdom lacks DataTransfer; the userscript only needs files/items here.
  dom.window.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; }
  };
  dom.window.DragEvent = class extends dom.window.Event {
    constructor(type, init) { super(type, init); this.dataTransfer = init && init.dataTransfer; }
  };
  dom.window.ClipboardEvent = class extends dom.window.Event {
    constructor(type, init) { super(type, init); this.clipboardData = init && init.clipboardData; }
  };
  if (beforeEval) beforeEval(dom.window);
  dom.window.eval(SOURCE);
  dom.window.__ZRA_TEST__.window = dom.window;
  return dom.window.__ZRA_TEST__;
}

test('siteConfig routes each supported host', () => {
  const cases = [
    ['https://gemini.google.com/app', 'Gemini'],
    ['https://chat.deepseek.com/', 'DeepSeek'],
    ['https://chatgpt.com/', 'ChatGPT'],
    ['https://www.kimi.com/', 'Kimi'],
    ['https://kimi.moonshot.cn/', 'Kimi'],
    ['https://claude.ai/new', 'Claude'],
    ['https://aistudio.google.com/prompts/new_chat', 'AIStudio'],
  ];
  for (const [url, expected] of cases) {
    const api = setup(url);
    assert.equal(api.siteConfig()?.name, expected, url);
  }
  assert.equal(setup('https://example.com/').siteConfig(), null);
});

test('parseChatGPT assembles SSE deltas and honors [DONE]', () => {
  const api = setup();
  const raw = [
    'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["你好"]},"status":"in_progress"}}',
    'data: {"v":[{"p":"/message/content/parts/0","v":"，继续"}]}',
    'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["你好，继续"]},"status":"finished_successfully"}}',
    'data: [DONE]',
    '',
  ].join('\n');
  const parsed = api.parseChatGPT(raw);
  assert.equal(parsed.text, '你好，继续');
  assert.equal(parsed.done, true);
});

test('ChatGPT reasoning-message completion is not answer completion', () => {
  const api = setup('https://chatgpt.com/');
  const parsed = api.parseChatGPT('data: ' + JSON.stringify({ message: {
    id: 'thinking', author: { role: 'assistant' }, channel: 'analysis',
    content: { content_type: 'text', parts: ['推理过程，不是最终答案'] },
    status: 'finished_successfully', end_turn: false,
  } }) + '\n\n');
  assert.equal(parsed.text, '');
  assert.equal(parsed.done, false);
  api.window.close();
});

test('ChatGPT compact root snapshots and inherited append paths preserve every fragment', () => {
  const api = setup('https://chatgpt.com/');
  const raw = [
    { v: { message: { id: 'answer', author: { role: 'assistant' }, channel: 'final',
      content: { content_type: 'text', parts: ['第一段'] }, status: 'in_progress' } } },
    { p: '/message/content/parts/0', o: 'append', v: '\n公式：' },
    { v: '\\[x=1\\]' },
    { v: '\n最后的结论。' },
  ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n';
  const parsed = api.parseChatGPT(raw);
  assert.equal(parsed.text, '第一段\n公式：\\[x=1\\]\n最后的结论。');
  assert.equal(parsed.done, true);
  api.window.close();
});

test('ChatGPT final DOM is bound to the new turn and preserves math without duplicated glyphs', async (t) => {
  const api = setup('https://chatgpt.com/', '<!doctype html><body><main id="main">'
    + '<article><div data-message-author-role="assistant" data-message-id="old">上一轮旧答案</div><button aria-label="Copy">复制</button></article>'
    + '</main><form><textarea id="prompt-textarea"></textarea></form></body>');
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true;
  connector.currentTaskId = 'math-turn';
  connector.isSendingUpdate = true;
  const intervals = [];
  api.window.setInterval = (...args) => { const timer = setInterval(...args); intervals.push(timer); return timer; };
  api.window.clearInterval = clearInterval;
  t.after(() => intervals.forEach(clearInterval));
  t.after(() => connector.stopDomWatcher());
  connector.startDomWatcher();
  assert.equal(connector.accumulatedText, '', 'old answer must not satisfy a new task');
  const main = api.window.document.getElementById('main');
  const user = api.window.document.createElement('div');
  user.setAttribute('data-message-author-role', 'user'); user.textContent = '请解释公式';
  main.appendChild(user);
  const turn = api.window.document.createElement('article');
  turn.innerHTML = '<div data-message-author-role="assistant" data-message-id="new">'
    + '<p>新答案：<strong>关键公式</strong></p>'
    + '<div data-math-source="\\frac{a}{b}"><span class="katex-display"><span class="katex">'
    + '<span class="katex-html">重复字形ab</span></span></span></div>'
    + '<p>最后的结论。</p></div><button data-testid="copy-turn-action-button">复制</button>';
  main.appendChild(turn);
  const stop = api.window.document.createElement('button');
  stop.setAttribute('aria-label', 'Stop generating'); main.appendChild(stop);
  connector.onNewData('网络只拿到前半段', false, 'network');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.match(connector.accumulatedText, /\$\$\\frac\{a\}\{b\}\$\$/);
  assert.match(connector.accumulatedText, /最后的结论/);
  assert.doesNotMatch(connector.accumulatedText, /重复字形|上一轮|复制/);
  assert.equal(connector.doneSignal, false, 'a visible stop control vetoes completion');
  stop.remove();
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal(connector.doneSignal, true);
  const md = require('../addon/content/markdown.js');
  const rendered = api.window.document.createElement('div');
  rendered.appendChild(md.renderMarkdown(api.window.document, connector.accumulatedText));
  assert.equal(rendered.querySelectorAll('mfrac').length, 1);
  assert.match(rendered.textContent, /最后的结论/);
});

test('parseChatGPT treats the latest message snapshot as authoritative', () => {
  const api = setup('https://chatgpt.com/');
  const raw = [
    `data: ${JSON.stringify({
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['完整回答第一段\n第二段及结尾'] },
        status: 'in_progress',
      },
    })}`,
    `data: ${JSON.stringify({
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['完整回答第一段'] },
        status: 'in_progress',
      },
    })}`,
    'data: [DONE]',
    '',
  ].join('\n');

  const parsed = api.parseChatGPT(raw);
  assert.equal(parsed.text, '完整回答第一段');
  assert.equal(parsed.done, true);
});

test('parseChatGPT append patches preserve repeated deltas', () => {
  const api = setup('https://chatgpt.com/');
  const raw = [
    `data: ${JSON.stringify({ v: [{ p: '/message/content/parts/0', o: 'append', v: 'ha' }] })}`,
    `data: ${JSON.stringify({ v: [{ p: '/message/content/parts/0', o: 'append', v: 'ha' }] })}`,
    `data: ${JSON.stringify({ v: [{ p: '/message/content/parts/0', o: 'append', v: 'a' }] })}`,
    `data: ${JSON.stringify({ v: [{ p: '/message/content/parts/0', o: 'append', v: 'a' }] })}`,
    'data: [DONE]',
    '',
  ].join('\n');

  assert.equal(api.parseChatGPT(raw).text, 'hahaaa');
});

test('parseChatGPT applies replace and append patch operations', () => {
  const api = setup('https://chatgpt.com/');
  const raw = [
    `data: ${JSON.stringify({ v: [{ p: '/message/content/parts/0', o: 'replace', v: '替换后的正文' }] })}`,
    `data: ${JSON.stringify({ v: [{ p: '/message/content/parts/0', o: 'append', v: '，还有结尾' }] })}`,
    `data: ${JSON.stringify({ done: true })}`,
    '',
  ].join('\n');

  const parsed = api.parseChatGPT(raw);
  assert.equal(parsed.text, '替换后的正文，还有结尾');
  assert.equal(parsed.done, true);
});

test('parseChatGPT remove patch clears the target before reading its value', () => {
  const api = setup('https://chatgpt.com/');
  const raw = [
    `data: ${JSON.stringify({ v: [{ p: '/message/content/parts/0', o: 'replace', v: '正文' }] })}`,
    `data: ${JSON.stringify({ v: [{ p: '/message/content/parts/0', o: 'remove' }] })}`,
    'data: [DONE]',
    '',
  ].join('\n');

  assert.equal(api.parseChatGPT(raw).text, '');
});

test('parseChatGPT removes internal citation markers from the visible answer', () => {
  const api = setup();
  const puaStart = String.fromCodePoint(0xE200);
  const puaSeparator = String.fromCodePoint(0xE202);
  const puaEnd = String.fromCodePoint(0xE201);
  const raw = [
    `data: ${JSON.stringify({
      message: {
        author: { role: 'assistant' },
        content: {
          content_type: 'text',
          parts: [
            `先看结论${puaStart}filecite${puaSeparator}turn0file0${puaEnd}，然后说明`
              + `${puaStart}felicite${puaSeparator}return0file0${puaSeparator}L97-L108${puaEnd}。`,
          ],
        },
        status: 'finished_successfully',
      },
    })}`,
    'data: [DONE]',
    '',
  ].join('\n');

  const parsed = api.parseChatGPT(raw);
  assert.equal(parsed.text, '先看结论，然后说明。');
  assert.doesNotMatch(parsed.text, /filecite|felicite|return0file0|turn0file0/);
});

test('ChatGPT citation cleanup preserves unrelated PUA and removes incomplete markers', () => {
  const api = setup('https://chatgpt.com/');
  const puaStart = String.fromCodePoint(0xE200);
  const puaSeparator = String.fromCodePoint(0xE202);
  const puaEnd = String.fromCodePoint(0xE201);
  const ordinaryPua = String.fromCodePoint(0xE900);
  const marker = `${puaStart}filecite${puaSeparator}turn0file0${puaEnd}`;

  assert.equal(
    api.stripChatGPTInternalCitations(`前${ordinaryPua}中${marker}后`),
    `前${ordinaryPua}中后`,
  );
  assert.equal(
    api.stripChatGPTInternalCitations(`前${puaStart}filecite${puaSeparator}turn0file后`),
    '前后',
  );
  assert.equal(api.stripChatGPTInternalCitations('前filecite turn0file后'), '前后');
  assert.equal(api.stripChatGPTInternalCitations('普通 cite 文字'), '普通 cite 文字');
});

test('ChatGPT common relay boundary also removes citations from DOM fallback text', () => {
  const api = setup('https://chatgpt.com/');
  const connector = api.connector;
  const start = String.fromCodePoint(0xE200);
  const separator = String.fromCodePoint(0xE202);
  const end = String.fromCodePoint(0xE201);
  const marker = `${start}filecite${separator}turn0file0${separator}L86-L107${end}`;
  connector.isRunning = true;

  connector.onNewData(`这里的 PDF 第1页）${marker}\n\n具体来说，这是虚拟仪器。`, false);

  assert.equal(connector.accumulatedText, '这里的 PDF 第1页）\n\n具体来说，这是虚拟仪器。');
});

test('parseDeepSeek separates THINK and RESPONSE blocks', () => {
  const api = setup();
  const raw = [
    'data: {"v":[{"type":"THINK","content":"推理中"}]}',
    'data: {"v":[{"type":"RESPONSE","content":"答案"}]}',
    'data: {"v":[{"type":"RESPONSE","content":"第二段"}]}',
    '',
  ].join('\n');
  const parsed = api.parseDeepSeek(raw);
  assert.equal(parsed.text, '<think>推理中</think>\n答案第二段');
});

test('parseKimi collects text blocks and explicit done frame', () => {
  const api = setup();
  const raw = [
    'data: {"block":{"text":{"content":"部分"}}}',
    'data: {"block":{"text":{"content":"部分答案"}}}',
    'data: {"done":true}',
    '',
  ].join('\n');
  const parsed = api.parseKimi(raw);
  assert.equal(parsed.text, '部分答案');
  assert.equal(parsed.done, true);
});

test('parseClaude concatenates content_block_delta', () => {
  const api = setup();
  const raw = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Cla"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"ude"}}',
    '',
  ].join('\n');
  assert.equal(api.parseClaude(raw).text, 'Claude');
});

test('parseGemini extracts response text and terminal frame', () => {
  const api = setup();
  // Frame shape: record[2] parses to inner; inner[4][0] = result;
  // result[1][0] = response text; result[37][0][0] = think text.
  const result = [];
  result[1] = ['回答正文'];
  result[37] = [['思考']];
  const inner = [];
  inner[4] = [result];
  const payload = JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]);
  const raw = `)]}\'\n\n${payload.length}\n${payload}\n10\n[["e",10,null,null,null]]\n`;
  const parsed = api.parseGemini(raw);
  assert.equal(parsed.text, '<think>思考</think>\n回答正文');
  assert.equal(parsed.done, true);
});

function geminiWire(text, done = false) {
  const result = []; result[1] = [text];
  const inner = []; inner[4] = [result];
  return JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]) + (done ? '\n[["e",10,null]]' : '');
}

function backgroundGemini(t) {
  let worker;
  const wakeups = [];
  const api = setup('https://gemini.google.com/app', '<body></body>', window => {
    window.URL.createObjectURL = () => 'blob:worker-fixture';
    window.Worker = class {
      constructor() { worker = this; }
      postMessage(message) { wakeups.push(message); }
    };
    Object.defineProperty(window.document, 'visibilityState', { get: () => 'hidden' });
    Object.defineProperty(window.document, 'hidden', { get: () => true });
  });
  t.after(() => api.window.close());
  const c = api.connector;
  c.currentTaskId = 'background-gemini'; c.isRunning = true; c.isSendingUpdate = true;
  c.captureGeminiTurn();
  api.window.document.body.insertAdjacentHTML('beforeend', '<user-query>解释公式</user-query>'
    + '<model-response><message-content>第一句。</message-content><div aria-busy="true"></div></model-response>'
    + '<button aria-label="Stop generating">Stop</button>');
  c.sampleGeminiAnswer();
  return { api, c, wakeups, wake: message => worker.onmessage({ data: message.id }) };
}

test('background Gemini streams past its frozen first DOM sentence without foregrounding', (t) => {
  const { api, c } = backgroundGemini(t);
  const full = '第一句。\n\\[\\frac{a}{b}\\]\n最后一段结论。';
  c.proxy.handleCapture(geminiWire(full), c.currentTaskId);
  assert.equal(c.accumulatedText, full, 'network progress must not wait for a DOM repaint');
  c.sampleGeminiAnswer();
  assert.equal(c.accumulatedText, full, 'stale DOM cannot overwrite newer network text');
  assert.equal(c.doneSignal, false, 'partial response is not completion');
  assert.equal(api.window.document.querySelector('message-content').textContent, '第一句。');
});

test('Gemini forwards a newer visible answer while a network snapshot is still behind', (t) => {
  const { api, c } = backgroundGemini(t);
  c.proxy.handleCapture(geminiWire('第一句。'), c.currentTaskId);
  const full = '第一句。接下来的解释已经在网页显示，但网络快照尚未追上。';
  api.window.document.querySelector('message-content').textContent = full;
  c.sampleGeminiAnswer();
  assert.equal(c.accumulatedText, full, 'available page text must not wait for the next network snapshot');
  assert.equal(c.doneSignal, false, 'more text alone does not mean completion');
  c.proxy.handleCapture(geminiWire('第一句。接下来的解释'), c.currentTaskId);
  assert.equal(c.accumulatedText, full, 'a lagging prefix must not roll back displayed text');
  c.proxy.handleCapture(geminiWire(full + '现在网络也继续了。'), c.currentTaskId);
  assert.equal(c.accumulatedText, full + '现在网络也继续了。');
  c.sampleGeminiAnswer();
  assert.equal(c.accumulatedText, full + '现在网络也继续了。', 'source arbitration works in both directions');
});

test('Gemini accepts DOM extensions across whitespace and a separate network thinking block', (t) => {
  const { api, c } = backgroundGemini(t);
  const result = []; result[1] = ['第一句。\n\n已有解释。']; result[37] = [['推理过程']];
  const inner = []; inner[4] = [result];
  c.proxy.handleCapture(JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]), c.currentTaskId);
  const full = '第一句。\n已有解释。\n新的一段内容。';
  api.window.document.querySelector('message-content').textContent = full;
  c.sampleGeminiAnswer();
  assert.equal(c.accumulatedText, full);
  assert.equal(c.doneSignal, false);
});

test('Gemini still accepts network corrections and a shorter terminal answer after a DOM extension', (t) => {
  const { api, c, wakeups, wake } = backgroundGemini(t);
  c.proxy.handleCapture(geminiWire('第一句。'), c.currentTaskId);
  api.window.document.querySelector('message-content').textContent = '第一句。网页提前显示的解释。';
  c.sampleGeminiAnswer();
  assert.equal(c.accumulatedText, '第一句。网页提前显示的解释。');
  c.proxy.handleCapture(geminiWire('更正：这是新的解释。'), c.currentTaskId);
  assert.equal(c.accumulatedText, '更正：这是新的解释。', 'not a choose-longest policy');
  api.window.document.querySelector('message-content').textContent += '过时的后续内容。';
  c.sampleGeminiAnswer();
  assert.equal(c.accumulatedText, '更正：这是新的解释。', 'an incompatible DOM answer cannot override a correction');
  c.proxy.handleCapture(geminiWire('结论。', true), c.currentTaskId);
  const completion = wakeups.findLast(message => message.ms === 3500);
  assert.ok(completion);
  wake(completion);
  assert.equal(c.accumulatedText, '结论。');
  assert.equal(c.doneSignal, true);
});

test('background Gemini completes on terminal plus closed transport using the worker, not stale UI', (t) => {
  const { c, wakeups, wake } = backgroundGemini(t);
  const release = c.proxy.beginRequest(c.currentTaskId);
  const full = '第一句。\n最终回答。';
  c.proxy.handleCapture(geminiWire(full, true), c.currentTaskId);
  assert.equal(c.doneSignal, false, 'must wait until transport actually closes');
  release();
  const completion = wakeups.find(message => message.ms === 3500);
  assert.ok(completion, 'network completion must be paced independently of page timers');
  wake(completion);
  assert.equal(c.doneSignal, true);
  assert.equal(c.accumulatedText, full);
});

test('Gemini captures the page XMLHttpRequest when the userscript sandbox has a different constructor', async (t) => {
  let PageXHR;
  const api = setup('https://gemini.google.com/app', '<!doctype html><body></body>', window => {
    PageXHR = class extends window.EventTarget {
      open() {}
      complete(text) {
        this.dispatchEvent(new window.Event('loadstart'));
        this.readyState = 4; this.responseText = text;
        this.dispatchEvent(new window.Event('readystatechange'));
        this.dispatchEvent(new window.Event('loadend'));
      }
    };
    window.unsafeWindow = { XMLHttpRequest: PageXHR };
  });
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true; connector.currentTaskId = 'page-realm'; connector.isSendingUpdate = true;
  const result = []; result[1] = ['网页已经完整回答，侧栏必须收到。'];
  const inner = []; inner[4] = [result];
  const xhr = new PageXHR();
  xhr.open('POST', '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate');
  xhr.complete(JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]) + '\n[["e",10,null,null,null]]');
  assert.equal(connector.accumulatedText, '网页已经完整回答，侧栏必须收到。');
  assert.equal(connector.doneSignal, false, 'wait for the post-transport quiet window');
  assert.equal(connector.proxy.activeRequests.size, 0);
  await new Promise(resolve => setTimeout(resolve, 3600));
  assert.equal(connector.doneSignal, true);
});

test('background Gemini pauses, new requests and cancellation cannot finish an old response', (t) => {
  const { c, wakeups, wake } = backgroundGemini(t);
  c.proxy.handleCapture(geminiWire('第一句。中间部分。'), c.currentTaskId);
  c.proxy.scheduleIdle(c.currentTaskId);
  assert.equal(wakeups.some(message => message.ms === 3500), false, 'no terminal: do not complete on idle');
  c.proxy.handleCapture(geminiWire('第一句。第一条流结束。', true), c.currentTaskId);
  const stale = wakeups.find(message => message.ms === 3500);
  assert.ok(stale);
  const release = c.proxy.beginRequest(c.currentTaskId);
  wake(stale);
  assert.equal(c.doneSignal, false, 'a following request cancels the earlier completion');
  c.proxy.handleCapture(geminiWire('第一句。第二条流的最终答案。', true), c.currentTaskId);
  release();
  const next = wakeups.filter(message => message.ms === 3500).at(-1);
  c.resetTaskState('cancelled');
  c.currentTaskId = 'next-task';
  wake(next);
  assert.equal(c.accumulatedText, '');
  assert.equal(c.doneSignal, false, 'old completion must not end the next question');
});

test('background Gemini retry uses the worker and transmits the latest text once', async (t) => {
  const { api, c, wakeups, wake } = backgroundGemini(t);
  const updates = [];
  api.window.GM_xmlhttpRequest = options => {
    updates.push(JSON.parse(options.data));
    queueMicrotask(() => updates.length === 1 ? options.onerror() : reply(options, { ok: true }));
    return { abort() {} };
  };
  c.isSendingUpdate = false;
  await c.performUpdate();
  const retry = wakeups.find(message => message.ms === 500);
  assert.ok(retry, 'retry must not depend on a foreground page timer');
  c.accumulatedText = '最新完整回答'; c.doneSignal = true;
  wake(retry);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(updates.map(update => update.text), ['第一句。', '最新完整回答']);
  assert.equal(updates[1].isDone, true);
  wake(retry);
  assert.equal(updates.length, 2, 'a late timer must not replay a delivered answer');
});

test('Gemini thinking-only terminal data never replaces or completes the answer', (t) => {
  const { c, wakeups } = backgroundGemini(t);
  const result = []; result[37] = [['仍在思考']];
  const inner = []; inner[4] = [result];
  c.proxy.handleCapture(JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]) + '\n[["e",10]]', c.currentTaskId);
  assert.equal(c.accumulatedText, '第一句。');
  assert.equal(wakeups.some(message => message.ms === 3500), false);
});

test('Gemini DOM fallback handles user-query with query-text instead of user-query-content', (t) => {
  const api = setup('https://gemini.google.com/app', '<!doctype html><body><main><user-query><div class="query-text">旧问题</div></user-query><model-response><message-content>旧答案</message-content></model-response></main></body>');
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true; connector.currentTaskId = 'query-variant'; connector.isSendingUpdate = true;
  connector.captureGeminiTurn();
  api.window.document.querySelector('main').insertAdjacentHTML('beforeend', '<user-query><div class="query-text">解析图片</div></user-query><model-response><message-content><p>图片分析已经完成。</p></message-content><button data-test-id="copy-button">复制</button></model-response>');
  connector.sampleGeminiAnswer();
  connector.geminiStableSince = Date.now() - 2000;
  connector.sampleGeminiAnswer();
  assert.equal(connector.accumulatedText, '图片分析已经完成。');
  assert.equal(connector.doneSignal, true);
});

test('Gemini reads the reported nested structured-content-container without duplicating its message-content', (t) => {
  const api = setup('https://gemini.google.com/app', '<!doctype html><body><main></main></body>');
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true; connector.currentTaskId = 'structured-body'; connector.isSendingUpdate = true;
  connector.captureGeminiTurn();
  api.window.document.querySelector('main').insertAdjacentHTML('beforeend',
    '<user-query><user-query-content>解析图片</user-query-content></user-query>'
    + '<model-response class="enable-lr26-response-chrome-updates ng-star-inserted">'
    + '<structured-content-container class="model-response-text processing-state-visible ng-star-inserted">'
    + '<message-content id="message-content-id-r_fixture"><p>已完成的图片解释，正文仅出现一次。</p></message-content>'
    + '</structured-content-container></model-response>');
  connector.sampleGeminiAnswer();
  assert.equal(connector.geminiUserNodes().length, 1);
  assert.equal(connector.accumulatedText, '已完成的图片解释，正文仅出现一次。');
  assert.equal(connector.lastDataSource, 'gemini-dom');
});

test('task diagnostics retain captured source and completion after the relay clears active state', async (t) => {
  const api = setup();
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true;
  connector.deliverImages = async () => 'paste';
  connector.fillInput = async () => true;
  connector.inputAccepts = () => true;
  connector.handleSend = async () => true;
  connector.startDomWatcher = () => {};
  connector.startPolling = () => {};
  api.window.GM_xmlhttpRequest = options => {
    queueMicrotask(() => options.onload({ status: 200, responseText: '{"ok":true}' }));
    return { abort() {} };
  };
  await connector.executeTask({ id: 'trace', messages: [{ type: 'text', text: 'PRIVATE_QUESTION' }, { type: 'image', data: 'PRIVATE_IMAGE' }] });
  connector.onNewData('PRIVATE_ANSWER', true, 'gemini-dom');
  await settleBrowser();
  const report = connector.diagnosticReport();
  assert.equal(report.taskActive, false);
  assert.equal(report.lastTask.phase, 'finished');
  assert.equal(report.lastTask.endReason, 'delivered');
  assert.equal(report.lastTask.imageCount, 1);
  assert.equal(report.lastTask.sendAcknowledged, true);
  assert.equal(report.lastTask.captureSource, 'gemini-dom');
  assert.equal(report.lastTask.capturedChars, 'PRIVATE_ANSWER'.length);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/);
});

test('mergeStreamText handles delta and cumulative frames without duplication', () => {
  const api = setup();
  assert.equal(api.mergeStreamText('', 'abc'), 'abc');
  assert.equal(api.mergeStreamText('abc', 'abc'), 'abc');
  assert.equal(api.mergeStreamText('abc', 'abcdef'), 'abcdef');
  assert.equal(api.mergeStreamText('abcdef', 'abc'), 'abcdef');
  assert.equal(api.mergeStreamText('abc', 'def'), 'abcdef');
});

test('network fallback does not replace a complete SSE answer with a shorter DOM snapshot', () => {
  const api = setup('https://chatgpt.com/');
  const connector = api.connector;
  connector.isRunning = true;
  connector.onNewData('SSE 完整回答，后面还有很多内容。', false);
  connector.onNewData('DOM 旧回答', false);
  connector.onNewData('', true);
  assert.equal(connector.accumulatedText, 'SSE 完整回答，后面还有很多内容。');
  assert.equal(connector.doneSignal, true);
});

test('ChatGPT pause between live stream chunks must not complete or truncate the answer', async (t) => {
  const api = setup('https://chatgpt.com/');
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true;
  connector.currentTaskId = 'slow-chatgpt-answer';
  connector.isSendingUpdate = true;
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const reading = connector.proxy.readStream(stream, connector.currentTaskId);
  t.after(() => { try { controller.close(); } catch (_) {} });
  const frame = text => 'data: ' + JSON.stringify({ message: {
    id: 'answer-1', author: { role: 'assistant' }, channel: 'final',
    content: { content_type: 'text', parts: [text] }, status: 'in_progress',
  } }) + '\n\n';
  controller.enqueue(new TextEncoder().encode(frame('第一段，后面还有推导。')));
  await new Promise(resolve => setTimeout(resolve, 3800));
  assert.equal(connector.doneSignal, false, 'a 3.5 second pause is not an end-of-answer signal');
  controller.enqueue(new TextEncoder().encode(frame('第一段，后面还有推导。\n推导完毕，最后的结论。') + 'data: [DONE]\n\n'));
  controller.close();
  await reading;
  assert.match(connector.accumulatedText, /最后的结论/);
  assert.equal(connector.doneSignal, false, 'transport completion still waits for the bound rendered answer');
});

test('network source adopts short replacements and permanently outranks stale DOM', () => {
  const api = setup('https://chatgpt.com/');
  const connector = api.connector;
  connector.isRunning = true;
  connector.onNewData('DOM 上一轮很长的旧回答。', false, 'dom');
  connector.onNewData('SSE 当前回答，完整版本', false, 'network');
  connector.onNewData('SSE 短 replace', false, 'network');
  connector.onNewData('DOM 截断但更长的旧回答。', false, 'dom');
  assert.equal(connector.accumulatedText, 'SSE 短 replace');
  api.window.close();
});

test('network readStream preserves UTF-8 when a code point crosses chunks', async (t) => {
  const api = setup('https://chatgpt.com/');
  const connector = api.connector;
  connector.isRunning = true;
  connector.currentTaskId = 'utf8-task';
  const body = [
    `data: ${JSON.stringify({
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['跨境'] },
        status: 'finished_successfully',
      },
    })}`,
    'data: [DONE]',
    '',
  ].join('\n');
  const bytes = new TextEncoder().encode(body);
  const splitAt = new TextEncoder().encode(body.slice(0, body.indexOf('跨'))).length + 1;
  const chunks = [bytes.slice(0, splitAt), bytes.slice(splitAt)];
  let index = 0;
  await connector.proxy.readStream({
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[index++] };
        },
      };
    },
  }, 'utf8-task');
  assert.equal(connector.accumulatedText, '跨境');
  t.after(() => api.window.close());
});

function browserHarness({ respond, initialLock } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://gemini.google.com/app', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const values = new Map(initialLock ? [['zra_relay_lock', JSON.stringify(initialLock)]] : []);
  const requests = [];
  const menus = new Map();
  let lockListener;
  Object.assign(dom.window, {
    __ZRA_TEST__: {},
    GM_getValue: (key, fallback) => values.get(key) ?? fallback,
    GM_setValue: (key, value) => values.set(key, value),
    GM_addValueChangeListener: (_key, listener) => { lockListener = listener; },
    GM_registerMenuCommand: (name, fn) => menus.set(name, fn),
    GM_notification() {},
    GM_info: { script: { version: 'test' } },
    GM_xmlhttpRequest(options) {
      const request = { ...options, payload: JSON.parse(options.data), aborted: false };
      requests.push(request);
      if (respond) respond(request);
      return { abort() { request.aborted = true; } };
    },
    unsafeWindow: dom.window,
  });
  dom.window.eval(SOURCE);
  return {
    dom, requests, menus, values,
    takeOver() {
      const next = JSON.stringify({ isLocked: true, tabId: 'another-page', expiresAt: Date.now() + 60000 });
      values.set('zra_relay_lock', next);
      lockListener?.('zra_relay_lock', '', next, true);
    },
  };
}

const settleBrowser = () => new Promise(resolve => setTimeout(resolve, 10));
const reply = (req, body) => req.onload({ status: 200, responseText: JSON.stringify(body) });

test('heartbeat has an independent deadline when Tampermonkey fetch ignores timeout', async (t) => {
  const api = setup();
  t.after(() => api.window.close());
  const timers = new Map();
  let serial = 0, aborted = 0, request;
  api.window.setTimeout = (fn, ms) => { timers.set(++serial, { fn, ms }); return serial; };
  api.window.clearTimeout = id => timers.delete(id);
  api.window.GM_xmlhttpRequest = options => { request = options; return { abort() { aborted++; } }; };
  const connector = api.connector;
  connector.currentTaskId = 'hung-heartbeat';
  connector.isRunning = connector.isConnected = connector.supportsHeartbeat = true;
  const pending = connector.sendHeartbeat();
  assert.equal(request.anonymous, true);
  const deadline = [...timers.values()].find(timer => timer.ms === 5000);
  assert.ok(deadline, 'a native GM timeout alone cannot bound anonymous/fetch requests');
  deadline.fn();
  await pending;
  assert.equal(aborted, 1);
  assert.match(connector.lastHeartbeatError, /Timeout/);
  assert.equal(timers.size, 0, 'deadline must be released');
  reply(request, { ok: true, complete: true });
  await Promise.resolve();
  assert.equal(connector.currentTaskId, 'hung-heartbeat', 'a late callback cannot end the current task');
});

test('Gemini terminal frame completes authoritative DOM without copy controls or hidden busy widgets', (t) => {
  const api = setup();
  t.after(() => api.window.close());
  const c = api.connector;
  c.isRunning = true; c.isSendingUpdate = true; c.currentTaskId = 'terminal-dom';
  c.captureGeminiTurn();
  api.window.document.body.insertAdjacentHTML('beforeend', '<user-query>问题</user-query>'
    + '<model-response><message-content><p>完整正文，含最终结论。</p></message-content>'
    + '<div hidden aria-busy="true"></div></model-response>');
  c.sampleGeminiAnswer();
  c.geminiStableSince = Date.now() - 10000;
  c.sampleGeminiAnswer();
  assert.equal(c.doneSignal, false, 'idle DOM alone does not prove the answer ended');
  c.proxy.handleCapture(JSON.stringify([['e', 10, null]]), c.currentTaskId);
  c.proxy.activeRequests.set(c.currentTaskId, 1);
  c.geminiStableSince = Date.now() - 10000;
  c.sampleGeminiAnswer();
  assert.equal(c.doneSignal, false, 'terminal frame must still wait for the active stream');
  c.proxy.activeRequests.clear();
  c.geminiStableSince = Date.now() - 2000;
  c.sampleGeminiAnswer();
  assert.equal(c.doneSignal, true, 'network completion must survive the DOM source-priority guard');
  assert.equal(c.accumulatedText, '完整正文，含最终结论。');
});

test('automatic browser handshake passes the Zotero 10 request gate', async (t) => {
  const h = browserHarness({ respond(req) {
    // Zotero's RequestHandler cancels browser requests without this protocol header.
    if (!req.headers['X-Zotero-Connector-API-Version']) req.onerror();
    else if (req.payload.action === 'connect') reply(req, { status: 'connected' });
  } });
  t.after(() => h.dom.window.close());
  await settleBrowser();
  assert.match(h.dom.window.document.getElementById('zra-relay-status').textContent, /已连接/);
  assert.equal(h.requests.find(r => r.payload.action === 'poll').headers['X-Zotero-Connector-API-Version'], '3');
});

test('diagnostic export preserves long JSON and lastTask without a native prompt', async (t) => {
  const h = browserHarness();
  t.after(() => h.dom.window.close());
  await settleBrowser();
  const report = {
    first: 'a'.repeat(1500), lastTask: { phase: 'finished', captureSource: 'gemini-dom', capturedChars: 4321 },
    last: '中'.repeat(4000), literal: '</textarea><script>throw Error("must stay text")</script>',
  };
  h.dom.window.__ZRA_TEST__.connector.diagnosticReport = () => report;
  let nativePrompts = 0;
  h.dom.window.prompt = () => { nativePrompts++; return null; };
  h.menus.get('联动诊断（复制给开发者）')();
  assert.equal(nativePrompts, 0, 'Chrome elides long native prompt values in the middle');
  const field = h.dom.window.document.querySelector('#zra-diagnostic-dialog textarea');
  assert.ok(field?.readOnly);
  assert.deepEqual(JSON.parse(field.value), report);
  assert.equal(field.selectionEnd, field.value.length);
  assert.equal(h.dom.window.document.querySelector('#zra-diagnostic-dialog script'), null);
  h.menus.get('联动诊断（复制给开发者）')();
  assert.equal(h.dom.window.document.querySelectorAll('#zra-diagnostic-dialog').length, 1);
  h.dom.window.document.querySelector('[data-zra-diag="close"]').click();
  assert.equal(h.dom.window.document.querySelector('#zra-diagnostic-dialog'), null);
});

test('diagnostic trace survives a new runtime without resuming or resending the old task', async (t) => {
  const first = setup();
  t.after(() => first.window.close());
  const c = first.connector;
  c.isRunning = true;
  c.deliverImages = async () => 'paste';
  c.fillInput = c.inputAccepts = c.handleSend = async () => true;
  c.startDomWatcher = () => {};
  await c.executeTask({ id: 'trace-reload', messages: [
    { type: 'text', text: 'PRIVATE_QUESTION' }, { type: 'image', data: 'PRIVATE_IMAGE' },
  ] });
  c.isSendingUpdate = true;
  c.onNewData('PRIVATE_ANSWER', false, 'gemini-dom');
  first.window.dispatchEvent(new first.window.Event('pagehide'));
  const stored = first.window.sessionStorage.getItem('zra-diagnostic-trace-v1');
  assert.ok(stored, 'a destroyed runtime must leave its task evidence behind');
  assert.doesNotMatch(stored, /PRIVATE_|sessionSecret/);
  const history = JSON.parse(stored);
  for (let index = 0; index < 5; index++) history.push({ runtime: { id: 'older-' + index }, events: [] });
  const second = setup(undefined, undefined, w => w.sessionStorage.setItem('zra-diagnostic-trace-v1', JSON.stringify(history)));
  t.after(() => second.window.close());
  const report = second.connector.diagnosticReport();
  assert.equal(report.lastTask, null, 'previous task is diagnostic history, not current work');
  assert.equal(second.connector.currentTaskId, null, 'do not automatically re-send an old prompt');
  const previous = report.recentRuntimes.find(entry => entry.runtime.id === c.runtime.id);
  assert.equal(previous.lastTask.id, 'trace-reload');
  assert.equal(previous.lastTask.capturedChars, 'PRIVATE_ANSWER'.length);
  assert.equal(previous.events.at(-1).event, 'pagehide');
  assert.notEqual(report.runtime.id, c.runtime.id);
  assert.equal(report.recentRuntimes.length, 4);
  assert.ok(report.collectedAt);
});

test('diagnostic trace retains a rejected answer update without storing the answer', async (t) => {
  const api = setup();
  t.after(() => api.window.close());
  const c = api.connector;
  c.isRunning = true;
  c.fillInput = c.inputAccepts = c.handleSend = async () => true;
  c.startDomWatcher = c.startPolling = () => {};
  api.window.GM_xmlhttpRequest = options => {
    queueMicrotask(() => options.onload({ status: 200, responseText: '{"error":"UNKNOWN_TASK"}' }));
    return { abort() {} };
  };
  await c.executeTask({ id: 'rejected-trace', messages: [{ type: 'text', text: 'PRIVATE_QUESTION' }] });
  c.onNewData('PRIVATE_ANSWER', true, 'gemini-dom');
  await settleBrowser();
  const trace = c.diagnosticReport().recentRuntimes[0];
  assert.equal(trace.lastTask.lastUpdate.error, 'UNKNOWN_TASK');
  assert.equal(trace.lastTask.lastUpdate.ok, false);
  assert.equal(trace.lastTask.lastUpdate.textLength, 'PRIVATE_ANSWER'.length);
  assert.ok(trace.events.some(entry => entry.event === 'update-response'));
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_/);
});

test('diagnostic trace is bounded and storage failure cannot stop task receipt', async (t) => {
  const api = setup();
  t.after(() => api.window.close());
  for (let index = 0; index < 60; index++) api.connector.recordDiagnostic('test-' + index);
  assert.equal(api.connector.diagnosticReport().recentRuntimes[0].events.length, 20);
  Object.defineProperty(api.window, 'sessionStorage', { get() { throw Error('blocked'); } });
  api.connector.isRunning = true;
  api.connector.fillInput = api.connector.inputAccepts = api.connector.handleSend = async () => true;
  api.connector.startDomWatcher = () => {};
  await api.connector.executeTask({ id: 'storage-blocked', messages: [{ type: 'text', text: 'hello' }] });
  const report = api.connector.diagnosticReport();
  assert.equal(report.lastTask.id, 'storage-blocked');
  assert.equal(report.lastTask.phase, 'waiting-answer');
  assert.equal(report.traceStorageAvailable, false);
});

test('diagnostic copy refreshes the snapshot at export time', async (t) => {
  const api = setup();
  t.after(() => api.window.close());
  let current = { lastTask: null };
  let copied;
  api.connector.diagnosticReport = () => current;
  Object.defineProperty(api.window.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
  api.connector.showDiagnostic();
  current = { lastTask: { phase: 'finished', capturedChars: 4321 } };
  api.window.document.querySelector('[data-zra-diag="copy"]').click();
  await settleBrowser();
  assert.deepEqual(JSON.parse(copied), current);
  assert.deepEqual(JSON.parse(api.window.document.querySelector('#zra-diagnostic-dialog textarea').value), current);
});

test('diagnostic task-poll evidence is not overwritten by subsequent empty polls', async (t) => {
  const h = browserHarness({ respond(req) {
    if (req.payload.action === 'connect') reply(req, { status: 'connected' });
  } });
  t.after(() => h.dom.window.close());
  await settleBrowser();
  const c = h.dom.window.__ZRA_TEST__.connector;
  // Exercise receipt independently of execution so a missing task trace can
  // still be distinguished from never having received a task in this runtime.
  c.executeTask = () => {};
  reply(h.requests.at(-1), { task: { id: 'received-without-execution', messages: [] } });
  await settleBrowser();
  reply(h.requests.at(-1), {});
  await settleBrowser();
  const trace = c.diagnosticReport().recentRuntimes[0];
  assert.equal(trace.lastTask, null);
  assert.equal(trace.lastPoll.taskId, null);
  assert.equal(trace.lastTaskPoll.taskId, 'received-without-execution');
  assert.equal(trace.lastTaskPoll.accepted, true);
});

test('reconnecting the same page cannot lose an image task to its aborted long poll', async (t) => {
  const store = require('../addon/content/relay.js').createRelayStore();
  const h = browserHarness({ respond(req) {
    const result = store[req.payload.action](req.payload);
    Promise.resolve(result).then(body => { if (!req.aborted) reply(req, body); });
  } });
  t.after(async () => {
    await h.dom.window.__ZRA_TEST__.connector.disconnect();
    store.destroy(); h.dom.window.close();
  });
  await settleBrowser();
  const connector = h.dom.window.__ZRA_TEST__.connector;
  // The seam under test is transport receipt, not the Gemini DOM. Keep the
  // real executeTask and diagnostics, but don't send anything to a real AI.
  connector.deliverImages = async () => 'paste';
  connector.fillInput = async () => true;
  connector.inputAccepts = () => true;
  connector.handleSend = async () => true;
  const firstPoll = h.requests.find(req => req.payload.action === 'poll');
  assert.ok(firstPoll);
  h.menus.get('🔗 连接 Zotero')();
  await settleBrowser();
  assert.equal(firstPoll.aborted, true);
  const id = store.enqueueTask({ messages: [
    { type: 'text', text: '解析图片' }, { type: 'image', data: 'aGVsbG8=', mediaType: 'image/png' },
  ] });
  await settleBrowser();
  assert.equal(connector.currentTaskId, id, 'the live page must receive the claimed task');
  assert.equal(connector.diagnosticReport().lastTask.imageCount, 1);
});

test('losing the tab lock cancels polling and never reclaims the connection', async (t) => {
  const h = browserHarness({ respond(req) {
    if (req.payload.action === 'connect') reply(req, { status: 'connected' });
  } });
  t.after(() => h.dom.window.close());
  await settleBrowser();
  const poll = h.requests.find(r => r.payload.action === 'poll');
  h.takeOver();
  assert.equal(poll.aborted, true);
  reply(poll, { error: 'SESSION_EXPIRED' });
  await settleBrowser();
  assert.equal(h.requests.filter(r => r.payload.action === 'connect').length, 1);
});

test('disconnect compensates a late successful handshake', async (t) => {
  const h = browserHarness({ respond(req) {
    if (req.payload.action === 'disconnect') reply(req, { status: 'disconnected' });
  } });
  t.after(() => h.dom.window.close());
  await settleBrowser();
  const connectRequest = h.requests[0];
  h.menus.get('🎊 断开 Zotero')();
  await settleBrowser();
  reply(connectRequest, { status: 'connected' });
  await settleBrowser();
  assert.equal(h.requests.filter(r => r.payload.action === 'disconnect').length, 2);
  assert.equal(h.requests.some(r => r.payload.action === 'poll'), false);
});

test('deliverImages 依次尝试通道，验证通过即返回', async (t) => {
  const dom = new JSDOM(
    '<!doctype html><body><textarea id="t"></textarea></body>',
    { url: 'https://gemini.google.com/app', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const values = new Map();
  t.after(() => dom.window.close());
  dom.window.__ZRA_TEST__ = {};
  Object.assign(dom.window, {
    GM_getValue: (k, f) => values.get(k) ?? f,
    GM_setValue: (k, v) => values.set(k, v),
    GM_addValueChangeListener: () => {},
    GM_registerMenuCommand: () => {},
    GM_notification: () => {},
    GM_info: { script: { version: 'test' } },
    GM_xmlhttpRequest: () => ({ abort() {} }),
    unsafeWindow: dom.window,
  });
  dom.window.setInterval = () => 0;
  // jsdom lacks these constructors; polyfill enough for the delivery paths.
  dom.window.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; }
  };
  dom.window.DragEvent = class extends dom.window.Event {
    constructor(type, init) { super(type, init); this.dataTransfer = init && init.dataTransfer; }
  };
  dom.window.ClipboardEvent = class extends dom.window.Event {
    constructor(type, init) { super(type, init); this.clipboardData = init && init.clipboardData; }
  };
  dom.window.eval(SOURCE);
  const connector = dom.window.__ZRA_TEST__.connector;
  assert.ok(connector, 'connector exported for tests');

  // A paste handler that registers an attachment preview (blob img), like a
  // real composer would; drop stays inert so the paste channel must win.
  let pasteFiles = 0;
  const textarea = dom.window.document.getElementById('t');
  textarea.addEventListener('paste', (event) => {
    pasteFiles = event.clipboardData ? event.clipboardData.files.length : 0;
    const img = dom.window.document.createElement('img');
    img.setAttribute('src', 'blob:zotero-test');
    textarea.parentElement.appendChild(img);
  });

  const channel = await connector.deliverImages([
    { data: Buffer.from('fakepng').toString('base64'), mediaType: 'image/png' },
  ]);
  assert.equal(channel, 'paste', 'paste channel verified via the blob preview');
  assert.equal(pasteFiles, 1, 'paste event carries the built file');
});

test('image task waits for a sibling upload card to finish, sends once and never asks for manual paste', async (t) => {
  const api = setup('https://chatgpt.com/', '<!doctype html><body><main id="main"></main>'
    + '<form><input type="file" accept="image/*"><div class="input-editor">'
    + '<div id="prompt-textarea" contenteditable="true"></div></div><div id="cards"></div>'
    + '<button id="composer-submit-button" type="button" disabled>发送</button></form></body>');
  t.after(() => api.window.close());
  api.window.Element.prototype.getBoundingClientRect = () => ({ width: 200, height: 30 });
  const connector = api.connector;
  connector.isRunning = true;
  const notices = [];
  connector.notifySidebar = async text => notices.push(text);
  let fileEvents = 0;
  let otherDeliveries = 0;
  let sends = 0;
  const fileInput = api.window.document.querySelector('input[type=file]');
  const button = api.window.document.querySelector('button');
  Object.defineProperty(fileInput, 'files', { writable: true, value: null });
  fileInput.addEventListener('change', () => {
    fileEvents++;
    // Acceptance is delayed beyond the old per-channel 2.6s cutoff.
    api.window.setTimeout(() => {
      const card = api.window.document.createElement('div');
      card.setAttribute('data-testid', 'attachment-card');
      card.setAttribute('aria-busy', 'true');
      card.textContent = fileInput.files[0].name + ' 上传中';
      api.window.document.getElementById('cards').appendChild(card);
      api.window.setTimeout(() => {
        card.setAttribute('aria-busy', 'false');
        card.textContent = fileInput.files[0].name;
        button.disabled = false;
      }, 150);
    }, 2800);
  });
  const editor = api.window.document.getElementById('prompt-textarea');
  editor.addEventListener('paste', event => { if (event.clipboardData?.files?.length) otherDeliveries++; });
  editor.addEventListener('drop', () => otherDeliveries++);
  button.addEventListener('click', () => { sends++; editor.textContent = ''; button.setAttribute('aria-label', 'Stop generating'); });
  await connector.executeTask({ id: 'image-task', messages: [
    { type: 'text', text: '请解释这张截图' },
    { type: 'image', mediaType: 'image/png', data: Buffer.from('test-image').toString('base64') },
  ] });
  assert.equal(sends, 1, 'accepted image and text must be auto-sent');
  assert.equal(fileEvents, 1);
  assert.equal(otherDeliveries, 0, 'a slow accepted upload must not be pasted/dropped again');
  assert.deepEqual(notices, []);
  assert.equal(connector.awaitingManualSend, false);
});

test('file-input 通道优先：accept 含 image 的输入框直接赋 files', async (t) => {
  const dom = new JSDOM(
    '<!doctype html><body><input type="file" id="f" accept="image/*"><div id="wrap"></div></body>',
    { url: 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const values = new Map();
  t.after(() => dom.window.close());
  dom.window.__ZRA_TEST__ = {};
  Object.assign(dom.window, {
    GM_getValue: (k, f) => values.get(k) ?? f,
    GM_setValue: (k, v) => values.set(k, v),
    GM_addValueChangeListener: () => {},
    GM_registerMenuCommand: () => {},
    GM_notification: () => {},
    GM_info: { script: { version: 'test' } },
    GM_xmlhttpRequest: () => ({ abort() {} }),
    unsafeWindow: dom.window,
  });
  dom.window.setInterval = () => 0;
  dom.window.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; }
  };
  dom.window.DragEvent = class extends dom.window.Event {
    constructor(type, init) { super(type, init); this.dataTransfer = init && init.dataTransfer; }
  };
  dom.window.ClipboardEvent = class extends dom.window.Event {
    constructor(type, init) { super(type, init); this.clipboardData = init && init.clipboardData; }
  };
  dom.window.eval(SOURCE);
  const connector = dom.window.__ZRA_TEST__.connector;

  const fileInput = dom.window.document.getElementById('f');
  // Chrome allows assigning input.files; jsdom's is read-only, so emulate it.
  Object.defineProperty(fileInput, 'files', { value: null, writable: true, configurable: true });
  fileInput.addEventListener('change', () => {
    const img = dom.window.document.createElement('img');
    img.setAttribute('src', 'blob:zotero-file');
    dom.window.document.body.appendChild(img);
  });

  const channel = await connector.deliverImages([
    { data: Buffer.from('fakepng').toString('base64'), mediaType: 'image/png' },
  ]);
  assert.equal(channel, 'file-input');
  assert.equal(fileInput.files.length, 1);
});

test('投递图片后通过附件 aria 标签确认，无需特定类名', async () => {
  const dom = new JSDOM(
    '<!doctype html><body><div id="composer"><textarea id="t"></textarea></div></body>',
    { url: 'https://gemini.google.com/app', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const values = new Map();
  dom.window.__ZRA_TEST__ = {};
  Object.assign(dom.window, {
    GM_getValue: (k, f) => values.get(k) ?? f,
    GM_setValue: (k, v) => values.set(k, v),
    GM_addValueChangeListener: () => {},
    GM_registerMenuCommand: () => {},
    GM_notification: () => {},
    GM_info: { script: { version: 'test' } },
    GM_xmlhttpRequest: () => ({ abort() {} }),
    unsafeWindow: dom.window,
  });
  dom.window.setInterval = () => 0;
  dom.window.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; }
  };
  dom.window.DragEvent = class extends dom.window.Event {
    constructor(type, init) { super(type, init); this.dataTransfer = init && init.dataTransfer; }
  };
  dom.window.ClipboardEvent = class extends dom.window.Event {
    constructor(type, init) { super(type, init); this.clipboardData = init && init.clipboardData; }
  };
  dom.window.eval(SOURCE);
  const connector = dom.window.__ZRA_TEST__.connector;
  assert.ok(connector, 'connector exported');

  // Accessible file evidence survives site class-name changes; a neutral
  // animation or unrelated new node is no longer treated as acceptance.
  const composer = dom.window.document.getElementById('composer');
  composer.addEventListener('paste', () => {
    const chip = dom.window.document.createElement('div');
    chip.setAttribute('aria-label', 'attachment screenshot.png');
    composer.appendChild(chip);
  });

  const channel = await connector.deliverImages([
    { data: Buffer.from('fakepng').toString('base64'), mediaType: 'image/png' },
  ]);
  assert.equal(channel, 'paste', 'accessible file card confirms the channel');
  dom.window.close();
});

test('图片确认忽略 body 和 composer 的 class 动画变动', async () => {
  const api = setup(
    'https://gemini.google.com/app',
    '<!doctype html><body><div id="composer"><textarea id="t"></textarea></div></body>',
  );
  const connector = api.connector;
  const body = api.window.document.body;
  const composer = api.window.document.getElementById('composer');
  const signal = connector.startMutationWatch();
  body.classList.add('page-animation');
  composer.classList.add('upload-animation');
  await new Promise((resolve) => api.window.setTimeout(resolve, 0));
  assert.equal(signal(), false, 'class-only animation is not an upload acknowledgement');
  signal.stop();
  api.window.close();
});

test('body-scoped 图片确认忽略无关段落和图片 src 变化，只接受附件语义节点', async () => {
  const api = setup(
    'https://gemini.google.com/app',
    '<!doctype html><body><input type="file" id="f">'
      + '<div id="unrelated"><img id="other" src="blob:old"></div></body>',
  );
  const connector = api.connector;
  const body = api.window.document.body;
  const unrelated = api.window.document.getElementById('unrelated');
  const other = api.window.document.getElementById('other');
  const signal = connector.startMutationWatch();
  unrelated.appendChild(api.window.document.createElement('p'));
  other.setAttribute('src', 'blob:changed');
  await new Promise((resolve) => api.window.setTimeout(resolve, 0));
  assert.equal(signal(), false, 'unrelated body mutations are not upload confirmation');
  const attachment = api.window.document.createElement('div');
  attachment.className = 'attachment-preview';
  body.appendChild(attachment);
  await new Promise((resolve) => api.window.setTimeout(resolve, 0));
  assert.equal(signal(), true, 'attachment-like body node confirms upload');
  signal.stop();
  api.window.close();
});

test('attachment snapshot stays inside the composer instead of accepting unrelated page previews', async (t) => {
  const api = setup('https://gemini.google.com/app',
    '<!doctype html><body><form id="composer"><textarea></textarea></form><aside></aside></body>');
  t.after(() => api.window.close());
  const connector = api.connector;
  const before = connector.attachmentSnapshot();
  const signal = connector.startMutationWatch();
  t.after(() => signal.stop());
  const unrelated = api.window.document.createElement('img');
  unrelated.src = 'blob:unrelated-history-preview';
  api.window.document.querySelector('aside').appendChild(unrelated);
  await new Promise(resolve => api.window.setTimeout(resolve, 0));
  assert.equal(signal(), false);
  assert.equal(connector.registeredSince(before), false,
    'the snapshot fallback must not bypass the scoped mutation observer');
  const attachment = api.window.document.createElement('img');
  attachment.src = 'blob:new-composer-attachment';
  api.window.document.querySelector('form').appendChild(attachment);
  assert.equal(connector.registeredSince(before), true);
});

test('attachment snapshot does not treat a different composer and its old previews as an upload', (t) => {
  const api = setup('https://gemini.google.com/app',
    '<!doctype html><body><form><textarea></textarea></form></body>');
  t.after(() => api.window.close());
  const before = api.connector.attachmentSnapshot();
  api.window.document.querySelector('form').remove();
  const form = api.window.document.createElement('form');
  form.appendChild(api.window.document.createElement('textarea'));
  const oldPreview = api.window.document.createElement('img');
  oldPreview.src = 'blob:old-other-conversation';
  form.appendChild(oldPreview);
  api.window.document.body.appendChild(form);
  assert.equal(api.connector.registeredSince(before), false);
});

test('ChatGPT enters generating state before the response section appears', async (t) => {
  const dom = new JSDOM(
    '<!doctype html><body><main id="main"></main>'
      + '<textarea id="prompt-textarea">请分析这张图片</textarea>'
      + '<button id="composer-submit-button" type="button">发送</button></body>',
    { url: 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  dom.window.__ZRA_TEST__ = {};
  Object.assign(dom.window, {
    GM_getValue: (_key, fallback) => fallback,
    GM_setValue: () => {},
    GM_addValueChangeListener: () => {},
    GM_registerMenuCommand: () => {},
    GM_notification: () => {},
    GM_info: { script: { version: 'test' } },
    GM_xmlhttpRequest: () => ({ abort() {} }),
    unsafeWindow: dom.window,
  });
  dom.window.setInterval = () => 0;
  dom.window.eval(SOURCE);
  const connector = dom.window.__ZRA_TEST__.connector;
  const input = dom.window.document.getElementById('prompt-textarea');
  const button = dom.window.document.getElementById('composer-submit-button');
  // jsdom reports zero-sized elements, while the real page exposes both nodes.
  input.getBoundingClientRect = () => ({ width: 300, height: 40 });
  button.getBoundingClientRect = () => ({ width: 80, height: 32 });
  button.addEventListener('click', () => {
    // ChatGPT can switch to its generating/stop state before the new turn is
    // mounted under #main. That state is the send acknowledgement we need.
    button.disabled = true;
    button.setAttribute('aria-label', 'Stop generating');
  });

  t.after(() => dom.window.close());
  const sent = await connector.handleSend('#composer-submit-button', '#main section');
  assert.equal(sent, true);
  assert.equal(connector.awaitingManualSend, false, 'accepted send must not enter manual fallback');
});

test('disabled send control alone does not count as sent and never retries into cancel', async (t) => {
  const api = setup(
    'https://chatgpt.com/',
    '<!doctype html><body><main id="main"></main>'
      + '<textarea id="prompt-textarea">问题</textarea>'
      + '<button id="composer-submit-button" type="button">发送</button></body>',
  );
  const connector = api.connector;
  const input = api.window.document.getElementById('prompt-textarea');
  const button = api.window.document.getElementById('composer-submit-button');
  input.getBoundingClientRect = () => ({ width: 300, height: 40 });
  button.getBoundingClientRect = () => ({ width: 80, height: 32 });
  let clicks = 0;
  button.addEventListener('click', () => {
    clicks += 1;
    button.disabled = true;
  });
  connector.waitForValue = async (check) => check() || null;
  connector.notifySidebar = async () => {};

  const sent = await connector.handleSend('#composer-submit-button', '#main section');
  assert.equal(sent, true, 'manual fallback keeps the task alive');
  assert.equal(clicks, 1, 'an uncertain click is not retried as a possible cancel');
  assert.equal(connector.awaitingManualSend, true);
  t.after(() => api.window.close());
});

test('empty message baseline needs a real conversation advance', () => {
  const api = setup(
    'https://chatgpt.com/',
    '<!doctype html><body><main id="main"></main></body>',
  );
  const connector = api.connector;
  const baseline = connector.captureBaseline('#main section');
  assert.equal(connector.conversationAdvanced(baseline), false);
  const section = api.window.document.createElement('section');
  api.window.document.getElementById('main').appendChild(section);
  assert.equal(connector.conversationAdvanced(baseline), true);
  api.window.close();
});

test('ChatGPT editor receives one paste transaction, not a DOM-only or duplicate prompt', async (t) => {
  const api = setup('https://chatgpt.com/', '<body><form><div contenteditable="true" id="prompt-textarea">old draft</div></form></body>');
  t.after(() => api.window.close());
  const input = api.window.document.querySelector('#prompt-textarea');
  input.getBoundingClientRect = () => ({ width: 300, height: 40 });
  let pastes = 0, commands = 0;
  api.window.DataTransfer = class {
    setData(type, value) { this.value = value; }
    getData() { return this.value; }
  };
  api.window.document.execCommand = () => { commands++; return false; };
  input.addEventListener('paste', event => {
    event.preventDefault(); pastes++;
    setTimeout(() => { input.textContent = event.clipboardData.getData('text/plain'); }, 180);
  });
  assert.equal(await api.connector.fillInput(api.connector.config.input.text, 'new question'), true);
  assert.equal(input.textContent, 'new question');
  assert.equal(pastes, 1);
  assert.equal(commands, 0, 'an accepted editor transaction must not race a second insertion');
  input.textContent = 'old unrelated draft that is much longer than question';
  assert.equal(api.connector.inputAccepts(api.connector.config.input.text, 'question'), false);
});

test('an active task cannot be replaced by the next queued task', async (t) => {
  const api = setup('https://chatgpt.com/');
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true; connector.isConnected = true; connector.hasLock = () => true;
  connector.currentTaskId = 'still-answering'; connector.isSendingUpdate = false;
  let polls = 0;
  api.window.GM_xmlhttpRequest = () => { polls++; return { abort() {} }; };
  void connector.startPolling();
  assert.equal(polls, 0);
});

test('ChatGPT pending fetch headers veto completion until the response stream closes', async (t) => {
  const api = setup('https://chatgpt.com/');
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.currentTaskId = 'pending-request'; connector.isRunning = true;
  let resolveFetch;
  api.window.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
  connector.proxy.setupFetch();
  const fetch = api.window.fetch('/backend-api/f/conversation');
  assert.equal(connector.proxy.activeRequests?.get('pending-request'), 1);
  resolveFetch({ ok: true, clone: () => ({ body: new ReadableStream({ start(controller) { controller.close(); } }) }) });
  await fetch;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(connector.proxy.activeRequests.get('pending-request') || 0, 0);
});

test('heartbeat is negotiated and never sends an empty answer to an older plugin', async (t) => {
  const api = setup('https://chatgpt.com/');
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true; connector.isConnected = true; connector.currentTaskId = 'heartbeat';
  const requests = [];
  api.window.GM_xmlhttpRequest = options => {
    requests.push(JSON.parse(options.data));
    options.onload({ status: 200, responseText: '{"ok":true,"complete":false}' });
    return { abort() {} };
  };
  await connector.sendHeartbeat();
  assert.deepEqual(requests, []);
  connector.supportsHeartbeat = true;
  await connector.sendHeartbeat();
  assert.equal(requests[0].heartbeat, true);
  assert.equal('text' in requests[0], false);
  assert.equal(connector.currentTaskId, 'heartbeat');
});

test('a hidden ChatGPT action bar is not completion evidence', (t) => {
  const api = setup('https://chatgpt.com/', '<body><main></main><form><textarea id="prompt-textarea"></textarea></form></body>');
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true; connector.currentTaskId = 'hidden-actions'; connector.isSendingUpdate = true;
  connector.captureChatGPTTurn();
  api.window.document.querySelector('main').innerHTML = '<div data-message-author-role="user">Q</div>'
    + '<article><div data-message-author-role="assistant">尚在回答</div>'
    + '<div hidden><button data-testid="copy-turn-action-button">Copy</button></div></article>';
  connector.sampleChatGPTAnswer(); connector.chatGPTStableSince = Date.now() - 5000;
  connector.sampleChatGPTAnswer();
  assert.equal(connector.doneSignal, false);
});

test('ChatGPT copy-code buttons are not answer completion controls', (t) => {
  const api = setup('https://chatgpt.com/', '<body><main></main><form><textarea id="prompt-textarea"></textarea></form></body>');
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true; connector.currentTaskId = 'code-copy'; connector.isSendingUpdate = true;
  connector.captureChatGPTTurn();
  api.window.document.querySelector('main').innerHTML = '<div data-message-author-role="user">Q</div>'
    + '<article><div data-message-author-role="assistant"><pre><button aria-label="Copy">Copy code</button><code>partial</code></pre></div></article>';
  connector.sampleChatGPTAnswer(); connector.chatGPTStableSince = Date.now() - 5000;
  connector.sampleChatGPTAnswer();
  assert.equal(connector.doneSignal, false);
});

test('keepalive has a finite deadline and reports partial text as an error, never success', async (t) => {
  const api = setup('https://chatgpt.com/');
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true; connector.isConnected = true; connector.supportsHeartbeat = true;
  connector.currentTaskId = 'timeout'; connector.taskStartedAt = Date.now() - 21 * 60 * 1000;
  connector.accumulatedText = '仍需保留的前半段';
  const requests = [];
  api.window.GM_xmlhttpRequest = options => {
    requests.push(JSON.parse(options.data)); options.onload({ status: 200, responseText: '{"ok":true}' });
    return { abort() {} };
  };
  await connector.sendHeartbeat();
  assert.match(requests[0].failed || '', /等待超时/);
  assert.equal(requests[0].text, '仍需保留的前半段');
  assert.equal(connector.currentTaskId, null);
});

test('an accepted upload that reports failure never falls through to paste or drop', async (t) => {
  const api = setup('https://chatgpt.com/', '<body><form><textarea id="prompt-textarea"></textarea></form></body>');
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true; connector.currentTaskId = 'failed-image';
  let uploads = 0, pastes = 0;
  // Mock only the jsdom-missing FileList setter; actual delivery/confirmation runs.
  connector.pickFileInput = () => ({ set files(value) {}, dispatchEvent(event) {
    if (event.type !== 'change') return;
    uploads++;
    const card = api.window.document.createElement('div'); card.setAttribute('data-testid', 'attachment-card');
    card.textContent = 'Upload failed'; api.window.document.querySelector('form').append(card);
  } });
  api.window.document.querySelector('textarea').addEventListener('paste', () => pastes++);
  await assert.rejects(connector.deliverImages([{ data: 'aGVsbG8=', mediaType: 'image/png' }]), /上传失败/);
  assert.equal(uploads, 1); assert.equal(pastes, 0);
});

test('image preview outside the inner form is recognized without another paste or drop', async (t) => {
  const api = setup('https://chatgpt.com/', '<body><main><article><img src="blob:history"></article></main>'
    + '<div id="composer-shell"><div id="preview-row"></div><form><input type="file" accept="image/*">'
    + '<div id="prompt-textarea" contenteditable="true"></div></form></div></body>');
  t.after(() => api.window.close());
  const connector = api.connector;
  const wait = connector.waitForValue.bind(connector);
  connector.waitForValue = (check, timeout) => wait(check, timeout === 15000 ? 100 : timeout);
  const input = api.window.document.querySelector('input[type=file]');
  Object.defineProperty(input, 'files', { writable: true, value: null });
  input.addEventListener('change', () => {
    const card = api.window.document.createElement('div');
    card.style.backgroundImage = 'url("blob:uploaded-screenshot")';
    card.innerHTML = '<button aria-label="Remove screenshot.png">×</button>';
    api.window.document.querySelector('#preview-row').append(card);
  });
  let repeats = 0;
  api.window.document.querySelector('#prompt-textarea').addEventListener('paste', () => repeats++);
  api.window.document.querySelector('#prompt-textarea').addEventListener('drop', () => repeats++);
  assert.equal(await connector.deliverImages([{ data: 'aGVsbG8=', mediaType: 'image/png' }]), 'file-input');
  assert.equal(repeats, 0);
});

test('drag fallback waits for the new drop surface and always clears its overlay', async (t) => {
  const api = setup('https://chatgpt.com/', '<body><form><div id="prompt-textarea" contenteditable="true"></div></form></body>');
  t.after(() => api.window.close());
  const connector = api.connector;
  const wait = connector.waitForValue.bind(connector);
  connector.waitForValue = (check, timeout) => wait(check, timeout === 15000 ? 100 : timeout);
  const editor = api.window.document.querySelector('#prompt-textarea');
  editor.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 40 });
  let overlay = null, drops = 0;
  editor.addEventListener('dragenter', () => {
    api.window.setTimeout(() => {
      overlay = api.window.document.createElement('div'); overlay.setAttribute('role', 'presentation');
      overlay.textContent = '添加任意内容'; api.window.document.body.append(overlay);
      overlay.addEventListener('drop', () => {
        drops++;
        const image = api.window.document.createElement('img'); image.src = 'blob:drop-success';
        api.window.document.querySelector('form').append(image);
      });
      overlay.addEventListener('dragleave', () => overlay.remove());
    }, 0);
  });
  api.window.document.elementFromPoint = () => overlay?.isConnected ? overlay : editor;
  assert.equal(await connector.deliverImages([{ data: 'aGVsbG8=', mediaType: 'image/png' }]), 'drop');
  assert.equal(drops, 1);
  assert.equal(overlay.isConnected, false);
});

test('Gemini DOM fallback returns the new model response, not the user query or an old answer', async (t) => {
  const api = setup('https://gemini.google.com/app', '<body><main><model-response><message-content>旧答案</message-content></model-response></main>'
    + '<form><rich-textarea><div class="textarea" contenteditable="true"></div></rich-textarea></form></body>');
  t.after(() => api.window.close());
  const intervals = [];
  api.window.setInterval = (...args) => { const id = setInterval(...args); intervals.push(id); return id; };
  api.window.clearInterval = clearInterval;
  t.after(() => intervals.forEach(clearInterval));
  const connector = api.connector;
  connector.isRunning = true; connector.currentTaskId = 'gemini-dom'; connector.isSendingUpdate = true;
  connector.startDomWatcher();
  api.window.document.querySelector('main').insertAdjacentHTML('beforeend', '<user-query-content><div class="user-query-container">解析图片</div></user-query-content>'
    + '<model-response><message-content><div class="markdown"><p>这是一张流程图。</p><p>最后的结论。</p></div></message-content>'
    + '<button aria-label="Copy response"><mat-icon data-mat-icon-name="copy"></mat-icon></button></model-response>');
  await new Promise(resolve => setTimeout(resolve, 1900));
  assert.match(connector.accumulatedText, /这是一张流程图[\s\S]*最后的结论/);
  assert.doesNotMatch(connector.accumulatedText, /旧答案|解析图片/);
  assert.equal(connector.doneSignal, true);
});

test('connected task heartbeats use the worker pacer when page intervals do not fire', async (t) => {
  let worker;
  const scheduled = [];
  const api = setup('https://gemini.google.com/app', '<body></body>', window => {
    window.URL.createObjectURL = () => 'blob:test-worker';
    window.Worker = class {
      constructor() { worker = this; }
      postMessage(message) { scheduled.push(message); }
    };
  });
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.isRunning = true; connector.hasLock = () => true; connector.startPolling = () => {};
  const updates = [];
  api.window.GM_xmlhttpRequest = options => {
    const payload = JSON.parse(options.data);
    if (payload.action === 'update') updates.push(payload);
    const response = payload.action === 'connect'
      ? { status: 'connected', capabilities: ['task-heartbeat'] } : { ok: true };
    queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(response) }));
    return { abort() {} };
  };
  await connector.handshake();
  connector.currentTaskId = 'hidden-tab';
  const heartbeatTick = scheduled.find(message => message.ms === 10000);
  assert.ok(heartbeatTick, 'heartbeat must not depend only on page setInterval');
  worker.onmessage({ data: heartbeatTick.id });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(updates.filter(update => update.heartbeat).length, 1);
  await connector.disconnect();
});

test('manual diagnostic report contains structure and transport state without conversation or credentials', (t) => {
  const api = setup('https://chatgpt.com/c/private-conversation', '<body><form><div id="prompt-textarea" contenteditable="true">PRIVATE_QUESTION</div>'
    + '<img src="https://example.invalid/signed-image?token=PRIVATE_FILE_TOKEN"></form></body>');
  t.after(() => api.window.close());
  const connector = api.connector;
  connector.sessionSecret = 'PRIVATE_SESSION_SECRET'; connector.accumulatedText = 'PRIVATE_ANSWER';
  const report = connector.diagnosticReport();
  assert.equal(report.site, 'chatgpt.com');
  assert.equal(report.scriptVersion, 'test');
  assert.equal(report.previewCount, 1);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|private-conversation|signed-image/);
});

test('paste preserves FileList when the native ClipboardEvent constructor ignores clipboardData', async (t) => {
  const api = setup('https://gemini.google.com/app', '<body><form><rich-textarea><div class="textarea" contenteditable="true"></div></rich-textarea></form></body>');
  t.after(() => api.window.close());
  api.window.ClipboardEvent = class extends api.window.Event {
    constructor(type, init) { super(type, init); Object.defineProperty(this, 'clipboardData', { configurable: true, get: () => null }); }
  };
  const connector = api.connector;
  const wait = connector.waitForValue.bind(connector);
  connector.waitForValue = (check, timeout) => wait(check, timeout === 15000 ? 100 : timeout);
  let count = 0;
  api.window.document.querySelector('.textarea').addEventListener('paste', event => {
    count = event.clipboardData?.files?.length || 0;
    if (!count) return;
    const image = api.window.document.createElement('img'); image.src = 'blob:paste';
    api.window.document.querySelector('form').append(image);
  });
  assert.equal(await connector.deliverImages([{ data: 'aGVsbG8=', mediaType: 'image/png' }]), 'paste');
  assert.equal(count, 1);
});

test('prompt verification also reads DOM text when CJK innerText collapses line breaks', (t) => {
  const api = setup('https://chatgpt.com/', '<body><div id="prompt-textarea" contenteditable="true"></div></body>');
  t.after(() => api.window.close());
  const editor = api.window.document.querySelector('#prompt-textarea');
  editor.textContent = '第一段。\n第二段。';
  Object.defineProperty(editor, 'innerText', { configurable: true, value: '第一段。第二段。' });
  assert.equal(api.connector.inputAccepts(api.connector.config.input.text, '第一段。\n第二段。'), true);
  editor.textContent = '不相关的旧问题';
  assert.equal(api.connector.inputAccepts(api.connector.config.input.text, '第一段。\n第二段。'), false);
});
