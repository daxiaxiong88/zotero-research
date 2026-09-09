const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', 'zotero-research-webai.user.js'),
  'utf8',
);

function setup(url = 'https://gemini.google.com/app') {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.__ZRA_TEST__ = {};
  dom.window.GM_getValue = () => '';
  dom.window.GM_setValue = () => {};
  dom.window.GM_addValueChangeListener = () => {};
  dom.window.GM_registerMenuCommand = () => {};
  dom.window.GM_notification = () => {};
  dom.window.GM_xmlhttpRequest = () => ({ abort: () => {} });
  dom.window.GM_info = { script: { version: 'test' } };
  dom.window.unsafeWindow = dom.window;
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
  dom.window.eval(SOURCE);
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

test('mergeStreamText handles delta and cumulative frames without duplication', () => {
  const api = setup();
  assert.equal(api.mergeStreamText('', 'abc'), 'abc');
  assert.equal(api.mergeStreamText('abc', 'abc'), 'abc');
  assert.equal(api.mergeStreamText('abc', 'abcdef'), 'abcdef');
  assert.equal(api.mergeStreamText('abcdef', 'abc'), 'abcdef');
  assert.equal(api.mergeStreamText('abc', 'def'), 'abcdef');
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

test('deliverImages 依次尝试通道，验证通过即返回', async () => {
  const dom = new JSDOM(
    '<!doctype html><body><textarea id="t"></textarea></body>',
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

test('file-input 通道优先：accept 含 image 的输入框直接赋 files', async () => {
  const dom = new JSDOM(
    '<!doctype html><body><input type="file" id="f" accept="image/*"><div id="wrap"></div></body>',
    { url: 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true },
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

test('投递图片后 composer 出现 DOM 变动即视为已确认，无需匹配类名', async () => {
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

  // Paste handler registers nothing the class-name probes can see; it just
  // inserts a neutral node — exactly the false-negative this fix removes.
  const composer = dom.window.document.getElementById('composer');
  composer.addEventListener('paste', () => {
    const chip = dom.window.document.createElement('div');
    chip.setAttribute('id', 'mystery-upload-chip');
    composer.appendChild(chip);
  });

  const channel = await connector.deliverImages([
    { data: Buffer.from('fakepng').toString('base64'), mediaType: 'image/png' },
  ]);
  assert.equal(channel, 'paste', 'DOM mutation alone confirms the channel');
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
