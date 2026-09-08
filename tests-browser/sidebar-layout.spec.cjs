const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.join(__dirname, '..');

function asset(relativePath) {
  return pathToFileURL(path.join(REPO, relativePath)).href;
}

test('long MathML stays inside a shrinkable Zotero section', async ({ page }) => {
  const formula = String.raw`$$L(a_t, q_t, \mathcal{N}_t) = -\log \frac{\exp[sim(a_t, q_t)/\kappa]}{\exp[sim(a_t, q_t)/\kappa] + \sum_{n \in \mathcal{N}_t} \exp[sim(a_t, n)/\kappa]}$$`;
  const answer = [
    formula,
    '',
    '- **作者在此处梳理的技术演进**：作者按时间线梳理监督模型发展脉络。',
    '- **卷积神经网络（ConvNets）**：用于震相分类、检测和定位。',
  ].join('\n');
  const htmlPath = path.join(os.tmpdir(), `zrp-gecko-layout-${process.pid}.html`);
  const html = `<!doctype html>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="${asset('addon/content/panel.css')}">
    <style>
      html, body { width: 800px; margin: 0; overflow-x: hidden; }
      #zotero-pane-viewport { display: flex; width: 700px; overflow: hidden; }
      item-pane-custom-section,
      collapsible-section,
      #zotero-pane-host { display: flex; flex: 1 1 auto; flex-direction: column; }
    </style>
    <div id="zotero-pane-viewport">
      <item-pane-custom-section><collapsible-section>
        <div id="zotero-pane-host"></div>
      </collapsible-section></item-pane-custom-section>
    </div>
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
        loadChatSession: async () => ({
          messages: [{ role: 'assistant', content: ${JSON.stringify(answer)} }]
        }),
        retrieveEvidence: async () => [],
        openSettings() {}, openExternal() {}, copyText() {}
      };
      const host = document.getElementById('zotero-pane-host');
      const panel = ZoteroResearchPanel.mount(host, adapter);
      panel.setContext({
        item_key: 'LAYOUT01', attachment_key: 'PDF00001',
        library_id: 1, title: 'Layout fixture'
      });
    </script>`;

  fs.writeFileSync(htmlPath, html, 'utf8');
  try {
    await page.goto(pathToFileURL(htmlPath).href);
    await page.locator('.zrp-message').waitFor();
    await page.evaluate(() => {
      document.getElementById('zotero-pane-viewport').style.width = '360px';
    });
    await page.waitForTimeout(100);

    const metrics = await page.evaluate(() => {
      const viewport = document.getElementById('zotero-pane-viewport');
      const host = document.getElementById('zotero-pane-host');
      const root = document.querySelector('.zrp-panel');
      const messages = document.querySelector('.zrp-chat-messages');
      const content = document.querySelector('.zrp-message-content');
      const math = document.querySelector('.zrp-math-rendered.zrp-math-block');
      return {
        viewportClient: viewport.clientWidth,
        viewportScroll: viewport.scrollWidth,
        hostClient: host.clientWidth,
        hostScroll: host.scrollWidth,
        rootClient: root.clientWidth,
        rootScroll: root.scrollWidth,
        messagesClient: messages.clientWidth,
        messagesScroll: messages.scrollWidth,
        contentClient: content.clientWidth,
        contentScroll: content.scrollWidth,
        mathClient: math.clientWidth,
        mathScroll: math.scrollWidth,
      };
    });

    expect(metrics.hostClient).toBeLessThanOrEqual(metrics.viewportClient + 1);
    expect(metrics.viewportScroll).toBeLessThanOrEqual(metrics.viewportClient + 1);
    expect(metrics.hostScroll).toBeLessThanOrEqual(metrics.viewportClient + 1);
    expect(metrics.rootScroll).toBeLessThanOrEqual(metrics.rootClient + 1);
    expect(metrics.messagesScroll).toBeLessThanOrEqual(metrics.messagesClient + 1);
    expect(metrics.contentScroll).toBeLessThanOrEqual(metrics.contentClient + 1);
    expect(metrics.mathScroll).toBeGreaterThan(metrics.mathClient);
  } finally {
    fs.rmSync(htmlPath, { force: true });
  }
});
