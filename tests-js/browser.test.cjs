const test = require('node:test');
const assert = require('node:assert/strict');
const { createLauncher } = require('../addon/content/browser.js');

function fixture(overrides = {}) {
  const calls = [];
  const adapter = {
    isWindows: () => true,
    findChrome: async () => 'C:\\Chrome\\chrome.exe',
    findEdge: async () => 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    isExecutable: async () => true,
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

test('explicit system default never looks up or starts Chrome even when installed', async () => {
  const h = fixture({ getSettings: () => ({ mode: 'default' }), findChrome: () => assert.fail('must follow the system default') });
  await h.launcher.open(URL);
  assert.deepEqual(h.calls, [{ default: URL }]);
});

test('saved browser choice is reread for each open and Edge receives its own launch request', async () => {
  let mode = 'edge';
  const h = fixture({ getSettings: () => ({ mode }) });
  const result = await h.launcher.open(URL);
  assert.deepEqual(h.calls[0], { exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', args: ['--disable-backgrounding-occluded-windows', URL] });
  assert.match(result.message, /Edge/);
  mode = 'default';
  await h.launcher.open(URL);
  assert.deepEqual(h.calls[1], { default: URL });
});

test('a missing explicitly selected browser reports an error instead of switching browsers', async () => {
  for (const mode of ['chrome', 'edge']) {
    const h = fixture({ getSettings: () => ({ mode }), findChrome: async () => null, findEdge: async () => null });
    await assert.rejects(h.launcher.open(URL), /未找到.*(?:Chrome|Edge)/);
    assert.deepEqual(h.calls, []);
  }
});

test('custom executable paths preserve spaces and receive URLs as separate arguments', async () => {
  const h = fixture({ getSettings: () => ({ mode: 'custom', executable: ' "D:\\浏览器 Tools\\firefox.exe" ' }) });
  await h.launcher.open(URL);
  assert.deepEqual(h.calls, [{ exe: 'D:\\浏览器 Tools\\firefox.exe', args: [URL] }]);
  const chrome = fixture({ getSettings: () => ({ mode: 'custom', executable: 'D:\\Portable\\chrome.exe' }) });
  await chrome.launcher.open(URL);
  assert.deepEqual(chrome.calls[0].args, ['--disable-backgrounding-occluded-windows', URL]);
});

test('invalid custom settings never launch or fall back to another browser', async () => {
  for (const executable of ['', 'chrome.exe', 'C:\\Chrome\\chrome.exe --profile-directory=Other', 'C:\\launch.cmd', 'C:\\Chrome\\chrome.exe\n--no-sandbox']) {
    const h = fixture({ getSettings: () => ({ mode: 'custom', executable }) });
    await assert.rejects(h.launcher.open(URL), /路径|可执行/);
    assert.deepEqual(h.calls, []);
  }
  const missing = fixture({ getSettings: () => ({ mode: 'custom', executable: 'C:\\Missing\\chrome.exe' }), isExecutable: async () => false });
  await assert.rejects(missing.launcher.open(URL), /不存在|可执行/);
  assert.deepEqual(missing.calls, []);
  const unknown = fixture({ getSettings: () => ({ mode: 'unknown' }) });
  await assert.rejects(unknown.launcher.open(URL), /浏览器/);
  assert.deepEqual(unknown.calls, []);
});

test('non-Windows supports default and absolute custom executables without Chromium switches', async () => {
  const h = fixture({ isWindows: () => false, getSettings: () => ({ mode: 'custom', executable: '/Applications/Firefox.app/Contents/MacOS/firefox' }) });
  await h.launcher.open(URL);
  assert.deepEqual(h.calls, [{ exe: '/Applications/Firefox.app/Contents/MacOS/firefox', args: [URL] }]);
  const unsupported = fixture({ isWindows: () => false, getSettings: () => ({ mode: 'edge' }) });
  await assert.rejects(unsupported.launcher.open(URL), /系统默认|自定义/);
  assert.deepEqual(unsupported.calls, []);
});
