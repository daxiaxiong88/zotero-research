const test = require('node:test');
const assert = require('node:assert/strict');
const { createLauncher } = require('../addon/content/browser.js');

function fixture(overrides = {}) {
  const calls = [];
  const adapter = {
    isWindows: () => true,
    findChrome: async () => 'C:\\Chrome\\chrome.exe',
    launch: (exe, args) => calls.push({ exe, args }),
    openDefault: url => calls.push({ default: url }),
    ...overrides,
  };
  return { launcher: createLauncher(adapter), calls };
}
const URL = 'https://gemini.google.com/app/saved-chat#zra-connect=1';

test('browser starts lazily with the existing profile and preserves the conversation URL', async () => {
  const h = fixture();
  assert.equal(h.calls.length, 0);
  assert.equal((await h.launcher.open(URL)).status, 'opened');
  assert.deepEqual(h.calls, [{ exe: 'C:\\Chrome\\chrome.exe', args: ['--disable-backgrounding-occluded-windows', URL] }]);
});

test('concurrent panels coalesce the same open; later opens can restart a closed browser', async () => {
  const h = fixture();
  await Promise.all([h.launcher.open(URL), h.launcher.open(URL)]);
  assert.equal(h.calls.length, 1);
  await h.launcher.open(URL);
  assert.equal(h.calls.length, 2);
});

test('requesting startup does not claim switches applied to an already running Chrome', async () => {
  const h = fixture();
  const result = await h.launcher.open(URL);
  assert.equal(result.status, 'opened');
  assert.match(result.message, /退出/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args.at(-1), URL);
});

test('other platforms keep their default browser; Chrome absence uses the default with a notice', async () => {
  const h = fixture({ findChrome: async () => null });
  assert.equal((await h.launcher.open(URL)).status, 'default');
  const other = fixture({ isWindows: () => false, findChrome: () => assert.fail('no Windows lookup') });
  assert.equal((await other.launcher.open(URL)).status, 'default');
  assert.deepEqual(other.calls, [{ default: URL }]);
});

test('browser URLs cannot be executable switches or unrelated pages', async () => {
  const h = fixture();
  for (const url of ['--no-sandbox', 'file:///C:/foo', 'https://gemini.google.com.evil.test/', 'https://user:pass@gemini.google.com/']) {
    await assert.rejects(h.launcher.open(url));
  }
  assert.equal(h.calls.length, 0);
});

test('shutdown during lookup prevents launching; failed lookups can be retried', async () => {
  let release;
  const h = fixture({ findChrome: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.launcher.open(URL);
  await new Promise(resolve => setImmediate(resolve));
  h.launcher.destroy();
  release('C:\\Chrome\\chrome.exe');
  await assert.rejects(pending);
  assert.equal(h.calls.length, 0);
  let count = 0;
  const retry = fixture({ findChrome: async () => { if (!count++) throw new Error('temporary'); return 'C:\\Chrome\\chrome.exe'; } });
  await assert.rejects(retry.launcher.open(URL), /temporary/);
  await retry.launcher.open(URL);
  assert.equal(retry.calls.length, 1);
});
