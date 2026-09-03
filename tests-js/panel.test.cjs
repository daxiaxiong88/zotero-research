const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PANEL_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'addon', 'content', 'panel.js'),
  'utf8',
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeAdapter(overrides = {}) {
  const calls = [];
  const adapter = {
    calls,
    rpc(method, params) {
      calls.push({ method, params });
      if (method === 'health') {
        return Promise.resolve({
          status: 'ok',
          zotero: { reachable: true, version: '10.0', write_supported: true },
          models: { local: 'Local model', external: null },
        });
      }
      return Promise.resolve({});
    },
    navigate(...args) {
      calls.push({ method: 'navigate', args });
    },
    prepareHighlight(payload) {
      calls.push({ method: 'prepareHighlight', params: payload });
      return Promise.resolve({
        token: 'highlight-token',
        digest: 'highlight-digest',
        text: payload.quote,
        page: payload.page,
        color: '#f3c969',
        expires_at: '2099-01-01T00:00:00Z',
      });
    },
    commitHighlight(preview) {
      calls.push({ method: 'commitHighlight', params: preview });
      return Promise.resolve({ status: 'created' });
    },
    openSettings() {
      calls.push({ method: 'openSettings' });
    },
    ...overrides,
  };
  return adapter;
}

function setup(adapter = makeAdapter()) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.eval(PANEL_SOURCE);
  const panel = dom.window.ZoteroResearchPanel.mount(dom.window.document.body, adapter);
  const root = dom.window.document.querySelector('[data-zrp-root]');
  assert.ok(root, 'mount should create a panel root');
  return { dom, panel, root, adapter };
}

function setupXml(adapterA = makeAdapter(), adapterB = makeAdapter()) {
  const dom = new JSDOM(
    '<window xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"><box id="left"/><box id="right"/></window>',
    {
      contentType: 'application/xml',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  );
  dom.window.eval(PANEL_SOURCE);
  const left = dom.window.document.getElementById('left');
  const right = dom.window.document.getElementById('right');
  const panelA = dom.window.ZoteroResearchPanel.mount(left, adapterA);
  const panelB = dom.window.ZoteroResearchPanel.mount(right, adapterB);
  const rootA = left.querySelector('[data-zrp-root]');
  const rootB = right.querySelector('[data-zrp-root]');
  assert.ok(rootA, 'XML mount should create the first panel root');
  assert.ok(rootB, 'XML mount should create the second panel root');
  return { dom, left, right, panelA, panelB, rootA, rootB, adapterA, adapterB };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function context(overrides = {}) {
  return {
    item_key: 'ITEM-1',
    title: 'A paper title',
    attachment_key: 'ATT-1',
    library_id: 7,
    ...overrides,
  };
}

function selection(overrides = {}) {
  return {
    attachment_key: 'ATT-1',
    text: 'Selected sentence from the paper.',
    page: 4,
    page_label: '4',
    sort_index: 2,
    ...overrides,
  };
}

function analysis(overrides = {}) {
  return {
    item_key: 'ITEM-1',
    attachment_key: 'ATT-1',
    title: 'A paper title',
    task: 'Reading analysis',
    mode: 'evidence_only',
    generated_by: 'local-evidence',
    sensitivity: 'sensitive',
    processing_location: 'local',
    sections: [
      { title: 'Key finding', content: 'Model conclusion', evidence_ids: ['ev-1'] },
    ],
    evidence: [
      {
        evidence_id: 'ev-1',
        page: 4,
        chunk_index: 1,
        text: 'Exact source excerpt.',
        score: 0.9,
        source: 'pdf',
      },
    ],
    warnings: [],
    ...overrides,
  };
}

test('无文献时禁用分析，并显示隐私/健康状态', async () => {
  const { root, adapter, panel } = setup();
  await settle();

  assert.equal(root.querySelector('[data-testid="analysis-submit"]').disabled, true);
  assert.match(root.querySelector('[data-testid="paper-status"]').textContent, /未选择文献/);
  assert.match(root.querySelector('[data-testid="health-status"]').textContent, /已连接/);
  assert.ok(root.querySelector('[data-testid="sensitivity-sensitive"]').checked);
  assert.equal(adapter.calls.filter((call) => call.method === 'health').length, 1);
  panel.destroy();
});

test('设置文献与选文会显示快照，并默认保持本地敏感模式', async () => {
  const { root, panel } = setup();
  panel.setContext(context());
  panel.setSelection(selection());
  await settle();

  assert.equal(root.querySelector('[data-testid="paper-title"]').textContent, 'A paper title');
  assert.match(root.querySelector('[data-testid="selection-snapshot"]').textContent, /Selected sentence/);
  assert.equal(root.querySelector('[data-testid="selection-page"]').textContent, '第 4 页');
  assert.ok(root.querySelector('[data-testid="sensitivity-sensitive"]').checked);
  assert.equal(root.querySelector('[data-testid="allow-cloud"]').checked, false);
  assert.equal(root.querySelector('[data-testid="allow-cloud"]').disabled, true);
  panel.destroy();
});

test('XUL/XML 宿主使用 XHTML namespace，控件可交互且各实例 radio 不互相取消', async () => {
  const { dom, panelA, panelB, rootA, rootB, adapterA } = setupXml();
  const xhtml = 'http://www.w3.org/1999/xhtml';
  panelA.setContext(context({ item_key: 'ITEM-A', title: 'XML paper A' }));
  panelB.setContext(context({ item_key: 'ITEM-B', title: 'XML paper B' }));

  assert.equal(rootA.namespaceURI, xhtml);
  for (const control of rootA.querySelectorAll('input, button, select, textarea')) {
    assert.equal(control.namespaceURI, xhtml, `${control.localName} should be XHTML`);
  }
  const firstRadio = rootA.querySelector('[data-testid="sensitivity-sensitive"]');
  const secondRadio = rootB.querySelector('[data-testid="sensitivity-sensitive"]');
  assert.notEqual(firstRadio.name, secondRadio.name);
  rootA.querySelector('[data-testid="sensitivity-public"]').click();
  assert.equal(rootA.querySelector('[data-testid="sensitivity-public"]').checked, true);
  assert.equal(secondRadio.checked, true);

  panelA.focusQuestion();
  assert.equal(dom.window.document.activeElement, rootA.querySelector('[data-testid="question"]'));
  rootA.querySelector('[data-testid="analysis-submit"]').click();
  await settle();
  assert.equal(adapterA.calls.filter((call) => call.method === 'analyze').length, 1);
  panelA.destroy();
  panelB.destroy();
});

test('无模型时只允许证据摘录，翻译/模拟审稿不伪称完成', async () => {
  const adapter = makeAdapter({
    rpc(method, params) {
      this.calls.push({ method, params });
      if (method === 'health') {
        return Promise.resolve({ status: 'ok', zotero: { reachable: true }, models: { local: null, external: null } });
      }
      if (method === 'analyze') return Promise.resolve(analysis({ processing_location: 'none', sections: [] }));
      return Promise.resolve({});
    },
  });
  const { root, panel } = setup(adapter);
  panel.setContext(context());
  await settle();
  root.querySelector('[data-testid="mode"]').value = 'translate';
  root.querySelector('[data-testid="mode"]').dispatchEvent(new root.ownerDocument.defaultView.Event('change', { bubbles: true }));
  assert.equal(root.querySelector('[data-testid="analysis-submit"]').disabled, true);
  assert.match(root.querySelector('[data-testid="no-model-notice"]').textContent, /不会伪称完成/);
  assert.equal(adapter.calls.filter((call) => call.method === 'analyze').length, 0);
  panel.destroy();
});

test('未经同意的 external processing_location 触发隐私异常，拒绝模型结论且不声称已降级', async () => {
  const adapter = makeAdapter({
    rpc(method, params) {
      this.calls.push({ method, params });
      if (method === 'health') return Promise.resolve({ status: 'ok', zotero: { reachable: true }, models: { local: null, external: 'Cloud model' } });
      if (method === 'analyze') return Promise.resolve(analysis({
        processing_location: 'external',
        sections: [{ title: 'Model conclusion', content: 'Do not show this', evidence_ids: ['ev-1'] }],
      }));
      return Promise.resolve({});
    },
  });
  const { root, panel } = setup(adapter);
  panel.setContext(context());
  await settle();
  root.querySelector('[data-testid="analysis-submit"]').click();
  await settle();

  assert.match(root.querySelector('[data-testid="analysis-notice"]').textContent, /隐私异常/);
  assert.match(root.querySelector('[data-testid="analysis-notice"]').textContent, /未经本次明确同意的云端处理/);
  assert.doesNotMatch(root.querySelector('[data-testid="analysis-notice"]').textContent, /降级/);
  assert.doesNotMatch(root.querySelector('[data-testid="analysis-result"]').textContent, /Model conclusion/);
  assert.equal(root.querySelectorAll('.zrp-analysis-section').length, 0);
  assert.match(root.querySelector('[data-testid="analysis-meta"]')?.textContent || root.querySelector('[data-testid="analysis-result"]').textContent, /隐私异常/);
  panel.destroy();
});

test('正常分析展示 sections/evidence，页码按钮导航到 PDF', async () => {
  const adapter = makeAdapter({
    rpc(method, params) {
      this.calls.push({ method, params });
      if (method === 'health') {
        return Promise.resolve({ status: 'ok', zotero: { reachable: true }, models: { local: [], external: [] } });
      }
      if (method === 'analyze') return Promise.resolve(analysis());
      return Promise.resolve({});
    },
  });
  const { root, panel } = setup(adapter);
  panel.setContext(context());
  root.querySelector('[data-testid="mode"]').value = 'question';
  root.querySelector('[data-testid="question"]').value = 'What matters?';
  root.querySelector('[data-testid="analysis-submit"]').click();
  await settle();

  const analyzeCall = adapter.calls.find((call) => call.method === 'analyze');
  assert.ok(analyzeCall);
  assert.equal(analyzeCall.params.mode, 'question');
  assert.equal(analyzeCall.params.sensitivity, 'sensitive');
  assert.equal(analyzeCall.params.allow_cloud, false);
  assert.equal(root.querySelector('[data-testid="analysis-result"]').hidden, false);
  assert.match(root.querySelector('[data-testid="analysis-result"]').textContent, /Model conclusion/);
  assert.match(root.querySelector('[data-testid="evidence-ev-1"]').textContent, /Exact source excerpt/);

  root.querySelector('[data-testid="evidence-page-ev-1"]').click();
  assert.deepEqual(
    adapter.calls.find((call) => call.method === 'navigate').args,
    ['ATT-1', 4],
  );
  panel.destroy();
});

test('模型或论文内容按纯文本渲染，不执行 XSS', async () => {
  const malicious = '<img src=x onerror="window.__xss = true">';
  const adapter = makeAdapter({
    rpc(method, params) {
      this.calls.push({ method, params });
      if (method === 'health') return Promise.resolve({ status: 'ok', zotero: { reachable: true }, models: {} });
      if (method === 'analyze') return Promise.resolve(analysis({
        sections: [{ title: malicious, content: malicious, evidence_ids: ['ev-1'] }],
        evidence: [{ ...analysis().evidence[0], text: malicious }],
      }));
      return Promise.resolve({});
    },
  });
  const { dom, root, panel } = setup(adapter);
  panel.setContext(context());
  root.querySelector('[data-testid="analysis-submit"]').click();
  await settle();

  assert.equal(dom.window.__xss, undefined);
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.match(root.querySelector('[data-testid="analysis-result"]').textContent, /<img src=x/);
  panel.destroy();
});

test('高亮先 prepare 并显示预览，未确认前不 commit，确认后只提交一次', async () => {
  const { root, panel, adapter } = setup();
  panel.setContext(context());
  panel.setSelection(selection());
  const evidence = analysis().evidence[0];
  panel.setSelection(selection({ text: evidence.text, page: evidence.page }));
  root.querySelector('[data-testid="analysis-result"]').hidden = false;
  root.querySelector('[data-testid="analysis-result"]');
  // 公共 UI 行为：先生成一份分析结果，再点击该证据的高亮按钮。
  adapter.rpc = function (method, params) {
    this.calls.push({ method, params });
    if (method === 'analyze') return Promise.resolve(analysis());
    if (method === 'health') return Promise.resolve({ status: 'ok', zotero: { reachable: true }, models: {} });
    return Promise.resolve({});
  };
  root.querySelector('[data-testid="analysis-submit"]').click();
  await settle();
  root.querySelector('[data-testid="highlight-ev-1"]').click();
  await settle();

  assert.equal(adapter.calls.filter((call) => call.method === 'prepareHighlight').length, 1);
  assert.equal(adapter.calls.filter((call) => call.method === 'commitHighlight').length, 0);
  assert.match(root.querySelector('[data-testid="highlight-preview"]').textContent, /Exact source excerpt/);
  assert.match(root.querySelector('[data-testid="highlight-preview"]').textContent, /第 4 页/);
  assert.match(root.querySelector('[data-testid="highlight-preview"]').textContent, /#f3c969/);

  root.querySelector('[data-testid="highlight-commit"]').click();
  root.querySelector('[data-testid="highlight-commit"]').click();
  await settle();
  assert.equal(adapter.calls.filter((call) => call.method === 'commitHighlight').length, 1);
  panel.destroy();
});

test('笔记预览只读显示，先授权再明确确认内容才 write_note', async () => {
  const adapter = makeAdapter({
    rpc(method, params) {
      this.calls.push({ method, params });
      if (method === 'health') return Promise.resolve({ status: 'ok', zotero: { reachable: true }, models: {} });
      if (method === 'analyze') return Promise.resolve(analysis());
      if (method === 'preview_note') {
        return Promise.resolve({
          preview_token: 'note-token',
          digest: 'note-digest',
          parent_item_key: 'ITEM-1',
          title: 'Safe note',
          note_text: 'Safe note\nKey finding\n<script>window.__xss = true</script>',
          note_html: '<p><strong>Unsafe?</strong><script>window.__xss = true</script></p>',
          tags: ['research'],
          expires_at: '2099-01-01T00:00:00Z',
          requires_user_confirmation: true,
        });
      }
      if (method === 'authorize_write') return Promise.resolve({ authorized: true, remembered: false, detail: 'Authorized' });
      if (method === 'write_note') return Promise.resolve({ status: 'created', item_key: 'NOTE-1', digest: 'note-digest' });
      return Promise.resolve({});
    },
  });
  const { dom, root, panel } = setup(adapter);
  panel.setContext(context());
  root.querySelector('[data-testid="analysis-submit"]').click();
  await settle();
  root.querySelector('[data-testid="note-preview-submit"]').click();
  await settle();

  assert.equal(adapter.calls.filter((call) => call.method === 'preview_note').length, 1);
  assert.equal(adapter.calls.filter((call) => call.method === 'authorize_write').length, 0);
  assert.equal(adapter.calls.filter((call) => call.method === 'write_note').length, 0);
  assert.equal(dom.window.__xss, undefined);
  assert.equal(root.querySelectorAll('script').length, 0);
  assert.match(root.querySelector('[data-testid="note-preview"]').textContent, /Safe note/);
  assert.match(root.querySelector('[data-testid="note-preview"]').textContent, /<script>/);
  assert.doesNotMatch(root.querySelector('[data-testid="note-preview"]').textContent, /<p>/);
  const previewCall = adapter.calls.find((call) => call.method === 'preview_note');
  assert.match(previewCall.params.content, /证据链：ev-1/);
  assert.match(previewCall.params.content, /物理页码 4/);
  assert.match(previewCall.params.content, /source: pdf/);
  assert.equal(root.querySelector('[data-testid="note-save"]').textContent, '请求 Zotero 写入授权');

  root.querySelector('[data-testid="note-save"]').click();
  await settle();
  assert.equal(adapter.calls.filter((call) => call.method === 'authorize_write').length, 1);
  assert.equal(adapter.calls.filter((call) => call.method === 'write_note').length, 0);
  assert.match(root.querySelector('[data-testid="write-confirmation"]').textContent, /note-digest/);
  assert.match(root.querySelector('[data-testid="write-confirmation"]').textContent, /校验码/);
  assert.doesNotMatch(root.querySelector('[data-testid="write-confirmation"]').textContent, /note-token/);
  assert.doesNotMatch(root.querySelector('[data-testid="write-confirmation"]').textContent, /令牌/);

  root.querySelector('[data-testid="note-write-confirm"]').click();
  root.querySelector('[data-testid="note-write-confirm"]').click();
  await settle();
  assert.equal(adapter.calls.filter((call) => call.method === 'write_note').length, 1);
  assert.equal(adapter.calls.find((call) => call.method === 'write_note').params.confirmed_by_user, true);
  panel.destroy();
});

test('PDF 异步定位失败在面板内显示而不是未处理的 Promise', async () => {
  const { dom, panel, root } = setup(makeAdapter({
    navigate: async () => { throw new Error('合成 PDF 已移动'); },
  }));
  panel.setContext(context());
  panel.setSelection({ attachment_key: 'ATT-1', page: 2, text: 'Synthetic quote' });
  root.querySelector('[data-testid="selection-page"]').click();
  await settle();
  assert.match(root.querySelector('[data-testid="error"]').textContent, /PDF 已移动/);
  panel.destroy(); dom.window.close();
});

test('真实 Crossref 状态使用中文且不将无公告当作未撤稿', async () => {
  const { dom, panel, root } = setup(makeAdapter({
    rpc: async (method) => method === 'health'
      ? { status: 'ok', models: { local: null, external: null } }
      : { results: [{ doi: '10.5555/synthetic', status: 'no_notice_found', issues: [] }], warnings: [] },
  }));
  root.querySelector('[data-testid="doi-input"]').value = '10.5555/synthetic';
  root.querySelector('[data-testid="doi-network-consent"]').checked = true;
  root.querySelector('[data-testid="doi-submit"]').click();
  await settle();
  assert.match(root.querySelector('[data-testid="doi-status"]').textContent, /不等于无撤稿/);
  panel.destroy(); dom.window.close();
});

test('请求中重复点击只发出一次，并在结束后清除云端开关', async () => {
  const pending = deferred();
  const adapter = makeAdapter({
    rpc(method, params) {
      this.calls.push({ method, params });
      if (method === 'health') return Promise.resolve({ status: 'ok', zotero: { reachable: true }, models: {} });
      if (method === 'analyze') return pending.promise;
      return Promise.resolve({});
    },
  });
  const { root, panel } = setup(adapter);
  panel.setContext(context());
  root.querySelector('[data-testid="sensitivity-public"]').click();
  root.querySelector('[data-testid="allow-cloud"]').click();
  assert.equal(root.querySelector('[data-testid="allow-cloud"]').checked, true);
  root.querySelector('[data-testid="analysis-submit"]').click();
  root.querySelector('[data-testid="analysis-submit"]').click();
  assert.equal(adapter.calls.filter((call) => call.method === 'analyze').length, 1);
  assert.equal(root.querySelector('[data-testid="analysis-submit"]').disabled, true);
  pending.resolve(analysis({ sensitivity: 'public' }));
  await settle();
  assert.equal(root.querySelector('[data-testid="allow-cloud"]').checked, false);
  panel.destroy();
});

test('切换文献会清空结果/预览/授权，旧异步结果不会污染新文献', async () => {
  const pending = deferred();
  const adapter = makeAdapter({
    rpc(method, params) {
      this.calls.push({ method, params });
      if (method === 'health') return Promise.resolve({ status: 'ok', zotero: { reachable: true }, models: {} });
      if (method === 'analyze') return pending.promise;
      return Promise.resolve({});
    },
  });
  const { root, panel } = setup(adapter);
  panel.setContext(context({ item_key: 'ITEM-A', title: 'Old paper', attachment_key: 'ATT-A' }));
  root.querySelector('[data-testid="analysis-submit"]').click();
  assert.equal(root.querySelector('[data-testid="analysis-submit"]').disabled, true);
  panel.setContext(context({ item_key: 'ITEM-B', title: 'New paper', attachment_key: 'ATT-B' }));
  assert.equal(root.querySelector('[data-testid="paper-title"]').textContent, 'New paper');
  assert.equal(root.querySelector('[data-testid="analysis-result"]').hidden, true);
  assert.equal(root.querySelector('[data-testid="note-preview"]').hidden, true);
  assert.equal(root.querySelector('[data-testid="write-confirmation"]').hidden, true);
  assert.equal(root.querySelector('[data-testid="selection-snapshot"]').textContent, '暂无选文');
  pending.resolve(analysis({ item_key: 'ITEM-A', attachment_key: 'ATT-A' }));
  await settle();
  assert.equal(root.querySelector('[data-testid="analysis-result"]').hidden, true);
  assert.doesNotMatch(root.textContent, /Model conclusion/);
  panel.destroy();
});

test('DOI公网核验和 Codex 十分钟授权都需要独立勾选，支持撤销', async () => {
  const adapter = makeAdapter({
    rpc(method, params) {
      this.calls.push({ method, params });
      if (method === 'health') return Promise.resolve({ status: 'ok', zotero: { reachable: true }, models: {} });
      if (method === 'audit_citations') return Promise.resolve({
        status: 'ok',
        results: [{ doi: '10.1000/test', status: 'unknown', issues: ['撤稿状态未确定'], details: { source: 'public-metadata' } }],
      });
      if (method === 'grant_cloud_access') return Promise.resolve({ granted: true, expires_at: '2099-01-01T00:10:00Z' });
      if (method === 'revoke_cloud_access') return Promise.resolve({ revoked: true });
      return Promise.resolve({});
    },
  });
  const { root, panel } = setup(adapter);
  panel.setContext(context());

  root.querySelector('[data-testid="doi-input"]').value = '10.1000/test';
  root.querySelector('[data-testid="doi-network-consent"]').checked = true;
  root.querySelector('[data-testid="doi-submit"]').click();
  await settle();
  const doiParams = adapter.calls.find((call) => call.method === 'audit_citations').params;
  assert.equal(doiParams.allow_network, true);
  assert.equal(doiParams.requests.length, 1);
  assert.equal(doiParams.requests[0].doi, '10.1000/test');
  assert.match(root.querySelector('[data-testid="doi-status"]').textContent, /状态：未知/);
  assert.match(root.querySelector('[data-testid="doi-status"]').textContent, /问题：撤稿状态未确定/);
  assert.match(root.querySelector('[data-testid="doi-status"]').textContent, /详情：/);
  assert.doesNotMatch(root.querySelector('[data-testid="doi-status"]').textContent, /items/);

  root.querySelector('[data-testid="codex-consent"]').click();
  root.querySelector('[data-testid="grant-codex"]').click();
  await settle();
  const grant = adapter.calls.find((call) => call.method === 'grant_cloud_access');
  assert.equal(grant.params.item_key, 'ITEM-1');
  assert.equal(grant.params.confirmed_public, true);
  assert.equal(grant.params.include_notes, false);
  assert.equal(root.querySelector('[data-testid="grant-codex"]').hidden, true);
  assert.equal(root.querySelector('[data-testid="revoke-codex"]').hidden, false);

  root.querySelector('[data-testid="revoke-codex"]').click();
  await settle();
  assert.equal(adapter.calls.filter((call) => call.method === 'revoke_cloud_access').length, 1);
  assert.equal(root.querySelector('[data-testid="grant-codex"]').hidden, false);
  panel.destroy();
});

test('授权回执只在当前面板内存，撤销按钮始终可用，过期会清除 UI 回执', async () => {
  const adapter = makeAdapter({
    rpc(method, params) {
      this.calls.push({ method, params });
      if (method === 'health') return Promise.resolve({ status: 'ok', zotero: { reachable: true }, models: {} });
      if (method === 'grant_cloud_access') {
        return Promise.resolve({ granted: true, expires_at: new Date(Date.now() + 30).toISOString() });
      }
      if (method === 'revoke_cloud_access') return Promise.resolve({ revoked: true });
      return Promise.resolve({});
    },
  });
  const { root, panel } = setup(adapter);
  panel.setContext(context({ item_key: 'ITEM-A' }));
  assert.equal(root.querySelector('[data-testid="revoke-codex"]').hidden, false);
  assert.equal(root.querySelector('[data-testid="revoke-codex"]').disabled, false);
  assert.match(root.querySelector('[data-testid="cloud-status"]').textContent, /未在本面板保留/);

  root.querySelector('[data-testid="codex-consent"]').click();
  root.querySelector('[data-testid="grant-codex"]').click();
  await settle();
  assert.equal(root.querySelector('[data-testid="grant-codex"]').hidden, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(root.querySelector('[data-testid="grant-codex"]').hidden, false);
  assert.match(root.querySelector('[data-testid="cloud-status"]').textContent, /回执已到期/);

  panel.setContext(context({ item_key: 'ITEM-B' }));
  assert.equal(root.querySelector('[data-testid="grant-codex"]').hidden, false);
  assert.equal(root.querySelector('[data-testid="revoke-codex"]').hidden, false);
  assert.equal(root.querySelector('[data-testid="revoke-codex"]').disabled, false);
  root.querySelector('[data-testid="revoke-codex"]').click();
  await settle();
  const revoke = adapter.calls.filter((call) => call.method === 'revoke_cloud_access').at(-1);
  assert.equal(revoke.params.item_key, 'ITEM-B');
  assert.match(root.querySelector('[data-testid="cloud-status"]').textContent, /已撤销/);
  panel.destroy();
});

test('destroy 幂等并卸载面板，不接受异步回写', async () => {
  const { dom, panel, root } = setup();
  panel.destroy();
  panel.destroy();
  assert.equal(dom.window.document.body.contains(root), false);
  assert.doesNotThrow(() => panel.setContext(context()));
  assert.doesNotThrow(() => panel.setSelection(selection()));
  assert.doesNotThrow(() => panel.focusQuestion());
});
