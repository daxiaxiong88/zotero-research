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
  // Zotero trims leading/trailing form feeds when the edge pages are blank.
  fullText = { text: 'Seismic results', extractedPages: 3, totalPages: 3 };
  spans = await adapter.retrieveEvidence('PDFTEST1', 'Seismic', 6);
  assert.equal(spans[0].page, 3, 'blank first pages must not shift citations');
  await h.context.shutdown({}, 4);
});
