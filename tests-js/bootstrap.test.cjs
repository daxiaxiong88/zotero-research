const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime(windows = []) {
  const events = [];
  const registrations = {};
  const Zotero = {
    File: {
      getContentsAsync: async () => assert.fail('Packaged jar resources require getResourceAsync, not the deprecated XHR-returning file API'),
      getResourceAsync: async () => JSON.stringify({ bridgeExecutable: 'D:\\test\\bridge.exe', workingDirectory: 'D:\\test' }),
    },
    getMainWindows: () => windows,
    Prefs: { get: () => '' },
    Libraries: { userLibraryID: 1 },
    Server: { Endpoints: {}, LocalAPI: { getServerID: () => 'test-library' } },
    DataObjectUtilities: { generateKey: () => 'ANNTAG23' },
    ItemPaneManager: {
      registerSection: (options) => { registrations.section = options; return 'returned-pane-id'; },
      unregisterSection: (id) => events.push(['unregister', id]),
    },
    PreferencePanes: {
      register: async (options) => { registrations.preferences = options; return 'returned-pref-id'; },
      unregister: (id) => events.push(['unregister-pref', id]),
    },
    Reader: {
      registerEventListener: (name, fn) => { registrations.selection = fn; events.push(['listen', name]); },
      unregisterEventListener: (name, fn) => { if (registrations.selection) assert.equal(fn, registrations.selection); events.push(['unlisten', name]); },
    },
  };
  const sandbox = { Zotero, setTimeout, clearTimeout, console, TextEncoder };
  sandbox.Services = {
    scriptloader: { loadSubScript: (url) => {
      if (url.endsWith('panel.js')) sandbox.ZoteroResearchPanel = { mount: () => assert.fail('not rendering yet') };
      else if (url.endsWith('relay.js')) { vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'addon', 'content', 'relay.js'), 'utf8'), context); sandbox.ZoteroResearchRelay = context.ZoteroResearchRelay; }
      else vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'addon', url.replace('test:///', '')), 'utf8'), context);
    } },
    obs: { addObserver: (fn, topic) => events.push(['observe', topic]), removeObserver: (fn, topic) => events.push(['unobserve', topic]) },
    uuid: { generateUUID: () => ({ toString: () => 'random-test-token' }) },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../addon/bootstrap.js'), 'utf8'), context);
  return { context, events, registrations };
}

test('Zotero lifecycle registers once, does not launch eagerly, and unregisters returned IDs', async () => {
  const h = runtime();
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///', version: '0.2.0' }, 3);
  assert.equal(typeof h.registrations.section.onRender, 'function');
  assert.equal(typeof h.registrations.section.onAsyncRender, 'function');
  assert.equal(h.registrations.section.pluginID, 'zotero-research@local.invalid');
  let enabled;
  h.registrations.section.onItemChange({ item: { libraryID: 2 }, setEnabled: (value) => { enabled = value; } });
  assert.equal(enabled, false);
  await h.context.shutdown({}, 4);
  assert.ok(h.events.some((event) => event[0] === 'unregister' && event[1] === 'returned-pane-id'));
  assert.ok(h.events.some((event) => event[0] === 'unregister-pref' && event[1] === 'returned-pref-id'));
  assert.ok(h.events.some((event) => event[0] === 'unlisten'));
  assert.ok(h.events.some((event) => event[0] === 'unobserve'));
});

test('ItemPaneManager follows Zotero 10 lifecycle and remounts after lazy DOM replacement', async () => {
  const h = runtime();
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  let mounts = 0;
  let destroys = 0;
  let rootPresent = false;
  h.context.ZoteroResearchPanel.mount = () => {
    mounts += 1;
    rootPresent = true;
    return { setContext() {}, destroy() { destroys += 1; rootPresent = false; } };
  };
  const document = {
    defaultView: {},
    createElementNS: () => ({}),
    documentElement: { appendChild() {} },
    getElementById: () => null,
    querySelector: () => null,
  };
  const body = {
    ownerDocument: document,
    appendChild() {},
    querySelector: (selector) => selector === '[data-zrp-root="true"]' && rootPresent ? {} : null,
    querySelectorAll: () => [],
  };
  const props = {
    doc: document,
    body,
    item: { id: 7 },
    refresh() {},
  };
  h.registrations.section.onInit(props);
  assert.equal(mounts, 0);
  assert.match(h.registrations.section.bodyXHTML, /zrp-panel-placeholder/);
  h.registrations.section.onRender(props);
  assert.equal(mounts, 1);
  rootPresent = false;
  h.context.ZoteroResearchPanel.mount = () => {
    mounts += 1;
    rootPresent = true;
    return { setContext() {}, destroy() { destroys += 1; rootPresent = false; } };
  };
  await h.registrations.section.onAsyncRender({ ...props, item: null });
  assert.equal(mounts, 2);
  assert.equal(destroys, 1);
  await h.context.shutdown({}, 4);
});

test('disabling the plugin removes its stylesheet and Fluent link from open windows', async () => {
  const removed = [];
  let stylesheet;
  const win = {
    MozXULElement: { insertFTLIfNeeded() {} },
    addEventListener() {}, removeEventListener() {},
  };
  win.document = {
    defaultView: win,
    createElementNS: () => ({ remove: () => removed.push('css') }),
    documentElement: { appendChild: (node) => { stylesheet = node; } },
    getElementById: () => stylesheet,
    querySelector: () => ({ remove: () => removed.push('ftl') }),
  };
  const h = runtime([win]);
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  await h.context.shutdown({}, 4);
  assert.deepEqual(removed.sort(), ['css', 'ftl']);
});

test('evidence extraction uses Zotero 10 getFullText with attachment ID and preserves physical pages', async () => {
  const h = runtime();
  h.context.zraHash = () => 'fixture-hash';
  h.context.IOUtils = { stat: async () => ({ size: 1024, lastModified: 1234 }) };
  const item = {
    id: 42, key: 'PDFTEST1', libraryID: 1, attachmentContentType: 'application/pdf',
    isAttachment: () => true, isFileAttachment: () => true,
    getFilePathAsync: async () => 'D:\\fixture.pdf',
  };
  h.context.Zotero.Items = { getByLibraryAndKey: () => item };
  h.context.Zotero.Libraries.get = () => ({ editable: true });
  const calls = [];
  let fullText = { text: 'Introduction\n\n\f\n\n\fSeismic results', extractedPages: 3, totalPages: 3 };
  h.context.Zotero.PDFWorker = {
    getFullText: async (id, pages) => {
      calls.push([id, pages]);
      if (Array.isArray(pages)) return { text: pages[0] === 2 ? 'Seismic results' : '', extractedPages: 1, totalPages: 3 };
      return fullText;
    },
  };
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  let adapter;
  h.context.ZoteroResearchPanel.mount = (_body, value) => {
    adapter = value;
    return { setContext() {}, destroy() {} };
  };
  const doc = {
    defaultView: {}, createElementNS: () => ({}), documentElement: { appendChild() {} },
    getElementById: () => null, querySelector: () => null,
  };
  const body = { ownerDocument: doc, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] };
  h.registrations.section.onRender({ body, doc, item: { id: 42 } });
  let spans = await adapter.retrieveEvidence('PDFTEST1', 'Seismic', 6);
  assert.equal(calls[0][0], 42, 'worker takes item ID, not filesystem path');
  assert.equal(spans[0].page, 3);
  const overview = await adapter.retrieveOverviewEvidence('PDFTEST1');
  assert.equal(overview.kind, 'full-text');
  assert.deepEqual(Array.from(overview.spans, s => s.page), [1, 3]);
  const fallback = await adapter.retrieveEvidence('PDFTEST1', '这篇论文讲什么', 6);
  assert.ok(fallback.length > 0);
  assert.equal(fallback[0].retrieval_fallback, true);
  // Zotero trims leading/trailing form feeds when the edge pages are blank.
  fullText = { text: 'Seismic results', extractedPages: 3, totalPages: 3 };
  spans = await adapter.retrieveEvidence('PDFTEST1', 'Seismic', 6);
  assert.equal(spans[0].page, 3, 'blank first pages must not shift citations');
  await h.context.shutdown({}, 4);
});

test('retrieveCurrentPageEvidence reads the reader page and scopes evidence to it', async () => {
  const h = runtime();
  h.context.zraHash = () => 'fixture-hash';
  h.context.IOUtils = { stat: async () => ({ size: 1024, lastModified: 1234 }) };
  const item = {
    id: 42, key: 'PDFTEST1', libraryID: 1, attachmentContentType: 'application/pdf',
    isAttachment: () => true, isFileAttachment: () => true,
    getFilePathAsync: async () => 'D://fixture.pdf',
  };
  h.context.Zotero.Items = {
    getByLibraryAndKey: () => item,
    get: (id) => (id === 42 ? item : { id, key: 'OTHERKEY1' }),
  };
  h.context.Zotero.Libraries.get = () => ({ editable: true });
  h.context.Zotero.PDFWorker = {
    getFullText: async () => ({ text: 'p1\fp2\fp3\fp4\fCurrent page text', extractedPages: 5, totalPages: 5 }),
  };
  const reader = { itemID: 42, _internalReader: { _lastViewState: { pageIndex: 4 } } };
  h.context.Zotero.getMainWindow = () => ({ Zotero_Tabs: { selectedID: 'tab-1' } });
  h.context.Zotero.Reader.getByTabID = () => reader;
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  let adapter;
  h.context.ZoteroResearchPanel.mount = (_body, value) => {
    adapter = value;
    return { setContext() {}, destroy() {} };
  };
  const doc = {
    defaultView: {}, createElementNS: () => ({}), documentElement: { appendChild() {} },
    getElementById: () => null, querySelector: () => null,
  };
  const body = { ownerDocument: doc, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] };
  h.registrations.section.onRender({ body, doc, item: { id: 42 } });

  const scoped = await adapter.retrieveCurrentPageEvidence('PDFTEST1');
  assert.equal(scoped.page, 5, 'zero-based reader pageIndex becomes 1-based page');
  assert.equal(scoped.spans.length, 1);
  assert.equal(scoped.spans[0].page, 5);
  assert.match(scoped.spans[0].text, /Current page text/);

  // A reader showing a different attachment yields no scoped evidence.
  reader.itemID = 99;
  assert.equal(await adapter.retrieveCurrentPageEvidence('PDFTEST1'), null);
  await h.context.shutdown({}, 4);
});

function sessionHarness(options = {}) {
  const files = new Map(Object.entries(options.files || {}));
  const writes = [];
  const removes = [];
  const profile = 'C:\\fake-zotero-profile';
  const pathFor = (key, suffix) => `${profile}\\zotero-research-sessions\\${key}${suffix}`;
  let writeCount = 0;
  let blockedWrite = null;
  let failNextWrite = false;
  let failNextMainWrite = false;
  let failBackupWrite = false;
  let corruptBackupWrite = false;
  let failRead = false;

  const h = runtime();
  h.context.Zotero.Profile = { dir: profile };
  h.context.PathUtils = { join: (...parts) => parts.join('\\') };
  h.context.IOUtils = {
    exists: async (name) => files.has(name),
    makeDirectory: async () => {},
    remove: async (name) => {
      removes.push(name);
      files.delete(name);
    },
  };
  h.context.Zotero.File.getContentsAsync = async (name) => {
    if (failRead) throw new Error('fixture read failed');
    if (!files.has(name)) throw new Error('fixture missing file');
    return files.get(name);
  };
  h.context.Zotero.File.putContentsAsync = async (name, value) => {
    writes.push({ name, value });
    writeCount += 1;
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('fixture write failed');
    }
    if (failNextMainWrite && name.endsWith('.json') && !name.endsWith('.pre-v2.bak')) {
      failNextMainWrite = false;
      throw new Error('fixture main write failed');
    }
    if (failBackupWrite && name.endsWith('.pre-v2.bak')) throw new Error('fixture backup failed');
    const currentBlock = blockedWrite;
    if (currentBlock && (!currentBlock.path || currentBlock.path === name)
      && name.endsWith('.json') && !name.endsWith('.pre-v2.bak')) {
      currentBlock.startedResolve();
      await currentBlock.promise;
    }
    files.set(name, corruptBackupWrite && name.endsWith('.pre-v2.bak') ? value + '\ncorrupt' : value);
  };

  const originalStart = h.context.startup;
  return {
    h,
    files,
    writes,
    removes,
    pathFor,
    get writeCount() { return writeCount; },
    failNextWrite() { failNextWrite = true; },
    failNextMainWrite() { failNextMainWrite = true; },
    failBackupWrite(value = true) { failBackupWrite = value; },
    corruptBackupWrite(value = true) { corruptBackupWrite = value; },
    failRead(value = true) { failRead = value; },
    blockNextMainWrite(itemKey = null) {
      let release;
      let startedResolve;
      const promise = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { startedResolve = resolve; });
      blockedWrite = { path: itemKey ? pathFor(itemKey, '.json') : null, promise, startedResolve };
      const unblock = () => { blockedWrite = null; release(); };
      unblock.started = started;
      return unblock;
    },
    async start() {
      await originalStart({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
      let adapter;
      h.context.ZoteroResearchPanel.mount = (_body, value) => {
        adapter = value;
        return { setContext() {}, destroy() {} };
      };
      const doc = {
        defaultView: {}, createElementNS: () => ({}), documentElement: { appendChild() {} },
        getElementById: () => null, querySelector: () => null,
      };
      const body = { ownerDocument: doc, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] };
      h.registrations.section.onRender({ body, doc, item: { id: 42 } });
      return adapter;
    },
  };
}

test('session storage migrates legacy evidence into sourceContext before compacting it', async () => {
  const fixture = sessionHarness();
  const adapter = await fixture.start();
  const legacy = {
    itemKey: 'LEGACY01', title: 'Legacy', provider: 'gemini', aiUrl: '', updatedAt: 'old',
    messages: [
      { role: 'user', content: 'What is this?', distill: false, distillRequest: false },
      { role: 'assistant', content: 'Answer', contextNotice: '历史范围已缩减', distill: false, evidence: [{
        evidence_id: 'p3:c1', page: 3, chunk_index: 1, score: 9,
        text: '原始证据'.repeat(120), retrieval_fallback: true,
      }] },
    ],
  };
  const main = fixture.pathFor('LEGACY01', '.json');
  const raw = JSON.stringify(legacy);
  fixture.files.set(main, raw);

  assert.deepEqual(JSON.parse(JSON.stringify(await adapter.loadChatSession('LEGACY01'))), legacy);
  assert.equal(fixture.writes.length, 0, 'load must not migrate or write');
  assert.equal(await adapter.saveChatSession('LEGACY01', legacy), true);
  const saved = JSON.parse(fixture.files.get(main));
  assert.equal(saved.format, 2);
  assert.match(saved.messages[0].sourceContext, /历史证据摘录/);
  assert.match(saved.messages[0].sourceContext, /原始证据原始证据/);
  assert.equal(saved.messages[1].evidence[0].text.length, 200);
  assert.equal(saved.messages[1].evidence[0].truncated, true);
  assert.equal(saved.messages[1].evidence[0].evidence_id, 'p3:c1');
  assert.equal(saved.messages[1].evidence[0].page, 3);
  assert.equal(saved.messages[1].evidence[0].chunk_index, 1);
  assert.equal(saved.messages[1].evidence[0].score, undefined);
  assert.equal(saved.messages[1].evidence[0].retrieval_fallback, undefined);
  assert.equal(saved.messages[1].contextNotice, '历史范围已缩减');
  assert.equal(await adapter.clearChatSession('LEGACY01'), true);
  assert.equal(fixture.files.has(main), false);
  assert.equal(fixture.files.has(fixture.pathFor('LEGACY01', '.json.pre-v2.bak')), false);
  await fixture.h.context.shutdown({}, 4);
});

test('legacy backup preserves exact bytes once and backup failure leaves old file untouched', async () => {
  const legacy = JSON.stringify({ messages: [{ role: 'user', content: 'old' }] });
  const fixture = sessionHarness();
  const main = fixture.pathFor('BACKUP01', '.json');
  const backup = fixture.pathFor('BACKUP01', '.json.pre-v2.bak');
  fixture.files.clear();
  fixture.files.set(main, legacy);
  const adapter = await fixture.start();

  assert.equal(await adapter.saveChatSession('BACKUP01', { messages: [{ role: 'user', content: 'new' }] }), true);
  assert.equal(fixture.files.get(backup), legacy);
  const backupWrites = fixture.writes.filter(write => write.name === backup);
  assert.equal(backupWrites.length, 1);
  assert.equal(await adapter.saveChatSession('BACKUP01', { messages: [{ role: 'user', content: 'newer' }] }), true);
  assert.equal(fixture.writes.filter(write => write.name === backup).length, 1);
  assert.equal(fixture.files.get(backup), legacy);

  const different = sessionHarness();
  const differentMain = different.pathFor('BACKUP03', '.json');
  const differentBackup = different.pathFor('BACKUP03', '.json.pre-v2.bak');
  const previousLegacy = JSON.stringify({ messages: [{ role: 'user', content: 'previous-old' }] });
  const currentLegacy = JSON.stringify({ messages: [{ role: 'user', content: 'current-old' }] });
  different.files.set(differentMain, currentLegacy);
  different.files.set(differentBackup, previousLegacy);
  const differentAdapter = await different.start();
  assert.equal(await differentAdapter.saveChatSession('BACKUP03', { messages: [{ role: 'user', content: 'new' }] }), true);
  assert.equal(different.files.get(differentBackup), previousLegacy);

  // A backup that cannot be parsed has no rollback value and must not block
  // migration forever, so it is rewritten from the old archive instead.
  const damaged = sessionHarness();
  const damagedMain = damaged.pathFor('BACKUP04', '.json');
  const damagedBackup = damaged.pathFor('BACKUP04', '.json.pre-v2.bak');
  damaged.files.set(damagedMain, legacy);
  damaged.files.set(damagedBackup, 'not-json');
  const damagedAdapter = await damaged.start();
  assert.equal(await damagedAdapter.saveChatSession('BACKUP04', { messages: [{ role: 'user', content: 'new' }] }), true);
  assert.equal(damaged.files.get(damagedBackup), legacy, 'unusable backup is rewritten from the old archive');
  assert.equal(JSON.parse(damaged.files.get(damagedMain)).format, 2, 'migration is no longer blocked');
  assert.equal(await damagedAdapter.saveChatSession('BACKUP04', { messages: [{ role: 'user', content: 'newer' }] }), true);
  assert.equal(damaged.files.get(damagedBackup), legacy, 'the rewritten backup is then left alone');

  const partial = sessionHarness();
  const partialMain = partial.pathFor('BACKUP06', '.json');
  const partialBackup = partial.pathFor('BACKUP06', '.json.pre-v2.bak');
  partial.files.set(partialMain, legacy);
  partial.files.set(partialBackup, JSON.stringify({ format: 2 }));
  const partialAdapter = await partial.start();
  assert.equal(await partialAdapter.saveChatSession('BACKUP06', { messages: [{ role: 'user', content: 'new' }] }), true);
  assert.equal(partial.files.get(partialBackup), legacy, 'a format-only file is not a usable backup either');

  const corrupt = sessionHarness();
  const corruptMain = corrupt.pathFor('BACKUP05', '.json');
  const corruptBackup = corrupt.pathFor('BACKUP05', '.json.pre-v2.bak');
  corrupt.files.set(corruptMain, legacy);
  const corruptAdapter = await corrupt.start();
  corrupt.corruptBackupWrite();
  assert.equal(await corruptAdapter.saveChatSession('BACKUP05', { messages: [{ role: 'user', content: 'new' }] }), false);
  assert.equal(corrupt.files.get(corruptMain), legacy);
  assert.notEqual(corrupt.files.get(corruptBackup), legacy);

  const retry = sessionHarness();
  const retryMain = retry.pathFor('BACKUP06', '.json');
  const retryBackup = retry.pathFor('BACKUP06', '.json.pre-v2.bak');
  retry.files.set(retryMain, legacy);
  const retryAdapter = await retry.start();
  retry.failNextMainWrite();
  assert.equal(await retryAdapter.saveChatSession('BACKUP06', { messages: [{ role: 'user', content: 'first' }] }), false);
  assert.equal(retry.files.get(retryMain), legacy);
  assert.equal(retry.files.get(retryBackup), legacy);
  assert.equal(await retryAdapter.saveChatSession('BACKUP06', { messages: [{ role: 'user', content: 'second' }] }), true);
  assert.equal(retry.files.get(retryBackup), legacy);
  assert.equal(retry.writes.filter(write => write.name === retryBackup).length, 1);

  const failed = sessionHarness();
  const failedMain = failed.pathFor('BACKUP02', '.json');
  failed.files.set(failedMain, legacy);
  const failedAdapter = await failed.start();
  failed.failBackupWrite();
  assert.equal(await failedAdapter.saveChatSession('BACKUP02', { messages: [{ role: 'user', content: 'new' }] }), false);
  assert.equal(failed.files.get(failedMain), legacy);
  await fixture.h.context.shutdown({}, 4);
  await different.h.context.shutdown({}, 4);
  await damaged.h.context.shutdown({}, 4);
  await corrupt.h.context.shutdown({}, 4);
  await retry.h.context.shutdown({}, 4);
  await failed.h.context.shutdown({}, 4);
});

test('session storage keeps all 500 messages while reducing evidence payload and retaining sourceContext', async () => {
  const fixture = sessionHarness();
  const adapter = await fixture.start();
  const messages = Array.from({ length: 500 }, (_unused, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: (index % 2 ? 'answer-' : 'question-') + index + ' '.repeat(40),
    sourceContext: index % 2 ? '' : '材料范围：第' + index + '页\n' + 'source '.repeat(80),
    evidence: index % 2 ? [{ evidence_id: 'p1:c1', page: 1, chunk_index: 1,
      score: 4, text: 'evidence '.repeat(120) }] : [],
    distill: index % 7 === 0,
    distillRequest: index % 11 === 0,
  }));
  const before = Buffer.byteLength(JSON.stringify({ messages }), 'utf8');
  assert.equal(await adapter.saveChatSession('VOLUME01', { title: 'Volume', messages }), true);
  const raw = fixture.files.get(fixture.pathFor('VOLUME01', '.json'));
  const saved = JSON.parse(raw);
  const after = Buffer.byteLength(raw, 'utf8');
  assert.equal(saved.messages.length, 500);
  assert.equal(saved.messages[0].content, messages[0].content);
  assert.equal(saved.messages[499].content, messages[499].content);
  assert.equal(saved.messages[0].sourceContext, messages[0].sourceContext);
  assert.ok(after < before, `expected compacted UTF-8 bytes: ${before} -> ${after}`);
  await fixture.h.context.shutdown({}, 4);
});

test('per-item queue serializes writes, coalesces pending saves, and clear is a barrier', async () => {
  const fixture = sessionHarness();
  const adapter = await fixture.start();
  const release = fixture.blockNextMainWrite();
  const saveA = adapter.saveChatSession('QUEUE001', { messages: [{ role: 'user', content: 'A' }] });
  await release.started;
  const saveB = adapter.saveChatSession('QUEUE001', { messages: [{ role: 'user', content: 'B' }] });
  const saveC = adapter.saveChatSession('QUEUE001', { messages: [{ role: 'user', content: 'C' }] });
  release();
  assert.equal(await saveA, true);
  assert.equal(await saveB, true);
  assert.equal(await saveC, true);
  assert.equal(JSON.parse(fixture.files.get(fixture.pathFor('QUEUE001', '.json'))).messages[0].content, 'C');
  assert.equal(fixture.writes.filter(write => write.name === fixture.pathFor('QUEUE001', '.json')).length, 2);

  const snapshotGate = fixture.blockNextMainWrite();
  const mutable = {
    messages: [{ role: 'assistant', content: 'before', contextNotice: 'keep this', evidence: [{
      evidence_id: 'p1:c1', page: 1, chunk_index: 1, text: 'x'.repeat(250),
    }] }],
  };
  const snapshotSave = adapter.saveChatSession('QUEUE001-SNAPSHOT', mutable);
  await snapshotGate.started;
  mutable.messages[0].content = 'after';
  mutable.messages[0].contextNotice = 'mutated';
  mutable.messages[0].evidence[0].text = 'changed';
  snapshotGate();
  assert.equal(await snapshotSave, true);
  const immutable = JSON.parse(fixture.files.get(fixture.pathFor('QUEUE001-SNAPSHOT', '.json')));
  assert.equal(immutable.messages[0].content, 'before');
  assert.equal(immutable.messages[0].contextNotice, 'keep this');
  assert.equal(immutable.messages[0].evidence[0].text, 'x'.repeat(200));

  const releaseA = fixture.blockNextMainWrite();
  const first = adapter.saveChatSession('QUEUE002', { messages: [{ role: 'user', content: 'A' }] });
  await releaseA.started;
  const clear = adapter.clearChatSession('QUEUE002');
  const afterClear = adapter.saveChatSession('QUEUE002', { messages: [{ role: 'user', content: 'B' }] });
  releaseA();
  assert.equal(await first, true);
  assert.equal(await clear, true);
  assert.equal(await afterClear, true);
  assert.equal(JSON.parse(fixture.files.get(fixture.pathFor('QUEUE002', '.json'))).messages[0].content, 'B');

  const releaseOld = fixture.blockNextMainWrite();
  const oldSave = adapter.saveChatSession('QUEUE003', { messages: [{ role: 'user', content: 'old' }] });
  await releaseOld.started;
  const barrier = adapter.clearChatSession('QUEUE003');
  const waitingLoad = adapter.loadChatSession('QUEUE003');
  releaseOld();
  assert.equal(await oldSave, true);
  assert.equal(await barrier, true);
  assert.equal(await waitingLoad, null);
  await fixture.h.context.shutdown({}, 4);
});

test('session queues are independent across items and continue after read/write failures', async () => {
  const fixture = sessionHarness();
  const adapter = await fixture.start();
  const parallelGate = fixture.blockNextMainWrite('PARALLEL-A');
  const parallelA = adapter.saveChatSession('PARALLEL-A', { messages: [{ role: 'user', content: 'A' }] });
  await parallelGate.started;
  const parallelB = adapter.saveChatSession('PARALLEL-B', { messages: [{ role: 'user', content: 'B' }] });
  assert.equal(await parallelB, true);
  assert.equal(JSON.parse(fixture.files.get(fixture.pathFor('PARALLEL-B', '.json'))).messages[0].content, 'B');
  parallelGate();
  assert.equal(await parallelA, true);

  assert.equal(await adapter.saveChatSession('ITEMA001', { messages: [{ role: 'user', content: 'A' }] }), true);
  assert.equal(await adapter.saveChatSession('ITEMB001', { messages: [{ role: 'user', content: 'B' }] }), true);
  assert.equal(await adapter.clearChatSession('ITEMA001'), true);
  assert.equal(await adapter.loadChatSession('ITEMA001'), null);
  assert.equal((await adapter.loadChatSession('ITEMB001')).messages[0].content, 'B');
  assert.equal(fixture.files.has(fixture.pathFor('ITEMB001', '.json')), true);

  fixture.failNextWrite();
  assert.equal(await adapter.saveChatSession('ITEMB001', { messages: [{ role: 'user', content: 'failed' }] }), false);
  assert.equal(await adapter.saveChatSession('ITEMB001', { messages: [{ role: 'user', content: 'recovered' }] }), true);
  assert.equal((await adapter.loadChatSession('ITEMB001')).messages[0].content, 'recovered');
  fixture.failRead();
  assert.equal(await adapter.loadChatSession('ITEMB001'), null);
  fixture.failRead(false);
  assert.equal(await adapter.saveChatSession('ITEMB001', { messages: [{ role: 'user', content: 'after-read-failure' }] }), true);
  await fixture.h.context.shutdown({}, 4);
});

test('shutdown waits for an in-flight session write without polling', async () => {
  const fixture = sessionHarness();
  const adapter = await fixture.start();
  const release = fixture.blockNextMainWrite();
  const save = adapter.saveChatSession('STOP001', { messages: [{ role: 'user', content: 'queued' }] });
  let stopped = false;
  const shutdown = fixture.h.context.shutdown({}, 4).then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stopped, false);
  assert.equal(await adapter.saveChatSession('STOP001', { messages: [{ role: 'user', content: 'late-save' }] }), false);
  assert.equal(await adapter.clearChatSession('STOP001'), false);
  assert.equal(await adapter.loadChatSession('STOP001'), null);
  release();
  assert.equal(await save, true);
  await shutdown;
  assert.equal(stopped, true);
});
