const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('diagnostic textarea and downloaded JSON retain the entire long report', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto('https://gemini.google.com/app');
  await page.evaluate(() => {
    window.__ZRA_TEST__ = {};
    window.menus = new Map();
    window.GM_info = { script: { version: 'diagnostic-test' } };
    const values = new Map();
    window.GM_getValue = (key, fallback) => values.get(key) ?? fallback;
    window.GM_setValue = (key, value) => values.set(key, value);
    window.GM_registerMenuCommand = (name, handler) => menus.set(name, handler);
    window.GM_addValueChangeListener = window.GM_notification = () => {};
    window.GM_xmlhttpRequest = () => ({ abort() {} });
    window.unsafeWindow = window;
  });
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '..', 'userscripts/zotero-research-webai.user.js'), 'utf8') });
  const expected = await page.evaluate(() => {
    window.reportFixture = { first: '前'.repeat(2200),
      lastTask: { phase: 'finished', endReason: 'relay-completed', capturedChars: 4321 },
      last: '后'.repeat(3500), literal: '</textarea><script>throw Error("must stay text")</script>' };
    __ZRA_TEST__.connector.diagnosticReport = () => reportFixture;
    menus.get('联动诊断（复制给开发者）')();
    return JSON.stringify(reportFixture, null, 2);
  });
  const field = page.locator('#zra-diagnostic-dialog textarea');
  await expect(field).toHaveValue(expected);
  expect(dialogs).toEqual([]);
  const refreshed = await page.evaluate(() => {
    reportFixture.lastTask.capturedChars = 9876;
    return JSON.stringify(reportFixture, null, 2);
  });
  const downloading = page.waitForEvent('download');
  await page.locator('[data-zra-diag="download"]').click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe('zotero-diagnostic-gemini.google.com.json');
  const actual = fs.readFileSync(await downloaded.path(), 'utf8');
  expect(actual).toBe(refreshed);
  expect(JSON.parse(actual).lastTask.capturedChars).toBe(9876);
  await expect(field).toHaveValue(refreshed);
  await page.locator('[data-zra-diag="close"]').click();
  await expect(field).toHaveCount(0);
});

test('a real document reload preserves task evidence but does not replay the prompt', async ({ page }) => {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.addInitScript(() => {
    window.__ZRA_TEST__ = {};
    window.GM_info = { script: { version: 'reload-test' } };
    const values = new Map();
    window.requests = [];
    window.GM_getValue = (key, fallback) => values.get(key) ?? fallback;
    window.GM_setValue = (key, value) => values.set(key, value);
    window.GM_registerMenuCommand = window.GM_addValueChangeListener = window.GM_notification = () => {};
    window.GM_xmlhttpRequest = options => { requests.push(JSON.parse(options.data)); return { abort() {} }; };
    window.unsafeWindow = window;
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'userscripts/zotero-research-webai.user.js'), 'utf8');
  await page.goto('https://gemini.google.com/app');
  await page.addScriptTag({ content: source });
  const oldId = await page.evaluate(async () => {
    const c = __ZRA_TEST__.connector;
    c.isRunning = true;
    c.deliverImages = async () => 'paste';
    c.fillInput = c.inputAccepts = c.handleSend = async () => true;
    c.startDomWatcher = () => {};
    await c.executeTask({ id: 'reload-fixture', messages: [
      { type: 'text', text: 'PRIVATE_QUESTION' }, { type: 'image', data: 'PRIVATE_IMAGE' },
    ] });
    c.isSendingUpdate = true;
    c.onNewData('PRIVATE_ANSWER', false, 'gemini-dom');
    return c.runtime.id;
  });
  await page.reload();
  await page.addScriptTag({ content: source });
  const { report, requests } = await page.evaluate(() => ({ report: __ZRA_TEST__.connector.diagnosticReport(), requests }));
  expect(report.runtime.id).not.toBe(oldId);
  expect(report.lastTask).toBeNull();
  expect(report.taskActive).toBe(false);
  const old = report.recentRuntimes.find(entry => entry.runtime.id === oldId);
  expect(old.lastTask.id).toBe('reload-fixture');
  expect(old.lastTask.capturedChars).toBe('PRIVATE_ANSWER'.length);
  expect(old.events.some(entry => entry.event === 'pagehide')).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|sessionSecret/);
  expect(requests.every(request => request.action === 'connect' || request.action === 'poll')).toBe(true);
});
