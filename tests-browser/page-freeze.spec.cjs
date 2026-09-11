const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Freeze only a disposable, fully intercepted test page. Never attach this
// control to a user's browser or account. Unlike fake hidden-page timers,
// Chromium itself suspends the renderer and its Worker callbacks here.
test('real page freeze pauses relay deadlines; resume delivers the same answer without replay', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium lifecycle control is required');
  test.setTimeout(35000);
  const executable = process.env.ZRA_TEST_CHROME_EXECUTABLE || chromium.executablePath();
  test.skip(!fs.existsSync(executable), 'Install full Chromium or set ZRA_TEST_CHROME_EXECUTABLE to test real freezing');
  const profile = test.info().outputPath('disposable-profile');
  fs.mkdirSync(profile, { recursive: true });
  // Use a brand-new test profile, never a running/user Chrome. Playwright's
  // normal launch disables backgrounding and its page session forces focus.
  const child = spawn(executable, [
    '--headless', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let browser;
  try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Disposable browser did not start')), 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  const requests = [];
  const lifecycle = [];
  await page.exposeFunction('fixtureLifecycle', event => lifecycle.push(event));
  let acknowledgeFirst;
  await page.exposeFunction('fixtureRelay', payload => {
    requests.push(payload);
    if (requests.length === 1) return new Promise(resolve => { acknowledgeFirst = resolve; });
    return { ok: true };
  });
  await page.goto('https://gemini.google.com/app');
  await page.evaluate(() => {
    window.__ZRA_TEST__ = {};
    window.lifecycleEvents = [];
    for (const name of ['freeze', 'resume']) document.addEventListener(name, () => {
      lifecycleEvents.push(name); void fixtureLifecycle(name);
    });
    window.GM_info = { script: { version: 'freeze-test' } };
    // Skip the unrelated startup handshake and explicitly enter a claimed
    // task below. All update requests/deadlines use the production code.
    window.GM_getValue = () => JSON.stringify({ isLocked: true, tabId: 'other-test-tab', expiresAt: Date.now() + 600000 });
    window.GM_setValue = window.GM_registerMenuCommand = window.GM_addValueChangeListener = window.GM_notification = () => {};
    window.GM_xmlhttpRequest = options => {
      let aborted = false;
      fixtureRelay(JSON.parse(options.data)).then(value => {
        if (!aborted) options.onload({ status: 200, responseText: JSON.stringify(value) });
      });
      return { abort() { aborted = true; } };
    };
    window.unsafeWindow = window;
  });
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '..', 'userscripts/zotero-research-webai.user.js'), 'utf8') });
  await page.evaluate(() => {
    const c = __ZRA_TEST__.connector;
    c.isRunning = true; c.currentTaskId = 'frozen-task'; c.taskStartedAt = Date.now();
    c.lastTask = { id: c.currentTaskId, phase: 'receiving', updateAttempts: 0 };
    c.onNewData('第一句。', false, 'network');
  });
  await expect.poll(() => requests.length).toBe(1);
  const controller = await context.newCDPSession(page);
  // Playwright normally forces every page to appear focused/visible, which
  // would silently turn this freeze experiment into an ordinary timer test.
  await controller.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  try {
    await controller.send('Page.setWebLifecycleState', { state: 'frozen' });
    await expect.poll(() => lifecycle).toEqual(['freeze']);
    acknowledgeFirst({ ok: true }); // The callback is ready, but the page cannot run it.
    await new Promise(resolve => setTimeout(resolve, 9000)); // longer than the real 8s request deadline
    expect(requests).toHaveLength(1);
  } finally {
    await controller.send('Page.setWebLifecycleState', { state: 'active' });
  }
  await page.evaluate(() => __ZRA_TEST__.connector.onNewData('第一句。恢复后完整的最后结论。', true, 'network'));
  await expect.poll(() => requests.some(request => request.isDone && request.text.endsWith('最后结论。'))).toBe(true);
  await expect.poll(() => page.evaluate(() => __ZRA_TEST__.connector.lastTask.endReason)).toBe('delivered');
  expect(await page.evaluate(() => lifecycleEvents)).toEqual(['freeze', 'resume']);
  const report = await page.evaluate(() => __ZRA_TEST__.connector.diagnosticReport());
  expect(report.lifecycle.frozen).toBe(false);
  expect(report.lifecycle.events.filter(entry => ['freeze', 'resume'].includes(entry.event)).map(entry => entry.event)).toEqual(['freeze', 'resume']);
  expect(requests.every(request => request.action === 'update' && request.id === 'frozen-task')).toBe(true);
  await controller.detach();
  } finally {
    // This CDP connection belongs only to the process/profile launched above.
    try {
      if (browser?.isConnected()) {
        const closing = await browser.newBrowserCDPSession();
        await closing.send('Browser.close').catch(() => {});
        await browser.close();
      }
    } finally {
      // Only the exact child we spawned with the disposable profile, including
      // failed startup/connection paths; never enumerate or kill user Chrome.
      if (child.exitCode === null && !child.killed) child.kill();
    }
  }
});
