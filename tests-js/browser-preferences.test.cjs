const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function settings(t, values = new Map(), executable = true) {
  const content = name => fs.readFileSync(path.join(__dirname, '../addon/content', name), 'utf8');
  const dom = new JSDOM(content('preferences.xhtml'), { contentType: 'application/xhtml+xml', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window, document = window.document;
  window.Zotero = { isWin: true, Prefs: { get: key => values.get(key), set: (key, value) => values.set(key, value) } };
  window.Ci = { nsIFile: 'file' };
  window.Cc = { '@mozilla.org/file/local;1': { createInstance: () => ({
    initWithPath(value) { this.path = value; }, exists: () => executable, isFile: () => executable, isExecutable: () => executable,
  }) } };
  window.eval(content('browser.js'));
  window.eval(content('preferences.js'));
  const change = value => {
    const select = document.getElementById('zra-browser-mode');
    assert.ok(select, 'browser choice belongs in the real preferences fragment');
    select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  return { document, window, values, change, field: id => document.getElementById(id) };
}

test('browser choices live beside MinerU and save independently of invalid API settings', t => {
  const h = settings(t);
  const mode = h.field('zra-browser-mode');
  assert.ok(mode);
  assert.deepEqual(Array.from(mode.options, option => option.value), ['default', 'chrome', 'edge', 'custom']);
  assert.equal(mode.value, 'chrome', 'preserve the Windows launch behavior until explicitly changed');
  assert.equal(h.field('zra-browser-custom').hidden, true);
  h.field('zra-api-base').value = 'invalid API draft';
  h.field('zra-mineru-executable').value = 'unsaved MinerU draft';
  h.change('edge');
  h.field('zra-browser-save').click();
  assert.equal(h.values.get('researchAssistant.browserMode'), 'edge');
  assert.equal(h.values.has('researchAssistant.apiBaseUrl'), false);
  assert.equal(h.values.has('researchAssistant.mineruExecutable'), false);
  assert.match(h.field('zra-browser-status').textContent, /已保存/);
  const restored = settings(t, h.values);
  assert.equal(restored.field('zra-browser-mode').value, 'edge');
});

test('custom path field toggles, validates, and restores without modifying the old valid selection on errors', t => {
  const h = settings(t, new Map([['researchAssistant.browserMode', 'edge']]));
  h.change('custom');
  assert.equal(h.field('zra-browser-custom').hidden, false);
  h.field('zra-browser-executable').value = 'chrome.exe --flag';
  h.field('zra-browser-save').click();
  assert.equal(h.values.get('researchAssistant.browserMode'), 'edge');
  assert.match(h.field('zra-browser-status').textContent, /路径|可执行/);
  h.field('zra-browser-executable').value = ' "D:\\My Browser\\firefox.exe" ';
  h.field('zra-browser-save').click();
  assert.equal(h.values.get('researchAssistant.browserMode'), 'custom');
  assert.equal(h.values.get('researchAssistant.browserExecutable'), 'D:\\My Browser\\firefox.exe');
  const restored = settings(t, h.values);
  assert.equal(restored.field('zra-browser-mode').value, 'custom');
  assert.equal(restored.field('zra-browser-executable').value, 'D:\\My Browser\\firefox.exe');
  assert.equal(restored.field('zra-browser-custom').hidden, false);
  restored.change('default');
  assert.equal(restored.field('zra-browser-custom').hidden, true);
  restored.field('zra-browser-save').click();
  assert.equal(h.values.get('researchAssistant.browserMode'), 'default');
});

test('nonexistent custom browser reports a settings error without replacing saved preferences', t => {
  const h = settings(t, new Map([['researchAssistant.browserMode', 'default']]), false);
  h.change('custom');
  h.field('zra-browser-executable').value = 'D:\\Missing\\firefox.exe';
  h.field('zra-browser-save').click();
  assert.match(h.field('zra-browser-status').textContent, /不存在|可执行/);
  assert.equal(h.values.get('researchAssistant.browserMode'), 'default');
});
