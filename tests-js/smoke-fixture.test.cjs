const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ wrongDirectory = false, failNativeChecks = false } = {}) {
  let releaseItems;
  let itemsReady = false;
  const itemLoading = new Promise((resolve) => { releaseItems = () => { itemsReady = true; resolve(); }; });
  const events = [];
  const reports = [];
  let observer;
  const root = path.resolve('synthetic-test-only');
  const pdf = { id: 2, key: 'PDFITEM2', getAnnotations: () => [] };
  const context = vm.createContext({
    PathUtils: { normalize: path.normalize, join: path.join },
    Services: { env: { get: () => root }, scriptloader: { loadSubScript: () => {} } },
    IOUtils: { writeUTF8: async (_name, value) => reports.push(JSON.parse(value)) },
    Zotero: {
      version: '10.0.1', getMainWindow: () => ({}), uiReadyPromise: Promise.resolve(),
      DataDirectory: { dir: path.join(root, wrongDirectory ? 'another-data' : 'data') },
      Libraries: { userLibraryID: 1, get: () => ({
        getDataLoaded: () => itemsReady, getDataLoadedPromise: () => itemLoading,
        waitForDataLoad: (kind) => { assert.equal(kind, 'item'); events.push('wait'); return itemLoading; },
      }) },
      Item: class {
        constructor() { assert.equal(itemsReady, true); events.push('create-item'); this.id = 1; this.key = 'PARENT23'; }
        setField() {}
        async saveTx() {}
        getNotes() { return []; }
      },
      Attachments: { importFromFile: async () => { events.push('import-pdf'); return pdf; } },
      Notifier: { registerObserver: (registered) => { observer = registered; return 'fixture-observer'; } },
      Plugins: { getAllPluginIDs: async () => ['zotero-research@local.invalid'], resolveURI: async () => 'synthetic://native-checks.js' },
      Server: { LocalAPI: { getServerID: () => 'synthetic-test' } },
      Reader: { open: async () => { events.push('open-reader'); } },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../tests/fixtures/zotero_smoke/bootstrap.js'), 'utf8'), context);
  context.fixtureConfig = { dataDirectory: path.join(root, 'data'), pdfPath: path.join(root, 'synthetic.pdf'), reportPath: path.join(root, 'report.json'), nativeChecks: failNativeChecks };
  context.runSyntheticNativeChecks = async () => {
    observer.notify();
    await new Promise((resolve) => setImmediate(resolve));
    throw new Error('intentional native test failure');
  };
  return { context, releaseItems, events, reports };
}

test('synthetic fixture waits for library item loading before creating any test data', async () => {
  const h = fixture();
  const preparing = h.context.prepareFixture();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.events, ['wait']);
  h.releaseItems();
  await preparing;
  assert.deepEqual(h.events, ['wait', 'create-item', 'import-pdf', 'open-reader']);
  assert.equal(h.reports.at(-1).status, 'fixture_ready');
  assert.equal(h.reports.at(-1).itemDataLoadedAfterFixture, true);
});

test('synthetic fixture refuses all writes if the native data directory is not its exact marked directory', async () => {
  const h = fixture({ wrongDirectory: true });
  await h.context.prepareFixture();
  assert.deepEqual(h.events, []);
  assert.equal(h.reports.at(-1).status, 'fixture_failed');
  assert.match(h.reports.at(-1).message, /marker mismatch/);
});

test('item notifications cannot report success before the native integration checks finish', async () => {
  const h = fixture({ failNativeChecks: true });
  h.releaseItems();
  await h.context.prepareFixture();
  assert.equal(h.reports.at(-1).status, 'fixture_failed');
  assert.equal(h.reports.some((report) => report.status === 'fixture_ready'), false);
});
