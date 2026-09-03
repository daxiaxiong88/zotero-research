const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime(windows = []) {
  const events = [];
  const registrations = {};
  const Zotero = {
    File: { getContentsAsync: async () => JSON.stringify({ bridgeExecutable: 'D:\\test\\bridge.exe', workingDirectory: 'D:\\test' }) },
    getMainWindows: () => windows,
    Prefs: { get: () => '' },
    Libraries: { userLibraryID: 1 },
    Server: { LocalAPI: { getServerID: () => 'test-library' } },
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
      unregisterEventListener: (name, fn) => { assert.equal(fn, registrations.selection); events.push(['unlisten', name]); },
    },
  };
  const sandbox = { Zotero, setTimeout, clearTimeout, console, TextEncoder };
  sandbox.Services = {
    scriptloader: { loadSubScript: (url) => {
      if (url.endsWith('panel.js')) sandbox.ZoteroResearchPanel = { mount: () => assert.fail('not rendering yet') };
      else vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'addon', url.replace('test:///', '')), 'utf8'), context);
    } },
    obs: { addObserver: (fn, topic) => events.push(['observe', topic]), removeObserver: (fn, topic) => events.push(['unobserve', topic]) },
    uuid: { generateUUID: () => ({ toString: () => 'random-test-token' }) },
  };
  sandbox.ChromeUtils = { importESModule: () => ({ Subprocess: { call: () => assert.fail('startup must not spawn before use') } }) };
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
