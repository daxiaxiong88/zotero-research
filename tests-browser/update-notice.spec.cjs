const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('new script release shows a dismissible popup without stealing composer focus', async ({ page, context }, testInfo) => {
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><body><form><div contenteditable="true" role="textbox">我的草稿</div></form></body>' }));
  await page.goto('https://gemini.google.com/app/test');
  await page.evaluate(() => {
    const store = new Map();
    window.unsafeWindow = window;
    window.GM_info = { script: { version: '1.1.1' } };
    window.GM_getValue = (key, fallback) => store.get(key) ?? fallback;
    window.GM_setValue = (key, value) => store.set(key, value);
    window.GM_addValueChangeListener = () => {};
    window.GM_registerMenuCommand = () => {};
    window.GM_notification = () => {};
    window.GM_xmlhttpRequest = options => {
      if (options.url.includes('raw.githubusercontent.com')) {
        window.resolveUpdate = () => options.onload({ status: 200, responseText: JSON.stringify({ userscript: { version: '1.1.2', release: '0.9.2' } }) });
      }
      return { abort() {} };
    };
  });
  await page.addScriptTag({ content: source('userscripts/zotero-research-webai.user.js') });
  await page.getByRole('textbox').focus();
  await page.evaluate(() => resolveUpdate());
  const popup = page.locator('[data-zra-update-notice]');
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('status')).toContainText('1.1.2');
  await expect(popup.getByRole('link', { name: '下载更新' })).toHaveAttribute('href', 'https://github.com/daxiaxiong88/zotero-research/releases/download/v0.9.2/zotero-research-webai.user.js');
  await expect(page.getByRole('textbox')).toBeFocused();
  await expect(page.getByRole('textbox')).toHaveText('我的草稿');
  await page.screenshot({ path: testInfo.outputPath('update-popup.png') });
  await popup.getByRole('button', { name: '稍后更新' }).click();
  await expect(popup).toBeHidden();
});
