const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const context = vm.createContext({});
  const file = path.join(__dirname, '../addon/content/updates.js');
  if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  assert.ok(context.ZoteroResearchUpdates, 'the release checker must be available');
  return context.ZoteroResearchUpdates;
}
const repo = 'https://github.com/daxiaxiong88/zotero-research';
function catalog() {
  return {
    addons: { 'zotero-research@local.invalid': { updates: [{
      version: '0.9.2', update_link: repo + '/releases/download/v0.9.2/zotero-research-0.9.2.xpi',
      applications: { zotero: { strict_min_version: '10.0', strict_max_version: '10.0.*' } },
    }] } },
    userscript: { version: '1.1.2', release: '0.9.2' },
  };
}
function harness(options = {}) {
  const api = load();
  let saved = {}, requests = 0, now = 500000000;
  const checker = api.createChecker({
    kind: 'addon', currentVersion: '0.9.1',
    readState: () => saved, writeState: value => { saved = value; }, now: () => now,
    fetchCatalog: async () => { requests++; return catalog(); }, ...options,
  });
  return { api, checker, requests: () => requests, advance: ms => { now += ms; } };
}
test('release check is daily, coalesces requests, and notifies only once per version', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.checker.check(), h.checker.check()]);
  assert.equal(a.status, 'available'); assert.equal(b.version, '0.9.2');
  assert.equal(a.notify, true); assert.equal(h.requests(), 1);
  h.checker.markNotified(a.version);
  assert.equal((await h.checker.check()).notify, false);
  assert.equal(h.requests(), 1);
  assert.equal((await h.checker.check(true)).notify, true);
  assert.equal(h.requests(), 2);
  h.advance(25 * 3600000); await h.checker.check(); assert.equal(h.requests(), 3);
});
test('web updates link to a published userscript rather than a development file', async () => {
  const h = harness({ kind: 'userscript', currentVersion: '1.1.1' });
  const result = await h.checker.check();
  assert.equal(result.url, repo + '/releases/download/v0.9.2/zotero-research-webai.user.js');
  assert.equal(result.notesUrl, repo + '/releases/tag/v0.9.2');
});
test('numeric version comparison never downgrades or treats 1.1.10 as older than 1.1.9', async () => {
  const h = harness({ kind: 'userscript', currentVersion: '1.1.9', fetchCatalog: async () => ({ userscript: { version: '1.1.10', release: '0.9.2' } }) });
  assert.equal((await h.checker.check()).status, 'available');
  const newer = harness({ currentVersion: '0.10.0' });
  assert.equal((await newer.checker.check()).status, 'current');
});
test('offline or malformed metadata is unavailable, never falsely current; manual retry works', async () => {
  let response;
  const h = harness({ fetchCatalog: async () => { if (!response) throw new Error('offline'); return response; } });
  assert.equal((await h.checker.check()).status, 'unavailable');
  response = {}; assert.equal((await h.checker.check(true)).status, 'unavailable');
  response = catalog(); response.addons['zotero-research@local.invalid'].updates[0].update_link = 'https://example.com/evil.xpi';
  assert.equal((await h.checker.check(true)).status, 'unavailable');
  response = catalog(); assert.equal((await h.checker.check(true)).status, 'available');
});
test('storage failure cannot break checking and incompatible native versions are not advertised', async () => {
  const h = harness({ readState: () => { throw new Error('locked'); }, writeState: () => { throw new Error('locked'); }, compatible: () => false });
  assert.equal((await h.checker.check()).status, 'current');
});

test('upgrading clears a cached old update notice, while unchanged dismissed releases stay quiet', async () => {
  const api = load();
  let saved = { nextCheckAt: Date.now() + 86400000, catalog: catalog(), notified: '0.9.1' };
  const checker = api.createChecker({ kind: 'addon', currentVersion: '0.9.2', readState: () => saved,
    writeState: value => { saved = value; }, fetchCatalog: () => assert.fail('still cached') });
  assert.equal((await checker.check()).status, 'current');
});
