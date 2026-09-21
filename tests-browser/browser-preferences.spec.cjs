const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '../addon/content', name), 'utf8');

test('browser selection is saved in the preferences pane and controls the next open', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 520, height: 1050 });
  await page.setContent('<!doctype html><meta charset="utf-8"><style>body {margin:20px;font:14px/1.5 system-ui;} section {display:block;margin-bottom:24px;} h2 {font-size:17px;} p {margin:10px 0;} input,select,button {font:inherit;} input,select {padding:6px;}</style>');
  await page.evaluate(xml => {
    // Render the real fragment in an unprivileged browser: XUL containers become
    // sections, and HTML controls lose only their XML prefix (Playwright's
    // input actions otherwise mistake "html:select" for a non-input element).
    function importControl(node) {
      if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
      if (node.nodeType !== Node.ELEMENT_NODE) return document.createTextNode('');
      const element = document.createElement(node.namespaceURI === 'http://www.w3.org/1999/xhtml' ? node.localName : 'section');
      for (const attribute of node.attributes) if (!attribute.name.startsWith('xmlns')) element.setAttribute(attribute.name, attribute.value);
      for (const child of node.childNodes) element.appendChild(importControl(child));
      return element;
    }
    // Firefox reserves the XUL namespace for privileged windows such as Zotero.
    const fixtureXML = xml.replace('http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul', 'urn:zra-test-xul');
    const fragment = new DOMParser().parseFromString(fixtureXML, 'application/xml');
    if (fragment.querySelector('parsererror')) throw new Error('Invalid preferences XML');
    document.body.appendChild(importControl(fragment.documentElement));
    window.preferences = new Map(); window.opens = [];
    window.Zotero = { isWin: true, Prefs: { get: key => preferences.get(key), set: (key, value) => preferences.set(key, value) } };
    window.Ci = { nsIFile: 'file' };
    window.Cc = { '@mozilla.org/file/local;1': { createInstance: () => ({
      initWithPath(value) { this.path = value; }, exists() { return this.path === 'D:\\My Browser\\firefox.exe'; }, isFile: () => true, isExecutable: () => true,
    }) } };
  }, source('preferences.xhtml'));
  await page.addStyleTag({ content: source('panel.css') });
  await page.addScriptTag({ content: source('browser.js') });
  await page.addScriptTag({ content: source('preferences.js') });
  await page.evaluate(() => {
    window.launcher = ZoteroResearchBrowser.createLauncher({
      isWindows: () => true,
      getSettings: () => ({ mode: preferences.get('researchAssistant.browserMode'), executable: preferences.get('researchAssistant.browserExecutable') }),
      findChrome: async () => 'C:\\Chrome\\chrome.exe', findEdge: async () => 'C:\\Edge\\msedge.exe',
      isExecutable: async () => true,
      launch: (exe, args) => opens.push({ exe, args }), openDefault: url => opens.push({ default: url }),
    });
  });
  const select = page.locator('#zra-browser-mode'), save = page.getByRole('button', { name: '保存浏览器设置' });
  await expect(select).toHaveValue('chrome');
  await expect(page.locator('#zra-browser-custom')).toBeHidden();
  await select.selectOption('edge'); await save.click();
  await expect(page.locator('#zra-browser-status')).toContainText('已保存');
  await page.evaluate(() => launcher.open('https://gemini.google.com/app/example'));
  expect(await page.evaluate(() => opens[0])).toEqual({ exe: 'C:\\Edge\\msedge.exe', args: ['--disable-backgrounding-occluded-windows', 'https://gemini.google.com/app/example'] });
  await select.selectOption('custom');
  await expect(page.getByLabel('浏览器可执行文件的完整路径')).toBeVisible();
  await page.getByLabel('浏览器可执行文件的完整路径').fill('D:\\Missing\\browser.exe'); await save.click();
  await expect(page.locator('#zra-browser-status')).toContainText('未保存');
  expect(await page.evaluate(() => preferences.get('researchAssistant.browserMode'))).toBe('edge');
  await page.getByLabel('浏览器可执行文件的完整路径').fill('"D:\\My Browser\\firefox.exe"'); await save.click();
  await page.evaluate(() => ZoteroResearchPreferences.init());
  await expect(select).toHaveValue('custom');
  await expect(page.getByLabel('浏览器可执行文件的完整路径')).toHaveValue('D:\\My Browser\\firefox.exe');
  await page.evaluate(() => launcher.open('https://chatgpt.com/'));
  expect(await page.evaluate(() => opens[1])).toEqual({ exe: 'D:\\My Browser\\firefox.exe', args: ['https://chatgpt.com/'] });
  await page.screenshot({ path: testInfo.outputPath('browser-settings.png') });
  await select.selectOption('default'); await save.click();
  await page.evaluate(() => launcher.open('https://claude.ai/'));
  expect(await page.evaluate(() => opens[2])).toEqual({ default: 'https://claude.ai/' });
  await expect(page.locator('#zra-browser-custom')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
