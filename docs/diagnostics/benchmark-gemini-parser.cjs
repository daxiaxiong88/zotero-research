// Synthetic parser-only benchmark. No real AI page/account or external request.
// Usage: node docs/diagnostics/benchmark-gemini-parser.cjs 12c2610
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../..');
const relative = 'userscripts/zotero-research-webai.user.js';
const ref = process.argv[2];
if (!ref || !/^[a-f0-9]{7,40}$/i.test(ref)) throw new Error('Pass a verified baseline commit hash');

function wire(text) {
  const result = []; result[1] = [text];
  const inner = []; inner[4] = [result];
  return JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]);
}
const prefix = wire('First sentence.');
const raw = prefix + '\n' + wire('['.repeat(1000) + 'x'.repeat(3350000)).slice(0, -45);

function measure(source) {
  const dom = new JSDOM('<body></body>', { url: 'https://gemini.google.com/app', runScripts: 'outside-only' });
  const w = dom.window;
  w.__ZRA_TEST__ = {};
  w.GM_info = { script: { version: 'synthetic-benchmark' } };
  w.GM_getValue = () => JSON.stringify({ isLocked: true, tabId: 'other', expiresAt: Date.now() + 600000 });
  w.GM_setValue = w.GM_registerMenuCommand = w.GM_addValueChangeListener = w.GM_notification = () => {};
  w.GM_xmlhttpRequest = () => { throw new Error('No network allowed in benchmark'); };
  w.setInterval = () => 0;
  w.unsafeWindow = w;
  w.eval(source);
  let searches = 0;
  const indexOf = w.String.prototype.indexOf;
  w.String.prototype.indexOf = function (needle, from) {
    if (needle === '[' && this.length === raw.length) searches++;
    return indexOf.call(this, needle, from);
  };
  try {
    const start = performance.now();
    const parsed = w.__ZRA_TEST__.parseGemini(raw);
    const elapsedMs = Math.round(performance.now() - start);
    if (parsed.text !== 'First sentence.' || parsed.done) throw new Error('Invalid partial-stream result');
    return { elapsedMs, searches, result: 'prior text preserved; incomplete frame not complete' };
  } finally { w.close(); }
}
const baseline = execFileSync('git', ['show', ref + ':' + relative], { cwd: root, encoding: 'utf8' });
const current = fs.readFileSync(path.join(root, relative), 'utf8');
console.log(JSON.stringify({ syntheticChars: raw.length, bracketCount: 1000, baselineRef: ref,
  baseline: measure(baseline), current: measure(current) }, null, 2));
