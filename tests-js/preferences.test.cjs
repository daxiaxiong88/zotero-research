const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function preferences({ fetchImpl = async () => assert.fail('unexpected API request') } = {}) {
  const fields = new Map();
  const events = [];
  const listeners = new Map();
  let fragmentRoot = null;
  const getElementById = (id) => {
    if (id === 'zra-preferences-root') return fragmentRoot;
    if (!fields.has(id)) {
      fields.set(id, {
        value: '',
        textContent: id === 'zra-backend-path' ? '初始占位' : '',
      });
    }
    return fields.get(id);
  };
  const document = {
    getElementById,
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    dispatchLoad: (target) => {
      for (const listener of listeners.get('load') || []) listener({ target });
    },
  };
  const context = vm.createContext({
    document,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: fetchImpl,
    Zotero: {
      Prefs: {
        values: new Map([
          ['researchAssistant.apiProtocol', 'auto'],
          ['researchAssistant.apiBaseUrl', ''],
          ['researchAssistant.apiModel', ''],
          ['researchAssistant.apiKey', ''],
        ]),
        get(name) { return this.values.get(name) || ''; },
        set(name, value) { this.values.set(name, value); },
      },
    },
    Services: { obs: { notifyObservers: (...args) => events.push(args) } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../addon/content/preferences.js'), 'utf8'), context);
  return {
    api: context.ZoteroResearchPreferences,
    context: context,
    fields,
    events,
    mountFragment() {
      fragmentRoot = { id: 'zra-preferences-root' };
      getElementById('zra-backend-path');
      getElementById('zra-reconnect');
      getElementById('zra-settings-status');
      getElementById('zra-api-status');
      document.dispatchLoad(fragmentRoot);
    },
  };
}

test('Zotero 10 preference fragments initialize after the framework-dispatched load event', () => {
  const h = preferences();
  h.mountFragment();
  assert.match(h.fields.get('zra-backend-path').textContent, /23119/);
  assert.match(h.fields.get('zra-backend-path').textContent, /允许其他应用/);
});

test('reconnect button refreshes the sidebar through the lifecycle observer', () => {
  const h = preferences();
  h.mountFragment();
  h.api.reconnect();
  assert.deepEqual(h.events, [[null, 'zotero-research:reconnect']]);
  assert.match(h.fields.get('zra-settings-status').textContent, /已刷新/);
});

test('no credential-bearing fields beyond the optional API key', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'addon', 'content', 'preferences.js'),
    'utf8',
  );
  // The direct-API key is a deliberate, user-entered local preference.
  assert.match(source, /apiProtocol|apiBaseUrl|apiModel|apiKey/);
  assert.doesNotMatch(source, /secret/i);
  assert.doesNotMatch(source, /sk-[A-Za-z0-9]{8,}/, 'no hardcoded API keys');
  const xhtml = fs.readFileSync(
    path.join(__dirname, '..', 'addon', 'content', 'preferences.xhtml'),
    'utf8',
  );
  assert.ok(xhtml.includes('API 直连'), 'API 直连配置区存在');
  // The old Ollama local-model fields are gone; the MinerU model directory
  // is a deliberate new local preference for deep parsing.
  assert.ok(!xhtml.includes('本地模型名称'), '旧本地模型字段已移除');
  assert.ok(xhtml.includes('MinerU'), 'MinerU 深度解析配置区存在');
});

test('save persists API fields into Zotero preferences', () => {
  const h = preferences();
  h.mountFragment();
  const api = h.api;
  api.field('zra-api-protocol').value = 'anthropic';
  api.field('zra-api-base').value = 'https://api.example.com/anthropic';
  api.field('zra-api-model').value = 'test-model';
  api.field('zra-api-key').value = 'sk-test';
  api.save();
  const values = h.context.Zotero.Prefs.values;
  assert.equal(values.get('researchAssistant.apiProtocol'), 'anthropic');
  assert.equal(values.get('researchAssistant.apiBaseUrl'), 'https://api.example.com/anthropic');
  assert.equal(values.get('researchAssistant.apiModel'), 'test-model');
  assert.equal(values.get('researchAssistant.apiKey'), 'sk-test');
  assert.match(api.field('zra-api-status').textContent, /已保存/);
});

test('API connection tests use the same protocol and normalized endpoint as direct requests', async () => {
  const calls = [];
  let cancelled = 0;
  const h = preferences({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        body: { cancel: async () => { cancelled += 1; } },
        text: async () => '',
      };
    },
  });
  h.mountFragment();
  h.api.field('zra-api-protocol').value = 'openai';
  h.api.field('zra-api-base').value = 'https://api.example.test/v1/';
  h.api.field('zra-api-model').value = 'test-model';
  h.api.field('zra-api-key').value = 'test-key';
  await h.api.testAPI();
  assert.equal(calls[0].url, 'https://api.example.test/v1/chat/completions');
  assert.equal(JSON.parse(calls[0].options.body).stream, true);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  assert.match(h.api.field('zra-api-status').textContent, /协议 openai/);

  h.api.field('zra-api-protocol').value = 'auto';
  h.api.field('zra-api-base').value = 'https://gateway.example.test/anthropic/v1';
  await h.api.testAPI();
  assert.equal(calls[1].url, 'https://gateway.example.test/anthropic/v1/messages');
  assert.equal(JSON.parse(calls[1].options.body).stream, true);
  assert.equal(calls[1].options.headers['anthropic-version'], '2023-06-01');
  assert.match(h.api.field('zra-api-status').textContent, /协议 anthropic/);
  assert.equal(cancelled, 2, 'successful probes cancel/drain their response body');
});
