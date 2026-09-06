const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PANEL_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'addon', 'content', 'panel.js'),
  'utf8',
);
const RELAY_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'addon', 'content', 'relay.js'),
  'utf8',
);

function makeRelayHarness() {
  const listeners = [];
  let queueResult = null;
  const relay = {
    calls: [],
    enqueueTask(request) {
      this.calls.push({ method: 'enqueueTask', request });
      if (queueResult instanceof Error) throw queueResult;
      return queueResult || 'task-1';
    },
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    state() {
      return this.connected
        ? { connected: true, ai: 'Gemini', url: 'https://gemini.google.com/' }
        : { connected: false };
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
  return { relay, listeners, setQueueResult: (value) => { queueResult = value; } };
}

function makeAdapter(relayHarness, overrides = {}) {
  return {
    navigate(key, page) {
      this.navigateCalls = this.navigateCalls || [];
      this.navigateCalls.push([key, page]);
      return Promise.resolve();
    },
    relay: relayHarness.relay,
    retrieveEvidence(attachmentKey, query, topK) {
      this.evidenceCalls = this.evidenceCalls || [];
      this.evidenceCalls.push([attachmentKey, query, topK]);
      return Promise.resolve([
        { evidence_id: 'p3:c1', page: 3, chunk_index: 1, text: 'Measured improvement.', score: 1 },
      ]);
    },
    openSettings() {},
    copyText() {},
    openExternal(url) {
      this.openedUrls = this.openedUrls || [];
      this.openedUrls.push(url);
    },
    ...overrides,
  };
}

function setup(adapter) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.eval(RELAY_SOURCE);
  dom.window.eval(PANEL_SOURCE);
  const panel = dom.window.ZoteroResearchPanel.mount(dom.window.document.body, adapter);
  const root = dom.window.document.querySelector('[data-zrp-root]');
  assert.ok(root, 'mount should create a panel root');
  return { dom, panel, root, adapter };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const CONTEXT = {
  item_key: 'ITEM-1',
  title: 'A paper title',
  attachment_key: 'ATT-1',
  library_id: 7,
};

test('未连接网页时状态提示安装油猴脚本；连接后显示提供方', async () => {
  const harness = makeRelayHarness();
  const { root, panel } = setup(makeAdapter(harness));
  panel.setContext(CONTEXT);
  await settle();
  assert.match(root.querySelector('[data-testid="health-status"]').textContent, /等待网页连接/);
  assert.match(root.querySelector('[data-testid="webai-chat-status"]').textContent, /未连接网页/);
  harness.relay.connected = true;
  harness.relay.emit({ type: 'session', connected: true, ai: 'Gemini' });
  assert.match(root.querySelector('[data-testid="health-status"]').textContent, /Gemini 已连接/);
  panel.destroy();
});

test('发送消息组装证据提示并入队；流式进度与完成都会渲染', async () => {
  const harness = makeRelayHarness();
  const { root, panel } = setup(makeAdapter(harness));
  panel.setContext(CONTEXT);
  await settle();
  root.querySelector('[data-testid="webai-chat-input"]').value = '实验结果是什么？';
  root.querySelector('[data-testid="webai-chat-send"]').click();
  await settle();

  const call = harness.relay.calls.at(-1);
  assert.equal(call.request.meta.provider, 'gemini');
  assert.match(call.request.messages[0].text, /A paper title/);
  assert.match(call.request.messages[0].text, /（第3页）Measured improvement\./);
  assert.match(call.request.messages[0].text, /本轮问题：实验结果是什么？/);
  assert.equal(root.querySelector('[data-testid="webai-chat-message-1"]').textContent.includes('正在生成'), true);

  harness.relay.emit({ type: 'progress', id: 'task-1', text: '部分回答' });
  assert.equal(
    root.querySelectorAll('[data-testid="webai-chat-message-1"] .zrp-message-content')[0].textContent,
    '部分回答',
  );
  harness.relay.emit({ type: 'answer', id: 'task-1', text: '完整回答', done: true });
  const final = root.querySelectorAll('[data-testid="webai-chat-message-1"] .zrp-message-content')[0];
  assert.equal(final.textContent, '完整回答');
  assert.match(root.querySelector('[data-testid="webai-chat-status"]').textContent, /已发送到网页 AI|等待回复|已连接/);
  panel.destroy();
});

test('入队失败时回滚占位消息并显示错误', async () => {
  const harness = makeRelayHarness();
  harness.setQueueResult(new Error('待处理任务过多'));
  const { root, panel } = setup(makeAdapter(harness));
  panel.setContext(CONTEXT);
  await settle();
  root.querySelector('[data-testid="webai-chat-input"]').value = '问题';
  root.querySelector('[data-testid="webai-chat-send"]').click();
  await settle();
  assert.match(root.querySelector('[data-testid="error"]').textContent, /待处理任务过多/);
  assert.equal(root.querySelectorAll('.zrp-message').length, 0);
  panel.destroy();
});

test('快捷命令直接发送；部分总结没有选文时提示先选文', async () => {
  const harness = makeRelayHarness();
  const { root, panel } = setup(makeAdapter(harness));
  panel.setContext(CONTEXT);
  await settle();

  root.querySelector('[data-testid="quick-partial-summary"]').click();
  assert.match(root.querySelector('[data-testid="error"]').textContent, /先在 PDF 中选中/);

  root.querySelector('[data-testid="quick-summary-page"]').click();
  await settle();
  assert.equal(harness.relay.calls.length, 1);
  assert.match(harness.relay.calls[0].request.messages[0].text, /请总结当前 PDF 页面/);
  panel.destroy();
});

test('回答中的证据卡片按纯文本渲染并提供页码跳转', async () => {
  const harness = makeRelayHarness();
  const { root, panel, adapter } = setup(makeAdapter(harness));
  panel.setContext(CONTEXT);
  await settle();
  root.querySelector('[data-testid="webai-chat-input"]').value = '问题';
  root.querySelector('[data-testid="webai-chat-send"]').click();
  await settle();
  harness.relay.emit({ type: 'answer', id: 'task-1', text: '<img src=x onerror=window.__xss=1>', done: true });
  await settle();
  const content = root.querySelectorAll('.zrp-message-content')[1];
  assert.equal(content.textContent, '<img src=x onerror=window.__xss=1>');
  assert.equal(content.querySelector('img'), null);

  const evidenceButton = root.querySelector('[data-zrp-action="navigate-evidence"]');
  assert.ok(evidenceButton, 'evidence page button should exist');
  evidenceButton.click();
  assert.deepEqual(adapter.navigateCalls.at(-1), ['ATT-1', 3]);
  panel.destroy();
});

test('清空重置消息；更换文献清空会话；打开网页按钮跳转提供方', async () => {
  const harness = makeRelayHarness();
  const { root, panel, adapter } = setup(makeAdapter(harness));
  panel.setContext(CONTEXT);
  await settle();
  root.querySelector('[data-testid="quick-summary-page"]').click();
  await settle();
  assert.ok(root.querySelectorAll('.zrp-message').length >= 1);

  root.querySelector('[data-testid="webai-clear"]').click();
  assert.ok(root.querySelector('[data-testid="webai-chat-empty"]'), 'empty state returns after clear');

  root.querySelector('[data-testid="webai-open"]').click();
  assert.deepEqual(adapter.openedUrls, ['https://gemini.google.com/app#zra-connect=1']);

  panel.setContext({ ...CONTEXT, item_key: 'ITEM-2' });
  assert.equal(root.querySelectorAll('.zrp-message').length, 0);
  panel.destroy();
});

test('destroy 后不再响应事件', async () => {
  const harness = makeRelayHarness();
  const { dom, panel } = setup(makeAdapter(harness));
  panel.destroy();
  panel.destroy();
  assert.equal(dom.window.document.body.querySelector('[data-zrp-root]'), null);
  assert.doesNotThrow(() => panel.setContext(CONTEXT));
  assert.doesNotThrow(() => harness.relay.emit({ type: 'answer', id: 'x', text: 'y', done: true }));
});

test('取证期间立即禁止重复发送', async () => {
  let resolveEvidence;
  const harness = makeRelayHarness();
  const { root, panel } = setup(makeAdapter(harness, {
    retrieveEvidence: () => new Promise(resolve => { resolveEvidence = resolve; }),
  }));
  panel.setContext(CONTEXT);
  root.querySelector('[data-testid="quick-summary-page"]').click();
  assert.equal(root.querySelector('[data-testid="webai-chat-send"]').disabled, true);
  root.querySelector('[data-testid="quick-summary-page"]').click();
  await settle();
  resolveEvidence([]);
  await settle();
  assert.equal(harness.relay.calls.length, 1);
  panel.destroy();
});

for (const action of ['switch', 'clear', 'destroy']) {
  test(`取证未完成时 ${action} 不发送旧文献任务`, async () => {
    let resolveEvidence;
    const harness = makeRelayHarness();
    const { root, panel } = setup(makeAdapter(harness, {
      retrieveEvidence: () => new Promise(resolve => { resolveEvidence = resolve; }),
    }));
    panel.setContext(CONTEXT);
    root.querySelector('[data-testid="quick-summary-page"]').click();
    await settle();
    if (action === 'switch') panel.setContext({ ...CONTEXT, attachment_key: 'ATT-2', title: 'Another paper' });
    else if (action === 'clear') root.querySelector('[data-testid="webai-clear"]').click();
    else panel.destroy();
    resolveEvidence([]);
    await settle();
    assert.equal(harness.relay.calls.length, 0);
    panel.destroy();
  });
}

const MARKDOWN_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'addon', 'content', 'markdown.js'),
  'utf8',
);

function setupWithMarkdown(adapter) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.eval(RELAY_SOURCE);
  dom.window.eval(MARKDOWN_SOURCE);
  dom.window.eval(PANEL_SOURCE);
  const panel = dom.window.ZoteroResearchPanel.mount(dom.window.document.body, adapter);
  const root = dom.window.document.querySelector('[data-zrp-root]');
  return { dom, panel, root, adapter };
}

test('回答完成时分离思考过程并渲染 Markdown', async () => {
  const harness = makeRelayHarness();
  const { root, panel } = setupWithMarkdown(makeAdapter(harness));
  panel.setContext(CONTEXT);
  await settle();
  root.querySelector('[data-testid="webai-chat-input"]').value = '问题';
  root.querySelector('[data-testid="webai-chat-send"]').click();
  await settle();
  harness.relay.emit({
    type: 'answer',
    id: 'task-1',
    text: '<think>先分析证据。</think>\n## 结论\n\n- **关键点**：样本 40 个（第3页）。',
    done: true,
  });
  await settle();
  const message = root.querySelector('[data-testid="webai-chat-message-1"]');
  const think = message.querySelector('.zrp-think');
  assert.ok(think, 'think block rendered as details');
  assert.equal(think.querySelector('summary').textContent, '思考过程');
  assert.equal(think.querySelector('.zrp-think-body').textContent, '先分析证据。');
  const md = message.querySelector('.zrp-message-content.zrp-md');
  assert.ok(md, 'answer rendered as markdown');
  assert.equal(md.querySelector('h3').textContent, '结论');
  assert.equal(md.querySelector('strong').textContent, '关键点');
  assert.equal(md.querySelector('li').textContent.includes('样本 40 个'), true);
  panel.destroy();
});

test('API 直连模式走 callModelAPI 并流式渲染', async () => {
  const harness = makeRelayHarness();
  const deltas = [];
  const adapter = makeAdapter(harness, {
    getAPIConfig: () => ({
      protocol: 'anthropic', baseUrl: 'https://api.example.com/anthropic',
      model: 'test-model', apiKey: 'sk-test',
    }),
    callModelAPI({ messages, onDelta }) {
      this.apiCalls = this.apiCalls || [];
      this.apiCalls.push(messages);
      return new Promise((resolve) => {
        setTimeout(() => {
          onDelta({ type: 'thinking', text: '推理' });
          onDelta({ type: 'text', text: '**回答**正文' });
          resolve({ thinking: '推理', text: '**回答**正文' });
        }, 20);
      });
    },
  });
  const { dom, root, panel } = setupWithMarkdown(adapter);
  root.querySelector('[data-testid="webai-provider"]').value = 'api';
  root.querySelector('[data-testid="webai-provider"]').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  panel.setContext(CONTEXT);
  await settle();
  assert.match(root.querySelector('[data-testid="health-status"]').textContent, /API：test-model/);
  assert.equal(root.querySelector('[data-testid="webai-open"]').disabled, true);

  root.querySelector('[data-testid="webai-chat-input"]').value = '实验结果？';
  root.querySelector('[data-testid="webai-chat-send"]').click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const calls = adapter.apiCalls;
  assert.equal(calls.length, 1);
  assert.match(calls[0][calls[0].length - 1].content, /本轮问题：实验结果/);
  const message = root.querySelector('[data-testid="webai-chat-message-1"]');
  assert.ok(message.querySelector('.zrp-think'), 'thinking separated');
  assert.equal(message.querySelector('.zrp-message-content.zrp-md strong').textContent, '回答');
  panel.destroy();
});

test('API 未配置时给出明确错误', async () => {
  const harness = makeRelayHarness();
  const adapter = makeAdapter(harness, {
    getAPIConfig: () => ({ protocol: 'auto', baseUrl: '', model: '', apiKey: '' }),
    callModelAPI() { throw new Error('不应调用'); },
  });
  const { dom, root, panel } = setupWithMarkdown(adapter);
  root.querySelector('[data-testid="webai-provider"]').value = 'api';
  root.querySelector('[data-testid="webai-provider"]').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  panel.setContext(CONTEXT);
  await settle();
  assert.match(root.querySelector('[data-testid="health-status"]').textContent, /API 未配置/);
  root.querySelector('[data-testid="webai-chat-input"]').value = '问题';
  root.querySelector('[data-testid="webai-chat-send"]').click();
  await settle();
  assert.match(root.querySelector('[data-testid="error"]').textContent, /API 未配置/);
  panel.destroy();
});

test('A−/A+ 调节字号并持久化到适配器', async () => {
  const harness = makeRelayHarness();
  const sizes = [];
  const adapter = makeAdapter(harness, {
    getFontSize: () => 'm',
    setFontSize: (size) => sizes.push(size),
  });
  const { root, panel } = setup(adapter);
  assert.equal(root.getAttribute('data-size'), 'm');
  root.querySelector('[data-testid="font-increase"]').click();
  assert.equal(root.getAttribute('data-size'), 'l');
  root.querySelector('[data-testid="font-increase"]').click();
  root.querySelector('[data-testid="font-increase"]').click();
  assert.equal(root.getAttribute('data-size'), 'xl');
  assert.equal(root.querySelector('[data-testid="font-increase"]').disabled, true);
  root.querySelector('[data-testid="font-decrease"]').click();
  assert.equal(root.getAttribute('data-size'), 'l');
  // mount('m') + l + xl (the third click is disabled at xl) + back to l
  assert.deepEqual(sizes, ['m', 'l', 'xl', 'l']);
  panel.destroy();
});

test('API 模式显示附件行并随 PDF 发送 document block', async () => {
  const harness = makeRelayHarness();
  const adapter = makeAdapter(harness, {
    getAPIConfig: () => ({
      protocol: 'anthropic', baseUrl: 'https://api.example.com/anthropic',
      model: 'test-model', apiKey: 'sk-test',
    }),
    getAttachmentBase64: () => Promise.resolve('UEJERg=='),
    getAttachmentMediaType: () => 'application/pdf',
    callModelAPI(request) {
      this.apiRequests = this.apiRequests || [];
      this.apiRequests.push(request);
      return Promise.resolve({ thinking: '', text: '读完了' });
    },
  });
  const { dom, root, panel } = setupWithMarkdown(adapter);
  root.querySelector('[data-testid="webai-provider"]').value = 'api';
  root.querySelector('[data-testid="webai-provider"]').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  panel.setContext(CONTEXT);
  await settle();
  const attachRow = root.querySelector('.zrp-attach-row');
  assert.equal(attachRow.hidden, false, 'attach row visible in API mode');
  root.querySelector('[data-testid="attach-pdf"]').checked = true;
  root.querySelector('[data-testid="webai-chat-input"]').value = '总结这篇论文';
  root.querySelector('[data-testid="webai-chat-send"]').click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const request = adapter.apiRequests[0];
  assert.equal(request.attachmentKey, 'ATT-1');
  assert.equal(request.attachment.base64, 'UEJERg==');
  assert.equal(request.attachment.mediaType, 'application/pdf');
  assert.match(request.messages[request.messages.length - 1].content, /附带论文全文 PDF/);
  panel.destroy();
});

test('API 附件在 OpenAI 协议下明确报错', async () => {
  const harness = makeRelayHarness();
  const adapter = makeAdapter(harness, {
    getAPIConfig: () => ({
      protocol: 'openai', baseUrl: 'https://api.example.com/v1',
      model: 'test-model', apiKey: 'sk-test',
    }),
    getAttachmentBase64: () => Promise.resolve('UEJERg=='),
    getAttachmentMediaType: () => 'application/pdf',
    callModelAPI() { throw new Error('不应调用'); },
  });
  const { dom, root, panel } = setupWithMarkdown(adapter);
  root.querySelector('[data-testid="webai-provider"]').value = 'api';
  root.querySelector('[data-testid="webai-provider"]').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  panel.setContext(CONTEXT);
  await settle();
  root.querySelector('[data-testid="attach-pdf"]').checked = true;
  root.querySelector('[data-testid="webai-chat-input"]').value = '问题';
  root.querySelector('[data-testid="webai-chat-send"]').click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(root.querySelector('[data-testid="error"], .zrp-error-inline').textContent, /Anthropic/);
  panel.destroy();
});

test('快捷命令已精简且“上传材料”仅网页模式显示', async () => {
  const harness = makeRelayHarness();
  const adapter = makeAdapter(harness, {
    getAPIConfig: () => ({
      protocol: 'anthropic', baseUrl: 'https://api.example.com/anthropic',
      model: 'm', apiKey: 'k',
    }),
    callModelAPI: () => Promise.resolve({ thinking: '', text: 'ok' }),
  });
  const { dom, root, panel } = setupWithMarkdown(adapter);
  panel.setContext(CONTEXT);
  await settle();
  // Web mode: six commands, upload visible.
  const keys = [...root.querySelectorAll('[data-testid^="quick-"]')].map((b) => b.getAttribute('data-command'));
  assert.deepEqual(keys, ['summary-page', 'translate-page', 'partial-summary', 'full-summary', 'fill-note', 'upload-material']);
  assert.equal(root.querySelector('[data-testid="quick-upload-material"]').hidden, false);

  root.querySelector('[data-testid="webai-provider"]').value = 'api';
  root.querySelector('[data-testid="webai-provider"]').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(root.querySelector('[data-testid="quick-upload-material"]').hidden, true);
  // No duplicated bottom summary button remains.
  assert.equal(root.querySelector('[data-testid="shortcut-summary"]'), null);
  panel.destroy();
});

test('“总结本页”优先使用阅读器当前页证据，取不到时回退全文检索', async () => {
  const harness = makeRelayHarness();
  const adapter = makeAdapter(harness, {
    retrieveCurrentPageEvidence(key) {
      this.scopedCalls = this.scopedCalls || [];
      this.scopedCalls.push(key);
      return Promise.resolve(this.scopedResult);
    },
  });
  const { root, panel } = setup(adapter);
  panel.setContext(CONTEXT);
  await settle();

  // Current page resolved: evidence comes from that page, not BM25.
  adapter.scopedResult = {
    page: 5,
    spans: [{ evidence_id: 'p5:c1', page: 5, chunk_index: 1, text: '本页核心内容', score: 1 }],
  };
  root.querySelector('[data-testid="quick-summary-page"]').click();
  await settle();
  assert.deepEqual(adapter.scopedCalls, ['ATT-1']);
  assert.equal(adapter.evidenceCalls, undefined, 'scoped hit must not fall back to full-text retrieval');
  assert.match(harness.relay.calls[0].request.messages[0].text, /（第5页）本页核心内容/);

  harness.relay.emit({ type: 'answer', id: 'task-1', text: '好', done: true });
  await settle();

  // No reader page available: falls back to the usual retrieval.
  adapter.scopedResult = null;
  root.querySelector('[data-testid="quick-translate-page"]').click();
  await settle();
  assert.equal(adapter.evidenceCalls.length, 1, 'missing page falls back to full-text retrieval');
  panel.destroy();
});

test('“总结本页”定位出错时同样回退全文检索而不是报错', async () => {
  const harness = makeRelayHarness();
  const adapter = makeAdapter(harness, {
    retrieveCurrentPageEvidence: () => Promise.reject(new Error('reader exploded')),
  });
  const { root, panel } = setup(adapter);
  panel.setContext(CONTEXT);
  await settle();
  root.querySelector('[data-testid="quick-summary-page"]').click();
  await settle();
  assert.equal(adapter.evidenceCalls.length, 1);
  assert.equal(root.querySelector('[data-testid="error"]').hidden, true);
  assert.equal(harness.relay.calls.length, 1);
  panel.destroy();
});

test('发送失败时把问题放回输入框', async () => {
  const harness = makeRelayHarness();
  harness.setQueueResult(new Error('待处理任务过多'));
  const { root, panel } = setup(makeAdapter(harness));
  panel.setContext(CONTEXT);
  await settle();
  root.querySelector('[data-testid="webai-chat-input"]').value = '不想重打的问题';
  root.querySelector('[data-testid="webai-chat-send"]').click();
  await settle();
  assert.match(root.querySelector('[data-testid="error"]').textContent, /待处理任务过多/);
  assert.equal(root.querySelector('[data-testid="webai-chat-input"]').value, '不想重打的问题');
  panel.destroy();
});

test('提供方选择持久化并在下次挂载时恢复', async () => {
  const harness = makeRelayHarness();
  const saved = [];
  const adapter = makeAdapter(harness, {
    getProvider: () => 'kimi',
    setProvider: (provider) => saved.push(provider),
  });
  const { dom, root, panel } = setup(adapter);
  assert.equal(root.querySelector('[data-testid="webai-provider"]').value, 'kimi');
  root.querySelector('[data-testid="webai-provider"]').value = 'claude';
  root.querySelector('[data-testid="webai-provider"]').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(saved, ['claude']);
  panel.setContext(CONTEXT);
  await settle();
  root.querySelector('[data-testid="webai-chat-input"]').value = '问题';
  root.querySelector('[data-testid="webai-chat-send"]').click();
  await settle();
  assert.equal(harness.relay.calls.at(-1).request.meta.provider, 'claude');
  panel.destroy();
});

test('网页模式清空后提示网页上下文仍在', async () => {
  const harness = makeRelayHarness();
  const { root, panel } = setup(makeAdapter(harness));
  panel.setContext(CONTEXT);
  await settle();
  root.querySelector('[data-testid="quick-summary-page"]').click();
  await settle();
  root.querySelector('[data-testid="webai-clear"]').click();
  assert.match(root.querySelector('[data-testid="webai-chat-status"]').textContent, /旧对话仍在/);
  panel.destroy();
});
