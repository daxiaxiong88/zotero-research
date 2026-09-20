const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const sites = [
  ['ChatGPT', 'chatgpt.com/c/one', i => `<article data-turn="user" data-turn-id="u${i}"><div data-message-author-role="user">问题 ${i}</div></article>`, '<div data-message-author-role="assistant">完整回答</div>'],
  ['Gemini', 'gemini.google.com/app/one', i => `<user-query id="u${i}"><div class="query-text">问题 ${i}</div></user-query>`, '<model-response>完整回答</model-response>'],
  ['DeepSeek', 'chat.deepseek.com/a/chat/s/one', i => `<div data-um-id="u${i}"><div class="ds-message">问题 ${i}</div></div>`, '<div class="ds-message">完整回答</div>'],
  ['Kimi', 'www.kimi.com/chat/one', i => `<div class="chat-content-item chat-content-item-user" data-message-id="u${i}"><div class="segment-user">问题 ${i}</div></div>`, '<div class="chat-content-item-assistant">完整回答</div>'],
  ['Kimi legacy', 'kimi.moonshot.cn/chat/one', i => `<div class="segment segment-user" id="u${i}">问题 ${i}</div>`, '<div class="segment-assistant">完整回答</div>'],
  ['Claude', 'claude.ai/chat/one', i => `<div data-user-message-bubble="true" data-message-id="u${i}">问题 ${i}</div>`, '<div class="font-claude-response">完整回答</div>'],
  ['AI Studio', 'aistudio.google.com/prompts/one', i => `<ms-chat-turn id="u${i}"><div data-turn-role="User">问题 ${i}</div></ms-chat-turn>`, '<ms-chat-turn><div data-turn-role="Model">完整回答</div></ms-chat-turn>'],
];

for (const [name, url, question, answer] of sites) {
  test(`${name}: navigation, stars, live additions and route changes leave the composer untouched`, async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>
      body { margin:0; font:16px sans-serif; } main { margin:60px 80px; height:500px; overflow:auto; }
      main > * { display:block; min-height:80px; margin:0; padding:12px; box-sizing:border-box; }
      main > .answer { min-height:170px; } form { position:fixed; bottom:0; left:100px; }
      </style><main>${Array.from({ length: 16 }, (_, i) => question(i + 1) + `<section class="answer">${answer}</section>`).join('')}</main>
      <form><div contenteditable="true" role="textbox">未发送草稿</div><button type="button" onclick="window.sends++">发送</button></form>` }));
    await page.addInitScript(() => {
      window.sends = 0; window.unsafeWindow = window;
      window.GM_info = { script: { version: 'test' } };
      window.GM_getValue = (key, fallback) => JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
      window.GM_setValue = (key, value) => localStorage.setItem(key, JSON.stringify(value));
      window.GM_addValueChangeListener = () => {};
      window.GM_registerMenuCommand = () => {};
      window.GM_notification = () => {};
      window.GM_xmlhttpRequest = () => ({ abort() {} });
    });
    await page.goto('https://' + url);
    await page.addScriptTag({ content: source('userscripts/zotero-research-webai.user.js') });
    const rail = page.locator('[data-zra-web-timeline]');
    const dots = rail.locator('[data-entry-id]');
    await expect(dots).toHaveCount(16);
    await dots.nth(8).hover();
    await expect(rail.getByRole('tooltip')).toContainText('问题 9');
    await dots.nth(8).click();
    await expect.poll(() => page.locator('main').evaluate(el => el.scrollTop)).toBe(2000);
    await expect(dots.nth(8)).toHaveAttribute('aria-current', 'step');
    await dots.nth(8).focus(); await page.keyboard.press('s');
    await expect(dots.nth(8)).toHaveAttribute('aria-pressed', 'true');
    await page.reload(); await page.addScriptTag({ content: source('userscripts/zotero-research-webai.user.js') });
    await expect(dots.nth(8)).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(html => document.querySelector('main').insertAdjacentHTML('beforeend', html), question(17));
    await expect(dots).toHaveCount(17);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(rail).toHaveAttribute('data-dark', 'true');
    await page.evaluate(html => { history.pushState({}, '', location.pathname.replace('one', 'two')); document.querySelector('main').innerHTML = html; }, question(1));
    await expect(dots).toHaveCount(1);
    await expect(dots.first()).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('textbox')).toHaveText('未发送草稿');
    expect(await page.evaluate(() => sends)).toBe(0);
    expect(errors).toEqual([]);
  });
}

test('Zotero narrow sidebar timeline stays left-centered beside the reading area without overflow or scroll reset', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setContent('<!doctype html><body style="margin:0"><div id="panel" style="width:100%;height:880px"></div></body>');
  await page.addStyleTag({ content: source('addon/content/panel.css') });
  for (const file of ['relay.js', 'timeline.js', 'updates.js', 'panel.js']) await page.addScriptTag({ content: source('addon/content/' + file) });
  await page.evaluate(() => {
    const messages = [];
    for (let i = 0; i < 40; i++) messages.push({ role: 'user', content: '问题 ' + (i + 1) }, { role: 'assistant', content: '解释公式的每个变量。\n'.repeat(25) });
    window.archive = { messages };
    window.panel = ZoteroResearchPanel.mount(document.querySelector('#panel'), {
      relay: { subscribe: fn => { window.progress = fn; return () => {}; }, state: () => ({ connected: true }), enqueueTask: () => 'pending' },
      loadChatSession: async () => archive, saveChatSession: async (_, value) => { window.archive = value; },
      retrieveEvidence: async () => [],
      checkUpdates: async () => ({ status: 'current' }),
    });
    panel.setContext({ item_key: 'T1', attachment_key: 'A1', title: 'SeisLM · 阅读记录', library_id: 1 });
  });
  const rail = page.getByTestId('conversation-timeline');
  const dots = rail.locator('[data-entry-id]');
  await expect(dots).toHaveCount(40);
  const scroller = page.getByTestId('webai-chat-messages');
  async function expectLeftReadingRail() {
    const reading = await scroller.boundingBox();
    const panelBox = await page.locator('.zrp-panel').boundingBox();
    const composer = await page.getByTestId('webai-chat-input').boundingBox();
    const railBox = await rail.boundingBox();
    const top = Math.max(0, panelBox.y, reading.y);
    const bottom = Math.min(page.viewportSize().height, panelBox.y + panelBox.height, reading.y + reading.height);
    expect(railBox.x).toBeGreaterThanOrEqual(panelBox.x);
    expect(railBox.x + railBox.width).toBeLessThanOrEqual((await page.locator('.zrp-chat-card').boundingBox()).x);
    expect(Math.abs(railBox.y + railBox.height / 2 - (top + bottom) / 2)).toBeLessThan(2);
    expect(railBox.height).toBeLessThanOrEqual(360);
    expect(railBox.y).toBeGreaterThanOrEqual(top);
    expect(railBox.y + railBox.height).toBeLessThanOrEqual(Math.min(bottom, composer.y));
  }
  await expectLeftReadingRail();
  const chatBox = await page.locator('.zrp-chat-card').boundingBox();
  const railBox = await rail.boundingBox();
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(chatBox.x);
  expect(await dots.first().evaluate(el => getComputedStyle(el, '::before').display)).toBe('none');
  await dots.nth(20).click();
  const position = await scroller.evaluate(el => el.scrollTop);
  expect(position).toBeGreaterThan(1000);
  await expect(dots.nth(20)).toHaveAttribute('aria-current', 'step');
  // Adding/sending a turn must not reset the location the user navigated to.
  await page.getByTestId('webai-chat-input').fill('补充问题');
  await page.getByTestId('webai-chat-send').click();
  await expect(dots).toHaveCount(41);
  expect(await scroller.evaluate(el => el.scrollTop)).toBe(position);
  await page.evaluate(() => progress({ type: 'answer', id: 'pending', text: '正在继续解释', done: false }));
  await page.waitForTimeout(200);
  expect(await scroller.evaluate(el => el.scrollTop)).toBe(position);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The timeline itself must be independently scrollable, not snap back to the active marker.
  await rail.locator('[data-track]').evaluate(el => { el.scrollTop = 0; });
  await page.waitForTimeout(80);
  expect(await rail.locator('[data-track]').evaluate(el => el.scrollTop)).toBe(0);
  await dots.first().hover();
  await expect(rail.getByRole('tooltip')).toContainText('问题 1');
  const preview = await rail.getByRole('tooltip').boundingBox();
  expect(preview.x).toBeGreaterThanOrEqual(railBox.x + railBox.width);
  expect(preview.x + preview.width).toBeLessThanOrEqual(360);
  await page.mouse.move(350, 0);
  await dots.nth(20).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('timeline-sidebar.png') });
  await page.locator('.zrp-panel').evaluate(el => { el.scrollTop = 120; });
  await page.waitForTimeout(100);
  await expectLeftReadingRail();
  await page.setViewportSize({ width: 300, height: 650 });
  await page.waitForTimeout(100);
  await expectLeftReadingRail();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await rail.getByRole('button', { name: '收起对话时间轴' }).click();
  await page.waitForTimeout(100);
  await expectLeftReadingRail();
  await expect(dots.first()).toBeHidden();
  await rail.getByRole('button', { name: '展开对话时间轴' }).click();
  await page.waitForTimeout(100);
  await expectLeftReadingRail();
  // A short history remains a compact cluster, not dots stretched along the whole side.
  await page.setViewportSize({ width: 360, height: 900 });
  await page.evaluate(() => {
    archive = { messages: [1, 2, 3].flatMap(i => [
      { role: 'user', content: '短对话 ' + i },
      { role: 'assistant', content: '这是一段有依据的回答。\n'.repeat(20) },
    ]) };
    panel.setContext({ item_key: 'T2', attachment_key: 'A2', title: '另一篇论文', library_id: 1 });
  });
  await expect(dots).toHaveCount(3);
  await expect.poll(async () => (await rail.boundingBox()).height).toBeLessThan(150);
  await expectLeftReadingRail();
  await page.locator('#panel').evaluate(el => { el.hidden = true; });
  await expect(rail).toBeHidden();
});
