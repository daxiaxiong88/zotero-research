const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BOOTSTRAP = fs.readFileSync(
  path.join(__dirname, '..', 'addon', 'bootstrap.js'),
  'utf8',
);

function streamResponse(chunks, options = {}) {
  const encoder = new TextEncoder();
  const values = chunks.map((chunk) => typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
  let index = 0;
  let cancelled = 0;
  let released = 0;
  let pendingRead = null;
  const response = {
    ok: options.ok !== false,
    status: options.status || 200,
    body: {
      getReader() {
        return {
          read() {
            if (index < values.length) {
              return Promise.resolve({ done: false, value: values[index++] });
            }
            if (options.hangAfterChunks) {
              return new Promise((resolve) => { pendingRead = resolve; });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
          cancel() {
            cancelled += 1;
            if (options.cancelHangs) return new Promise(() => {});
            if (pendingRead) {
              const resolve = pendingRead;
              pendingRead = null;
              resolve({ done: true, value: undefined });
            }
            return Promise.resolve();
          },
          releaseLock() { released += 1; },
        };
      },
    },
    text: async () => options.text || '',
  };
  response.stats = {
    get cancelled() { return cancelled; },
    get released() { return released; },
  };
  return response;
}

function pendingStreamResponse() {
  let cancelled = 0;
  let released = 0;
  let readCount = 0;
  let resolvePending;
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            readCount += 1;
            return new Promise((resolve) => { resolvePending = resolve; });
          },
          cancel() {
            cancelled += 1;
            if (resolvePending) {
              const resolve = resolvePending;
              resolvePending = null;
              resolve({ done: true, value: undefined });
            }
            return Promise.resolve();
          },
          releaseLock() { released += 1; },
        };
      },
    },
    text: async () => '',
  };
  response.stats = {
    get cancelled() { return cancelled; },
    get released() { return released; },
    get readCount() { return readCount; },
  };
  return response;
}

function runtime({ protocol = 'openai', baseUrl, model = 'test-model', apiKey = 'test-key', fetchImpl,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const values = new Map([
    ['researchAssistant.apiProtocol', protocol],
    ['researchAssistant.apiBaseUrl', baseUrl || 'https://api.example.test'],
    ['researchAssistant.apiModel', model],
    ['researchAssistant.apiKey', apiKey],
  ]);
  let section;
  let mountedAdapter;
  const Zotero = {
    File: { getContentsAsync: async () => '' },
    getMainWindows: () => [],
    Prefs: {
      get: (name) => values.get(name) || '',
      set: (name, value) => values.set(name, value),
    },
    Libraries: { userLibraryID: 1 },
    Server: { Endpoints: {}, LocalAPI: { getServerID: () => 'test-library' } },
    DataObjectUtilities: { generateKey: () => 'ANNTAG23' },
    ItemPaneManager: {
      registerSection: (options) => { section = options; return 'section-id'; },
      unregisterSection() {},
    },
    PreferencePanes: {
      register: async () => 'preference-id',
      unregister() {},
    },
    Reader: {
      registerEventListener() {},
      unregisterEventListener() {},
    },
  };
  const sandbox = {
    Zotero,
    console,
    TextEncoder,
    TextDecoder,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    fetch: fetchImpl,
    ZoteroResearchNative: {
      createHighlightController: () => ({ destroy() {} }),
    },
    ZoteroResearchRelay: {
      createRelayStore: () => ({
        enqueueTask() {}, subscribe() {}, state() { return {}; }, destroy() {},
      }),
    },
  };
  const context = vm.createContext(sandbox);
  sandbox.Services = {
    scriptloader: {
      loadSubScript(url) {
        if (url.endsWith('panel.js')) {
          sandbox.ZoteroResearchPanel = {
            mount(_body, adapter) {
              mountedAdapter = adapter;
              return { setContext() {}, destroy() {} };
            },
          };
        }
      },
    },
    obs: { addObserver() {}, removeObserver() {} },
    uuid: { generateUUID: () => ({ toString: () => 'test-token' }) },
  };
  vm.runInContext(BOOTSTRAP, context, { filename: 'addon/bootstrap.js' });

  return {
    context,
    values,
    async start() {
      await context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
      const doc = {
        defaultView: {},
        createElementNS: () => ({ setAttribute() {}, remove() {} }),
        documentElement: { appendChild() {} },
        getElementById: () => null,
        querySelector: () => null,
      };
      const body = {
        ownerDocument: doc,
        appendChild() {},
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      section.onRender({ body, doc, item: { id: 1 } });
      return mountedAdapter;
    },
    async stop() { await context.shutdown({}, 4); },
  };
}

function requestBody(call) {
  return JSON.parse(call.options.body);
}

test('OpenAI /v1 base URLs are not duplicated and UTF-8 SSE chunks are parsed', async () => {
  const calls = [];
  const payload = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '思' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '答案' } }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  const bytes = new TextEncoder().encode(payload);
  const splitAt = payload.indexOf('思') + 1;
  const response = streamResponse([bytes.slice(0, splitAt), bytes.slice(splitAt)]);
  const h = runtime({ baseUrl: 'https://api.example.test/v1/', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response;
  } });
  const adapter = await h.start();
  const deltas = [];
  const result = await adapter.callModelAPI({
    messages: [{ role: 'user', content: 'hello' }],
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(calls[0].url, 'https://api.example.test/v1/chat/completions');
  assert.equal(requestBody(calls[0]).stream, true);
  assert.equal(result.thinking, '思');
  assert.equal(result.text, '答案');
  assert.deepEqual(deltas.map((delta) => delta.text), ['思', '答案']);
  assert.ok(response.stats.cancelled >= 1, 'DONE closes an otherwise still-open response');
  assert.equal(response.stats.released, 1);
  await h.stop();
});

test('SSE keeps a CRLF split across chunks and joins multi-line data fields', async () => {
  const response = streamResponse([
    'data: {"choices":[\r',
    '\ndata: {"delta":{"content":"跨块"}}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ]);
  const h = runtime({ fetchImpl: async () => response });
  const adapter = await h.start();
  const result = await adapter.callModelAPI({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.text, '跨块');
  await h.stop();
});

test('auto protocol matches the Anthropic endpoint and avoids a repeated /v1 segment', async () => {
  const calls = [];
  const response = streamResponse([
    'data: {"type":"content_block_delta","delta":{"text":"ok"}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ], { hangAfterChunks: true });
  const h = runtime({
    protocol: 'auto',
    baseUrl: 'https://gateway.example.test/anthropic/v1/',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response;
    },
  });
  const adapter = await h.start();
  assert.equal(adapter.getAPIConfig().protocol, 'anthropic');
  const result = await adapter.callModelAPI({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(calls[0].url, 'https://gateway.example.test/anthropic/v1/messages');
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(requestBody(calls[0]).stream, true);
  assert.equal(result.text, 'ok');
  assert.ok(response.stats.cancelled >= 1, 'message_stop closes a still-open SSE response');
  await h.stop();
});

test('auto protocol recognizes Anthropic official and complete messages URLs', async () => {
  for (const [baseUrl, expected] of [
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
    ['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages'],
  ]) {
    const calls = [];
    const h = runtime({
      protocol: 'auto', baseUrl,
      fetchImpl: async (url) => {
        calls.push(url);
        return streamResponse(['data: {"type":"message_stop"}\n\n']);
      },
    });
    const adapter = await h.start();
    assert.equal(adapter.getAPIConfig().protocol, 'anthropic');
    await adapter.callModelAPI({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(calls[0], expected);
    await h.stop();
  }
});

test('non-stream OpenAI JSON responses remain compatible when a gateway ignores stream:true', async () => {
  const response = {
    ok: true,
    status: 200,
    body: null,
    text: async () => JSON.stringify({
      choices: [{ message: { reasoning_content: '思考', content: '普通响应' } }],
    }),
  };
  const h = runtime({ fetchImpl: async () => response });
  const adapter = await h.start();
  const result = await adapter.callModelAPI({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.thinking, '思考');
  assert.equal(result.text, '普通响应');
  await h.stop();
});

test('non-stream Anthropic content blocks are parsed through the same response reader', async () => {
  const response = streamResponse([JSON.stringify({
    content: [{ type: 'thinking', thinking: '先想' }, { type: 'text', text: '再答' }],
  })]);
  const h = runtime({
    protocol: 'anthropic',
    baseUrl: 'https://api.example.test/anthropic/v1',
    fetchImpl: async () => response,
  });
  const adapter = await h.start();
  const result = await adapter.callModelAPI({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.thinking, '先想');
  assert.equal(result.text, '再答');
  await h.stop();
});

test('provider stream errors reject the API call and close the reader', async () => {
  const response = streamResponse([
    'data: {"error":{"message":"quota denied"}}\n\n',
  ]);
  const h = runtime({ fetchImpl: async () => response });
  const adapter = await h.start();
  await assert.rejects(
    adapter.callModelAPI({ messages: [{ role: 'user', content: 'hello' }] }),
    /OpenAI API 错误：quota denied/,
  );
  assert.ok(response.stats.cancelled >= 1);
  assert.equal(response.stats.released, 1);
  await h.stop();
});

test('reader failures are not swallowed and release the stream lock', async () => {
  let cancelled = 0;
  let released = 0;
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => { throw new Error('socket broke'); },
        cancel: () => { cancelled += 1; return new Promise(() => {}); },
        releaseLock: () => { released += 1; },
      }),
    },
    text: async () => '',
  };
  const h = runtime({ fetchImpl: async () => response });
  const adapter = await h.start();
  const rejected = assert.rejects(
    adapter.callModelAPI({ messages: [{ role: 'user', content: 'hello' }] }),
    /socket broke/,
  );
  await Promise.race([
    rejected,
    new Promise((_, reject) => setTimeout(() => reject(new Error('cancel hung')), 100)),
  ]);
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
  await h.stop();
});

test('external cancellation aborts a pending stream and cancels its reader', async () => {
  const response = pendingStreamResponse();
  const h = runtime({ fetchImpl: async () => response });
  const adapter = await h.start();
  const controller = new AbortController();
  const request = adapter.callModelAPI({
    messages: [{ role: 'user', content: 'hello' }],
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request);
  assert.equal(response.stats.readCount, 1);
  assert.ok(response.stats.cancelled >= 1);
  assert.equal(response.stats.released, 1);
  await h.stop();
});

test('the internal timeout aborts a stalled stream and reports a timeout', async () => {
  const response = pendingStreamResponse();
  const timers = [];
  const h = runtime({
    fetchImpl: async () => response,
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => { if (timer) timer.active = false; },
  });
  const adapter = await h.start();
  const request = adapter.callModelAPI({ messages: [{ role: 'user', content: 'hello' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timers.map((timer) => timer.delay), [120000, 900000]);
  timers[0].callback();
  await assert.rejects(request, /API 请求超时.*120/);
  assert.ok(response.stats.cancelled >= 1);
  assert.equal(response.stats.released, 1);
  await h.stop();
});

test('stream activity resets the idle timer while the total timer remains armed', async () => {
  const response = streamResponse([
    'data: {"choices":[{"delta":{"content":"chunk"}}]}\n\n',
  ], { hangAfterChunks: true });
  const timers = [];
  const h = runtime({
    fetchImpl: async () => response,
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => { if (timer) timer.active = false; },
  });
  const adapter = await h.start();
  const request = adapter.callModelAPI({ messages: [{ role: 'user', content: 'hello' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timers.map((timer) => timer.delay), [120000, 900000, 120000]);
  assert.equal(timers[0].active, false);
  assert.equal(timers[1].active, true);
  timers[2].callback();
  await assert.rejects(request, /API 请求超时.*120/);
  await h.stop();
});

test('SSE EOF without a terminal marker rejects but preserves already emitted partial text', async () => {
  const response = streamResponse([
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
  ]);
  const h = runtime({ fetchImpl: async () => response });
  const adapter = await h.start();
  const deltas = [];
  await assert.rejects(
    adapter.callModelAPI({
      messages: [{ role: 'user', content: 'hello' }],
      onDelta: (delta) => deltas.push(delta),
    }),
    /结束标记前中断/,
  );
  assert.deepEqual(deltas.map((delta) => delta.text), ['partial']);
  await h.stop();
});
