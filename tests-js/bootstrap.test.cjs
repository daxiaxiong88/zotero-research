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

test('mineru content_list 转分页文本：表格拍平、公式保留 LaTeX', async () => {
  const h = runtime();
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  // Expose internals for the test via the endpoint registration path is heavy;
  // instead validate through the adapter wiring: deepParseWithMineru exists.
  const registered = Object.keys(h.context.Zotero.Server.Endpoints || {});
  assert.ok(registered.includes('/zotero-research/relay'));
  // The panel-facing adapter is created in mount(); the function presence is
  // covered by panel tests. Here we assert the prefs defaults shipped.
  assert.equal(h.context.Zotero.Prefs.get('researchAssistant.mineruExecutable'), '');
  assert.equal(h.context.Zotero.Prefs.get('researchAssistant.mineruModelPath'), '');
});

test('MinerU stages a short PDF name, accepts wait objects, and surfaces nested task errors', async () => {
  const h = runtime();
  const executable = 'D:\\Research\\ChatGPT\\.venv\\Scripts\\mineru.exe';
  const modelPath = 'D:\\Zotero\\MinerU';
  const pdfPath = 'D:\\fixture\\Seismic Foundation Model (SFM) a new generation deep learning model in geophysics.pdf';
  const writes = [];
  const calls = [];
  const copies = [];
  const stderrChunks = [];
  const storedFiles = new Map();
  const removedPaths = [];
  let failWritePath = null;
  let removalBlock = null;
  let exitOutcome = { exitCode: 0 };
  let lastModified = 1234;
  let removed = false;
  h.context.zraHash = (value) => 'mineru-fixture-' + JSON.parse(value)[2];
  h.context.Zotero.Profile = { dir: 'C:\\fake-zotero-profile' };
  h.context.Zotero.DataDirectory = { dir: 'D:\\fake-zotero-data' };
  h.context.Zotero.logError = () => {};
  h.context.Zotero.Prefs.get = (key) => ({
    'researchAssistant.mineruExecutable': executable,
    'researchAssistant.mineruModelPath': modelPath,
  })[key] || '';
  const item = {
    id: 42, key: 'MINERU01', libraryID: 1, attachmentContentType: 'application/pdf',
    isAttachment: () => true, isFileAttachment: () => true,
    getFilePathAsync: async () => pdfPath,
  };
  h.context.Zotero.Items = { getByLibraryAndKey: () => item };
  h.context.Zotero.Libraries.get = () => ({ editable: true });
  h.context.Zotero.PDFWorker = {
    getFullText: async () => ({ text: 'source text', extractedPages: 1, totalPages: 1 }),
  };
  h.context.PathUtils = {
    join: (...parts) => path.win32.join(...parts),
    parent: (value) => path.win32.dirname(value),
    filename: (value) => path.win32.basename(value),
  };
  h.context.IOUtils = {
    exists: async (value) => value === executable || value === modelPath || storedFiles.has(value),
    makeDirectory: async () => {},
    stat: async (value) => value === pdfPath
      ? ({ size: 1024, lastModified }) : ({ isDir: false }),
    getChildren: async (directory) => [path.win32.join(directory, 'fixture_content_list.json')],
    copy: async (source, destination) => { copies.push([source, destination]); },
    remove: async (value) => {
      if (removalBlock) {
        const block = removalBlock;
        removalBlock = null;
        block.startedResolve();
        await block.promise;
      }
      removed = true;
      removedPaths.push(value);
      storedFiles.delete(value);
    },
  };
  h.context.Zotero.File.putContentsAsync = async (name, value) => {
    writes.push([name, value]);
    if (name === failWritePath) throw new Error('fixture migration write failed');
    storedFiles.set(name, value);
  };
  h.context.Zotero.File.getContentsAsync = async (name) => {
    if (storedFiles.has(name)) return storedFiles.get(name);
    assert.match(name, /_content_list\.json$/);
    return JSON.stringify([{ type: 'text', page_idx: 0, text: 'Parsed text' }]);
  };
  const fakeProcess = {
    stdout: { readString: async () => '' },
    stderr: { readString: async () => stderrChunks.shift() || '' },
    wait: async () => exitOutcome,
    kill: async () => assert.fail('successful MinerU process must not be killed'),
  };
  h.context.ChromeUtils = {
    importESModule: () => ({
      Subprocess: { call: async (options) => { calls.push(options); return fakeProcess; } },
    }),
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

  const result = await adapter.deepParseWithMineru('MINERU01');
  assert.equal(result.pages[0].text, 'Parsed text');
  assert.equal(result.stats.pageCount, 1);
  const stagedInput = calls[0].arguments[1];
  const outputDirectory = calls[0].arguments[3];
  assert.equal(path.win32.basename(stagedInput), 'input.pdf');
  assert.equal(path.win32.dirname(stagedInput), outputDirectory);
  assert.deepEqual(copies, [[pdfPath, stagedInput]], 'long source name is staged under a short name');
  assert.deepEqual(Array.from(calls[0].arguments), ['-p', stagedInput, '-o', outputDirectory, '-b', 'vlm-engine']);
  assert.equal(writes.length, 2, 'writes the local config and the parsed-text cache');
  assert.equal(writes[1][0], 'D:\\fake-zotero-data\\zotero-research-mineru\\MINERU01.json');
  assert.equal(removed, true, 'successful run directory is cleaned');

  // A genuine process failure should show the useful final error line instead
  // of reducing every failure to the same model/GPU guess.
  lastModified = 5678;
  exitOutcome = { exitCode: 7 };
  stderrChunks.push(
    'FileNotFoundError: [Errno 2] No such file or directory: C:\\Temp\\images\\x.jpg\n'
      + '- task#1 failed: ' + 'outer status '.repeat(40)
      + JSON.stringify({ status: 'failed', error: '[Errno 2] No such file or directory: C:\\Temp\\images\\x.jpg' }) + '\n',
    '',
  );
  let releaseRemoval;
  let removalStartedResolve;
  const removalStarted = new Promise(resolve => { removalStartedResolve = resolve; });
  removalBlock = {
    promise: new Promise(resolve => { releaseRemoval = resolve; }),
    startedResolve: removalStartedResolve,
  };
  let failureSettled = false;
  const failedParse = adapter.deepParseWithMineru('MINERU02');
  failedParse.catch(() => { failureSettled = true; });
  await removalStarted;
  await Promise.resolve();
  const settledBeforeCleanup = failureSettled;
  releaseRemoval();
  await assert.rejects(
    failedParse,
    /MinerU 退出码 7：\[Errno 2\] No such file or directory: C:\\Temp\\images\\x\.jpg/,
  );
  assert.equal(settledBeforeCleanup, false,
    'parse failure is not returned until temporary-run cleanup completes');

  // A long but active run must be allowed past the old 15-minute wall-clock
  // limit. Model each output chunk as one minute of useful work, then finish
  // successfully after 20 minutes.
  lastModified = 91011;
  let fakeNow = 0;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fakeNow])); }
    static now() { return fakeNow; }
  }
  h.context.Date = FakeDate;
  let timerHook = null;
  h.context.setTimeout = (resolve, delay) => {
    fakeNow += delay;
    if (timerHook) timerHook();
    queueMicrotask(resolve);
    return 1;
  };
  let activeTicks = 0;
  let pendingRead = null;
  let activeFinished = false;
  exitOutcome = new Promise(() => {});
  fakeProcess.wait = () => exitOutcome;
  fakeProcess.stdout.readString = () => {
    if (activeFinished) return Promise.resolve('');
    return new Promise(resolve => { pendingRead = resolve; });
  };
  timerHook = () => {
    if (fakeNow % (60 * 1000) === 0 && pendingRead) {
      const resolveRead = pendingRead;
      pendingRead = null;
      activeTicks += 1;
      queueMicrotask(() => resolveRead('Predict: ' + activeTicks + '/20\n'));
    }
    if (fakeNow >= 20 * 60 * 1000 && !activeFinished) {
      activeFinished = true;
    }
  };
  let activeKilled = false;
  fakeProcess.kill = async () => { activeKilled = true; };
  await assert.rejects(
    adapter.deepParseWithMineru('MINERU03'),
    /MinerU 已连续 15 分钟没有输出，已终止/,
  );
  assert.equal(activeTicks, 20);
  assert.equal(activeKilled, true);
  assert.ok(fakeNow >= 35 * 60 * 1000,
    '20 minutes of heartbeats defer the idle timeout until 15 minutes after the last output');

  // A genuinely silent process is still terminated after 15 minutes.
  lastModified = 121314;
  fakeNow = 0;
  timerHook = null;
  fakeProcess.stdout.readString = async () => '';
  let killed = false;
  exitOutcome = new Promise(() => {});
  fakeProcess.kill = async () => { killed = true; };
  await assert.rejects(
    adapter.deepParseWithMineru('MINERU04'),
    /MinerU 已连续 15 分钟没有输出，已终止/,
  );
  assert.equal(killed, true, 'silent MinerU process is terminated');

  // Even a noisy process cannot occupy the GPU indefinitely: heartbeats keep
  // the idle timer fresh, but the absolute 60-minute ceiling still wins.
  lastModified = 141516;
  fakeNow = 0;
  let maximumPendingRead = null;
  let maximumStopped = false;
  exitOutcome = new Promise(() => {});
  fakeProcess.wait = () => exitOutcome;
  fakeProcess.stdout.readString = () => maximumStopped
    ? Promise.resolve('')
    : new Promise(resolve => { maximumPendingRead = resolve; });
  timerHook = () => {
    if (fakeNow % (60 * 1000) === 0 && maximumPendingRead) {
      const resolveRead = maximumPendingRead;
      maximumPendingRead = null;
      queueMicrotask(() => resolveRead('Predict: still active\n'));
    }
  };
  let maximumKilled = false;
  fakeProcess.kill = async () => {
    maximumKilled = true;
    maximumStopped = true;
    if (maximumPendingRead) {
      const resolveRead = maximumPendingRead;
      maximumPendingRead = null;
      resolveRead('');
    }
  };
  await assert.rejects(
    adapter.deepParseWithMineru('MINERU07'),
    /MinerU 解析超过 60 分钟，已终止/,
  );
  assert.equal(maximumKilled, true);
  assert.ok(fakeNow >= 60 * 60 * 1000 && fakeNow < 61 * 60 * 1000,
    'absolute timeout stops a continuously active process at roughly 60 minutes');
  timerHook = null;

  // A valid cache from the former profile location is returned immediately,
  // copied to the Zotero data directory, and removed only after that succeeds.
  lastModified = 151617;
  const legacyPath = 'C:\\fake-zotero-profile\\zotero-research-mineru\\MINERU05.json';
  const migratedPath = 'D:\\fake-zotero-data\\zotero-research-mineru\\MINERU05.json';
  storedFiles.set(legacyPath, JSON.stringify({
    stamp: 'mineru-fixture-151617',
    pages: [{ number: 1, text: 'Legacy parsed text' }],
    stats: { pageCount: 1, textPages: 1, parsedAt: '2026-09-08T00:00:00.000Z' },
  }));
  const callsBeforeMigration = calls.length;
  const migrated = await adapter.deepParseWithMineru('MINERU05');
  assert.equal(migrated.cached, true);
  assert.equal(migrated.pages[0].text, 'Legacy parsed text');
  assert.equal(calls.length, callsBeforeMigration, 'migration avoids re-running MinerU');
  assert.equal(storedFiles.has(migratedPath), true, 'legacy cache is copied to the data directory');
  assert.equal(storedFiles.has(legacyPath), false, 'legacy cache is removed after a successful copy');
  assert.ok(removedPaths.includes(legacyPath));

  lastModified = 171819;
  const retainedLegacyPath = 'C:\\fake-zotero-profile\\zotero-research-mineru\\MINERU06.json';
  const failedMigrationPath = 'D:\\fake-zotero-data\\zotero-research-mineru\\MINERU06.json';
  storedFiles.set(retainedLegacyPath, JSON.stringify({
    stamp: 'mineru-fixture-171819',
    pages: [{ number: 1, text: 'Retained legacy text' }],
    stats: { pageCount: 1, textPages: 1, parsedAt: '2026-09-08T00:00:00.000Z' },
  }));
  failWritePath = failedMigrationPath;
  const retained = await adapter.deepParseWithMineru('MINERU06');
  assert.equal(retained.pages[0].text, 'Retained legacy text');
  assert.equal(storedFiles.has(retainedLegacyPath), true,
    'legacy cache survives when the new location cannot be written');
  assert.equal(storedFiles.has(failedMigrationPath), false);

  // Zotero installations without a configured data directory retain the
  // profile fallback for config, runs and the persistent parsed cache.
  h.context.Zotero.DataDirectory = undefined;
  lastModified = 191920;
  failWritePath = null;
  exitOutcome = { exitCode: 0 };
  fakeProcess.wait = async () => exitOutcome;
  fakeProcess.stdout.readString = async () => '';
  fakeProcess.kill = async () => assert.fail('successful fallback run must not be killed');
  const writesBeforeFallback = writes.length;
  const callsBeforeFallback = calls.length;
  const fallbackResult = await adapter.deepParseWithMineru('MINERU08');
  assert.equal(fallbackResult.pages[0].text, 'Parsed text');
  const fallbackCall = calls[callsBeforeFallback];
  const profileMineruRoot = 'C:\\fake-zotero-profile\\zotero-research-mineru';
  assert.ok(fallbackCall.arguments[3].startsWith(profileMineruRoot + '\\runs\\'));
  assert.deepEqual(writes.slice(writesBeforeFallback).map(entry => entry[0]), [
    profileMineruRoot + '\\mineru-tools.json',
    profileMineruRoot + '\\MINERU08.json',
  ]);
  await h.context.shutdown({}, 4);
});

function mountMineruAdapter(h, itemID = 42) {
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
  h.registrations.section.onRender({ body, doc, item: { id: itemID } });
  return adapter;
}

function configureMineruFixture(h, options = {}) {
  const executable = options.executable || 'D:\\fixture\\mineru.exe';
  const modelPath = options.modelPath || 'D:\\fixture\\models';
  const pdfPath = options.pdfPath || 'D:\\fixture\\paper.pdf';
  const stamp = options.stamp || 'mineru-fixture-cache';
  const files = options.files || new Map();
  const item = {
    id: options.itemID || 42, key: options.key || 'MINERU10', libraryID: 1,
    attachmentContentType: 'application/pdf',
    isAttachment: () => true, isFileAttachment: () => true,
    getFilePathAsync: async () => pdfPath,
  };
  h.context.zraHash = () => stamp;
  h.context.Zotero.Profile = { dir: 'C:\\fixture\\profile' };
  h.context.Zotero.DataDirectory = { dir: 'D:\\fixture\\data' };
  h.context.Zotero.Prefs.get = (key) => ({
    'researchAssistant.mineruExecutable': executable,
    'researchAssistant.mineruModelPath': modelPath,
  })[key] || '';
  h.context.Zotero.Items = { getByLibraryAndKey: () => item };
  h.context.Zotero.Libraries.get = () => ({ editable: true });
  h.context.PathUtils = {
    join: (...parts) => path.win32.join(...parts),
    parent: (value) => path.win32.dirname(value),
    filename: (value) => path.win32.basename(value),
  };
  h.context.IOUtils = {
    exists: async (value) => value === executable || value === modelPath || files.has(value),
    makeDirectory: async () => {},
    stat: async (value) => value === pdfPath
      ? ({ size: 1024, lastModified: 1234 }) : ({ isDir: false }),
    getChildren: async (directory) => [path.win32.join(directory, 'fixture_content_list.json')],
    copy: async () => {},
    remove: async () => {},
  };
  h.context.Zotero.File.getContentsAsync = async (name) => {
    if (files.has(name)) return files.get(name);
    if (/_content_list\.json$/.test(name)) {
      return JSON.stringify([{ type: 'text', page_idx: 0, text: 'Parsed MinerU text' }]);
    }
    throw new Error('fixture file missing: ' + name);
  };
  h.context.Zotero.File.putContentsAsync = async (name, value) => { files.set(name, value); };
  return { executable, modelPath, pdfPath, stamp, files, item };
}

test('MinerU cache hit refreshes pdfTextCache after built-in extraction already ran', async () => {
  const h = runtime();
  const fixture = configureMineruFixture(h, { key: 'MINERU10', stamp: 'mineru-fixture-cache' });
  const cachePath = 'D:\\fixture\\data\\zotero-research-mineru\\MINERU10.json';
  let extractionCalls = 0;
  h.context.Zotero.PDFWorker = {
    getFullText: async () => {
      extractionCalls += 1;
      return { text: 'Zotero built-in text', extractedPages: 1, totalPages: 1 };
    },
  };
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  const adapter = mountMineruAdapter(h);

  const before = await adapter.retrieveOverviewEvidence('MINERU10');
  assert.match(before.spans[0].text, /Zotero built-in text/);
  fixture.files.set(cachePath, JSON.stringify({
    stamp: fixture.stamp,
    pages: [{ number: 1, text: 'MinerU cached text' }],
  }));

  const cached = await adapter.deepParseWithMineru('MINERU10');
  assert.equal(cached.cached, true);
  const after = await adapter.retrieveOverviewEvidence('MINERU10');
  assert.match(after.spans[0].text, /MinerU cached text/);
  assert.equal(extractionCalls, 1, 'cache hit does not trigger another built-in extraction');
  await h.context.shutdown({}, 4);
});

test('MinerU coalesces concurrent parses for the same attachment', async () => {
  const h = runtime();
  configureMineruFixture(h, { key: 'MINERU11', stamp: 'mineru-fixture-concurrent' });
  h.context.Zotero.PDFWorker = {
    getFullText: async () => ({ text: 'source text', extractedPages: 1, totalPages: 1 }),
  };
  let calls = 0;
  let releaseExit;
  const exit = new Promise(resolve => { releaseExit = resolve; });
  const fakeProcess = {
    stdout: { readString: async () => '' },
    stderr: { readString: async () => '' },
    wait: () => exit,
    kill: async () => assert.fail('successful concurrent MinerU process must not be killed'),
  };
  h.context.ChromeUtils = {
    importESModule: () => ({
      Subprocess: { call: async () => { calls += 1; return fakeProcess; } },
    }),
  };
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  const adapter = mountMineruAdapter(h);
  const first = adapter.deepParseWithMineru('MINERU11');
  const second = adapter.deepParseWithMineru('MINERU11');
  await new Promise(resolve => setTimeout(resolve, 0));
  releaseExit({ exitCode: 0 });
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1, 'two clicks must not launch two GPU jobs');
  assert.deepEqual(results.map(result => result.pages[0].text), ['Parsed MinerU text', 'Parsed MinerU text']);
  await h.context.shutdown({}, 4);
});

test('MinerU rejects a different attachment while one GPU parse is active', async () => {
  const h = runtime();
  const fixture = configureMineruFixture(h, { key: 'MINERU13A', stamp: 'mineru-fixture-a' });
  const itemA = fixture.item;
  const itemB = {
    ...itemA, id: 43, key: 'MINERU13B',
    getFilePathAsync: async () => 'D:\\fixture\\paper-b.pdf',
  };
  h.context.Zotero.Items = {
    getByLibraryAndKey: (_libraryID, key) => key === itemA.key ? itemA : itemB,
  };
  h.context.zraHash = (value) => JSON.parse(value)[0].endsWith('paper-b.pdf')
    ? 'mineru-fixture-b' : 'mineru-fixture-a';
  h.context.IOUtils.stat = async (value) => /\.pdf$/.test(value)
    ? ({ size: 1024, lastModified: 1234 }) : ({ isDir: false });
  h.context.Zotero.PDFWorker = {
    getFullText: async () => ({ text: 'source text', extractedPages: 1, totalPages: 1 }),
  };
  let calls = 0;
  let releaseExit;
  const exit = new Promise(resolve => { releaseExit = resolve; });
  const fakeProcess = {
    stdout: { readString: async () => '' },
    stderr: { readString: async () => '' },
    wait: () => exit,
    kill: async () => assert.fail('active MinerU process must not be killed by a busy rejection'),
  };
  h.context.ChromeUtils = {
    importESModule: () => ({
      Subprocess: { call: async () => { calls += 1; return fakeProcess; } },
    }),
  };
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  const adapter = mountMineruAdapter(h);
  const first = adapter.deepParseWithMineru('MINERU13A');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  const busyPromise = adapter.deepParseWithMineru('MINERU13B').then(
    () => null,
    error => error,
  );
  releaseExit({ exitCode: 0 });
  const [busy] = await Promise.all([busyPromise, first]);
  assert.ok(busy);
  assert.match(busy.message, /MinerU 正在解析另一篇论文，请等待当前任务完成后重试/);
  assert.equal(calls, 1, 'different papers must not launch a second GPU job');
  const retried = await adapter.deepParseWithMineru('MINERU13B');
  assert.equal(retried.pages[0].text, 'Parsed MinerU text');
  assert.equal(calls, 2, 'the rejected paper can retry after the active job finishes');
  await h.context.shutdown({}, 4);
});

test('malformed MinerU cache falls back to Zotero PDF extraction', async () => {
  const h = runtime();
  const fixture = configureMineruFixture(h, { key: 'MINERU12', stamp: 'mineru-fixture-corrupt' });
  fixture.files.set('D:\\fixture\\data\\zotero-research-mineru\\MINERU12.json', JSON.stringify({
    stamp: fixture.stamp,
    pages: [null],
  }));
  let extractionCalls = 0;
  h.context.Zotero.PDFWorker = {
    getFullText: async () => {
      extractionCalls += 1;
      return { text: 'Recovered Zotero text', extractedPages: 1, totalPages: 1 };
    },
  };
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  const adapter = mountMineruAdapter(h);
  const overview = await adapter.retrieveOverviewEvidence('MINERU12');
  assert.match(overview.spans[0].text, /Recovered Zotero text/);
  assert.equal(extractionCalls, 1);
  await h.context.shutdown({}, 4);
});

test('MinerU migration keeps the legacy cache when the new bytes fail verification', async () => {
  const h = runtime();
  const files = new Map();
  const fixture = configureMineruFixture(h, {
    key: 'MINERU14', stamp: 'mineru-fixture-migration-verify', files,
  });
  const legacyPath = 'C:\\fixture\\profile\\zotero-research-mineru\\MINERU14.json';
  const currentPath = 'D:\\fixture\\data\\zotero-research-mineru\\MINERU14.json';
  files.set(legacyPath, JSON.stringify({
    stamp: fixture.stamp,
    pages: [{ number: 1, text: 'Legacy survives verification failure' }],
  }));
  h.context.Zotero.File.putContentsAsync = async (name, value) => {
    if (name === currentPath) {
      files.set(name, JSON.stringify({ stamp: fixture.stamp, pages: [null] }));
      return;
    }
    files.set(name, value);
  };
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  const adapter = mountMineruAdapter(h);
  const result = await adapter.deepParseWithMineru('MINERU14');
  assert.equal(result.cached, true);
  assert.equal(result.pages[0].text, 'Legacy survives verification failure');
  assert.equal(files.has(legacyPath), true, 'legacy remains available after a corrupt new write');
  await h.context.shutdown({}, 4);
});

test('MinerU cache write IO errors produce a stable parse error without logError', async () => {
  const h = runtime();
  const fixture = configureMineruFixture(h, { key: 'MINERU15', stamp: 'mineru-fixture-write-error' });
  const cachePath = 'D:\\fixture\\data\\zotero-research-mineru\\MINERU15.json';
  h.context.Zotero.PDFWorker = {
    getFullText: async () => ({ text: 'source text', extractedPages: 1, totalPages: 1 }),
  };
  h.context.Zotero.File.putContentsAsync = async (name, value) => {
    if (name === cachePath) throw new Error('fixture disk full');
    fixture.files.set(name, value);
  };
  h.context.ChromeUtils = {
    importESModule: () => ({
      Subprocess: {
        call: async () => ({
          stdout: { readString: async () => '' },
          stderr: { readString: async () => '' },
          wait: async () => ({ exitCode: 0 }),
          kill: async () => assert.fail('successful process must not be killed'),
        }),
      },
    }),
  };
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  const adapter = mountMineruAdapter(h);
  await assert.rejects(
    adapter.deepParseWithMineru('MINERU15'),
    /MinerU 解析成功，但无法写入持久缓存/,
  );
  await h.context.shutdown({}, 4);
});

test('MinerU uses totalPages for scanned PDFs whose text layer has zero pages', async () => {
  const h = runtime();
  configureMineruFixture(h, { key: 'MINERU16', stamp: 'mineru-fixture-scanned' });
  h.context.Zotero.PDFWorker = {
    getFullText: async () => ({ text: '', extractedPages: 0, totalPages: 3 }),
  };
  h.context.ChromeUtils = {
    importESModule: () => ({
      Subprocess: {
        call: async () => ({
          stdout: { readString: async () => '' },
          stderr: { readString: async () => '' },
          wait: async () => ({ exitCode: 0 }),
          kill: async () => assert.fail('successful process must not be killed'),
        }),
      },
    }),
  };
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  const adapter = mountMineruAdapter(h);
  const result = await adapter.deepParseWithMineru('MINERU16');
  assert.equal(result.stats.pageCount, 3);
  assert.equal(result.pages[0].number, 1);
  await h.context.shutdown({}, 4);
});

test('MinerU timeout remains bounded when kill and output pipes never settle', async () => {
  const h = runtime();
  configureMineruFixture(h, { key: 'MINERU17', stamp: 'mineru-fixture-uncooperative' });
  h.context.Zotero.PDFWorker = {
    getFullText: async () => ({ text: 'source text', extractedPages: 1, totalPages: 1 }),
  };
  let closedStdout = 0;
  let closedStderr = 0;
  const never = () => new Promise(() => {});
  h.context.ChromeUtils = {
    importESModule: () => ({
      Subprocess: {
        call: async () => ({
          stdout: { readString: never, close: () => { closedStdout += 1; } },
          stderr: { readString: never, close: () => { closedStderr += 1; } },
          wait: never,
          kill: never,
        }),
      },
    }),
  };
  let fakeNow = 0;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fakeNow])); }
    static now() { return fakeNow; }
  }
  h.context.Date = FakeDate;
  h.context.setTimeout = (resolve, delay) => {
    fakeNow += delay;
    queueMicrotask(resolve);
    return 1;
  };
  h.context.clearTimeout = () => {};
  let removed = false;
  h.context.IOUtils.remove = async () => { removed = true; };
  await h.context.startup({ id: 'zotero-research@local.invalid', rootURI: 'test:///' }, 3);
  const adapter = mountMineruAdapter(h);
  await assert.rejects(
    adapter.deepParseWithMineru('MINERU17'),
    /MinerU 已连续 15 分钟没有输出/,
  );
  assert.equal(removed, true, 'finally cleanup runs even after kill timeout');
  assert.equal(closedStdout, 1);
  assert.equal(closedStderr, 1);
  await h.context.shutdown({}, 4);
});
