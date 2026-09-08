const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

function findBrowser() {
  const candidates = [
    process.env.ZRA_BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function asset(relativePath) {
  return pathToFileURL(path.join(REPO, relativePath)).href;
}

test('display math cannot contribute intrinsic width to Zotero flex sections', () => {
  const css = fs.readFileSync(path.join(REPO, 'addon/content/panel.css'), 'utf8');
  const rule = /\.zrp-math-rendered\.zrp-math-block\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'rendered display-math rule is missing');
  assert.match(rule[1], /\bwidth\s*:\s*100%\s*;/, 'display math needs a definite sidebar width');
  assert.match(rule[1], /\bcontain\s*:\s*inline-size\s*;/,
    'Firefox propagates MathML min-content width through Zotero flex sections');
});

test('narrow sidebar wraps prose after rendering a long formula', (t) => {
  const browser = findBrowser();
  if (!browser) {
    t.skip('Chrome or Edge is required for the layout regression test');
    return;
  }

  const answer = [
    '$$\\mathcal{L}(a_t,q_t,\\mathcal{N}_t)=-\\log\\frac{\\exp[\\operatorname{sim}(a_t,q_t)/\\kappa]}{\\exp[\\operatorname{sim}(a_t,q_t)/\\kappa]+\\sum_{n\\in\\mathcal{N}_t}\\exp[\\operatorname{sim}(a_t,n)/\\kappa]}$$',
    '',
    '- **作者在此处梳理的技术演进**：作者按时间线梳理监督模型发展脉络。',
    '- **早期浅层网络**：1990 年代起采用多层感知机进行地震波震相识别与拾取。',
    '- **卷积神经网络（ConvNets）**：用于震相分类、检测和定位。',
  ].join('\n');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zrp-layout-profile-'));
  const htmlPath = path.join(os.tmpdir(), `zrp-layout-${process.pid}.html`);
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('addon/content/panel.css')}">
<style>
  html, body { width: 800px; margin: 0; overflow-x: hidden; }
  /* Zotero's item pane hosts sections in a shrinkable flex track. Its child
   * must not contribute a large intrinsic width when an answer contains math. */
  #zotero-pane-viewport { display: flex; width: 700px; overflow: hidden; }
  #zotero-custom-section,
  #zotero-collapsible-section,
  #zotero-pane-host { display: flex; flex: 1 1 auto; flex-direction: column; }
</style>
<body><div id="zotero-pane-viewport"><div id="zotero-custom-section"><div id="zotero-collapsible-section"><div id="zotero-pane-host"></div></div></div></div><pre id="layout-result">PENDING</pre></body>
<script>
  addEventListener('error', event => {
    document.getElementById('layout-result').textContent = 'ERROR ' + event.message;
  });
  addEventListener('unhandledrejection', event => {
    document.getElementById('layout-result').textContent = 'ERROR ' + event.reason;
  });
</script>
<script src="${asset('addon/content/katex.min.js')}"></script>
<script src="${asset('addon/content/markdown.js')}"></script>
<script src="${asset('addon/content/panel.js')}"></script>
<script>
  const relay = {
    state: () => ({ connected: true, ai: 'Gemini', url: 'https://gemini.google.com/' }),
    subscribe: () => () => {},
    enqueueTask: () => 'unused'
  };
  const adapter = {
    relay,
    loadChatSession: async () => ({ messages: [{ role: 'assistant', content: ${JSON.stringify(answer)} }] }),
    retrieveEvidence: async () => [],
    openSettings() {}, openExternal() {}, copyText() {}
  };
  const viewportNode = document.getElementById('zotero-pane-viewport');
  const host = document.getElementById('zotero-pane-host');
  const panel = ZoteroResearchPanel.mount(host, adapter);
  panel.setContext({ item_key: 'LAYOUT01', attachment_key: 'PDF00001', library_id: 1, title: 'Layout fixture' });
  setTimeout(() => {
    viewportNode.style.width = '360px';
    setTimeout(() => {
    const root = document.querySelector('.zrp-panel');
    const card = document.querySelector('.zrp-chat-card');
    const messages = document.querySelector('.zrp-chat-messages');
    const content = document.querySelector('.zrp-message-content');
    const viewport = viewportNode.clientWidth;
    const metrics = {
      viewport,
      hostClient: host.clientWidth,
      hostScroll: host.scrollWidth,
      rootClient: root.clientWidth,
      rootScroll: root.scrollWidth,
      cardClient: card.clientWidth,
      cardScroll: card.scrollWidth,
      messagesClient: messages.clientWidth,
      messagesScroll: messages.scrollWidth,
      rootRight: Math.ceil(root.getBoundingClientRect().right),
      cardRight: Math.ceil(card.getBoundingClientRect().right),
      contentRight: Math.ceil(content.getBoundingClientRect().right),
      contentClient: content.clientWidth,
      contentScroll: content.scrollWidth
    };
    const fits = metrics.hostClient <= viewport + 1
      && metrics.hostScroll <= viewport + 1
      && metrics.rootScroll <= metrics.rootClient + 1
      && metrics.cardScroll <= metrics.cardClient + 1
      && metrics.messagesScroll <= metrics.messagesClient + 1
      && metrics.rootRight <= viewportNode.getBoundingClientRect().right + 1
      && metrics.cardRight <= viewport + 1
      && metrics.contentRight <= metrics.cardRight + 1
      && metrics.contentScroll <= metrics.contentClient + 1;
    document.getElementById('layout-result').textContent = (fits ? 'PASS ' : 'FAIL ') + JSON.stringify(metrics);
    }, 100);
  }, 100);
</script>`;

  fs.writeFileSync(htmlPath, html, 'utf8');
  try {
    const run = spawnSync(browser, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
      '--window-size=800,800', '--force-device-scale-factor=1',
      `--user-data-dir=${profile}`, '--virtual-time-budget=3000', '--dump-dom',
      pathToFileURL(htmlPath).href,
    ], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr || 'headless browser failed');
    const result = /<pre id="layout-result">([^<]+)<\/pre>/.exec(run.stdout);
    assert.ok(result, `layout result missing from browser output: ${run.stdout.slice(-500)}`);
    assert.match(result[1], /^PASS /, result[1]);
  } finally {
    fs.rmSync(htmlPath, { force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
