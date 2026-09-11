/* TEST ONLY: exercised exclusively inside the guarded synthetic profile.
 * No model, browser page, network request, GPU parser, or Python bridge is
 * started. The current packaged production code is loaded into a Gecko
 * sandbox with cloned registries so the installed addon registration remains
 * untouched.
 */
async function runSyntheticNativeChecks(paper, pdf) {
  const id = 'zotero-research@local.invalid';
  const relayPath = '/zotero-research/relay';
  const stage = (nativeStep) => writeFixtureReport({ nativeStep });
  const check = (value, message) => {
    if (!value) throw new Error('Synthetic native check: ' + message);
  };
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const waitFor = async (read, message, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await sleep(100);
    }
    throw new Error('Timed out waiting for ' + message);
  };

  const scope = new Components.utils.Sandbox(
    Services.scriptSecurityManager.getSystemPrincipal(),
    {
      sandboxName: 'zotero-research-synthetic-native-checks',
      wantGlobalProperties: [
        'AbortController', 'ChromeUtils', 'DOMParser', 'fetch', 'TextDecoder', 'TextEncoder',
        'URL', 'XMLHttpRequest',
      ],
    },
  );
  Object.assign(scope, {
    Zotero,
    Services,
    IOUtils,
    PathUtils,
    Cc,
    Ci,
    setTimeout,
    clearTimeout,
  });
  scope.self = scope;

  let addon;
  let panel;
  let body;
  try {
    await stage('load current packaged production code');
    const bootstrapURI = String(await Zotero.Plugins.resolveURI(id, 'bootstrap.js'));
    const rootURI = bootstrapURI.endsWith('bootstrap.js')
      ? bootstrapURI.slice(0, -'bootstrap.js'.length)
      : String(await Zotero.Plugins.resolveURI(id, ''));
    for (const resource of [
      'content/native.js',
      'content/browser.js',
      'content/relay.js',
      'content/katex.min.js',
      'content/markdown.js',
      'content/panel.js',
      'bootstrap.js',
    ]) {
      const uri = await Zotero.Plugins.resolveURI(id, resource);
      Services.scriptloader.loadSubScript(uri, scope, 'UTF-8');
    }
    check(typeof scope.zraCreateAddon === 'function', 'current bootstrap loaded');
    check(typeof scope.ZoteroResearchNative?.createHighlightController === 'function',
      'current native adapter loaded');
    check(typeof scope.ZoteroResearchRelay?.createRelayStore === 'function',
      'current relay adapter loaded');
    check(typeof scope.ZoteroResearchPanel?.mount === 'function',
      'current sidebar adapter loaded');
    check(typeof scope.ZoteroResearchBrowser?.createLauncher === 'function',
      'packaged browser launcher loaded');
    check(typeof scope.ZoteroResearchMarkdown?.renderMarkdown === 'function',
      'current Markdown adapter loaded');
    check(typeof scope.AbortController === 'function', 'sandbox AbortController global');
    check(typeof scope.fetch === 'function', 'sandbox fetch global');
    check(typeof scope.TextDecoder === 'function', 'sandbox TextDecoder global');
    check(typeof scope.TextEncoder === 'function', 'sandbox TextEncoder global');

    const registrations = { sections: [], preferences: [], reader: null };
    const shadowReader = Object.create(Zotero.Reader);
    shadowReader.registerEventListener = (name, listener) => {
      registrations.reader = { name, listener };
    };
    shadowReader.unregisterEventListener = () => {};
    const shadowServer = Object.create(Zotero.Server);
    shadowServer.Endpoints = Object.create(null);
    const shadowZotero = Object.create(Zotero);
    shadowZotero.ItemPaneManager = {
      registerSection(options) {
        registrations.sections.push(options);
        return 'synthetic-section-id';
      },
      unregisterSection(idValue) {
        registrations.unregisteredSection = idValue;
      },
    };
    shadowZotero.PreferencePanes = {
      register: async (options) => {
        registrations.preferences.push(options);
        return 'synthetic-preference-id';
      },
      unregister(idValue) {
        registrations.unregisteredPreference = idValue;
      },
    };
    shadowZotero.Server = shadowServer;
    shadowZotero.Reader = shadowReader;
    shadowZotero.getMainWindows = () => [];
    scope.Zotero = shadowZotero;

    // Exercise Gecko loading, URL validation and native Chrome path lookup,
    // but intercept both process-launch boundaries: no user browser is opened.
    const browserCalls = [];
    const createLauncher = scope.ZoteroResearchBrowser.createLauncher;
    scope.ZoteroResearchBrowser.createLauncher = (adapter) => createLauncher({
      ...adapter,
      launch: (executable, args) => { browserCalls.push({ executable, args }); },
      openDefault: (url) => { browserCalls.push({ url }); },
    });

    const packagedMount = scope.ZoteroResearchPanel.mount;
    scope.ZoteroResearchPanel.mount = (target, adapter) => {
      registrations.adapter = adapter;
      panel = packagedMount(target, adapter);
      return panel;
    };
    addon = scope.zraCreateAddon({ id, rootURI, version: Zotero.version });
    await addon.start();
    check(registrations.sections.length === 1, 'current ItemPaneManager section registered in sandbox');
    const section = registrations.sections[0];
    check(section.pluginID === id && typeof section.onRender === 'function'
      && typeof section.onAsyncRender === 'function', 'current sidebar section lifecycle');
    check(registrations.preferences.length === 1, 'current preferences registration captured');
    check(registrations.reader?.name === 'renderTextSelectionPopup',
      'current reader selection hook captured');

    await stage('real Gecko DOM sidebar Markdown and MathML');
    // hiddenDOMWindow is unavailable on Windows Zotero. This is already a
    // disposable synthetic profile; use its real chrome document instead.
    const document = Zotero.getMainWindow().document;
    body = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    body.setAttribute('data-zra-synthetic-sidebar', 'true');
    const props = {
      doc: document,
      body,
      item: paper,
      tabType: 'library',
      refresh: () => {},
    };
    section.onInit(props);
    section.onRender(props);
    check(panel && registrations.adapter, 'production panel mounted with captured adapter');
    check(body.querySelector('[data-zrp-root="true"]'), 'real Gecko sidebar root mounted');
    await registrations.adapter.openWebAI('https://gemini.google.com/app/synthetic#zra-connect=1');
    check(browserCalls.length === 1, 'browser startup requested exactly once through the native adapter');
    if (browserCalls[0].args) {
      check(browserCalls[0].args[0] === '--disable-backgrounding-occluded-windows', 'only scoped occlusion switch used');
      check(browserCalls[0].args[1].includes('/app/synthetic#zra-connect=1'), 'conversation URL preserved');
    }
    const apiConfig = registrations.adapter.getAPIConfig();
    check(apiConfig && !apiConfig.baseUrl && !apiConfig.model && !apiConfig.apiKey,
      'isolated profile has no external model configuration');

    await registrations.adapter.clearChatSession(paper.key);
    await registrations.adapter.saveChatSession(paper.key, {
      title: paper.getField('title'),
      provider: 'gemini',
      aiUrl: '',
      messages: [
        {
          role: 'user', content: 'Synthetic question', sourceContext: '', evidence: [],
        },
        {
          role: 'assistant',
          content: 'Synthetic answer with inline $x^2$ and display $$\\frac{a}{b}$$.',
          sourceContext: '材料范围：合成 PDF',
          evidence: [{ page: 1, text: 'Synthetic evidence' }],
        },
      ],
    });
    // Let the real section lifecycle set context after the archive exists, so
    // its asynchronous restore path is the one being exercised.
    await section.onAsyncRender(props);
    const math = await waitFor(
      () => body.querySelector('[data-testid="webai-chat-message-1"] math'),
      'restored sidebar MathML',
    );
    check(math.namespaceURI === 'http://www.w3.org/1998/Math/MathML',
      'sidebar formula is native MathML');
    check(body.querySelector('[data-testid="webai-chat-message-1"]'),
      'sidebar restored saved chat message');

    const clearButton = body.querySelector('[data-zrp-action="webai-clear"]');
    check(clearButton, 'sidebar clear-chat action');
    clearButton.dispatchEvent(new document.defaultView.MouseEvent('click', {
      bubbles: true, button: 0, detail: 1,
    }));
    const profileDir = Zotero.Profile?.dir
      || Services.dirsvc.get('ProfD', Ci.nsIFile).path;
    const sessionPath = PathUtils.join(
      profileDir, 'zotero-research-sessions', paper.key + '.json',
    );
    await waitFor(async () => !(await IOUtils.exists(sessionPath)), 'chat archive clear');
    check(!body.querySelector('[data-testid="webai-chat-message-0"]'),
      'sidebar chat messages cleared');
    check(await registrations.adapter.loadChatSession(paper.key) === null,
      'cleared chat does not restore');
    await stage('chat save restore clear');

    await stage('Zotero PDF current-page and full-text extraction');
    await Zotero.Reader.open(pdf.id, { pageIndex: 0 });
    const currentPage = await waitFor(
      () => registrations.adapter.retrieveCurrentPageEvidence(pdf.key),
      'current reader page extraction',
      15000,
    );
    check(currentPage.page === 1 && currentPage.spans.some(
      (span) => String(span.text).includes('twelve percent'),
    ), 'current page evidence is physical page 1');
    const fullText = await registrations.adapter.retrieveOverviewEvidence(pdf.key);
    check(fullText.kind === 'full-text', 'full PDF text is labelled full-text');
    check(fullText.spans.some(
      (span) => span.page === 1 && String(span.text).includes('twelve percent'),
    ), 'full-text extraction contains page 1');
    check(fullText.spans.some(
      (span) => span.page === 2 && String(span.text).includes('twenty-four'),
    ), 'full-text extraction contains page 2');

    await stage('local relay connect poll update disconnect');
    const endpointConstructor = shadowServer.Endpoints[relayPath];
    check(typeof endpointConstructor === 'function', 'relay endpoint registered locally');
    const endpoint = new endpointConstructor();
    const relayRequest = async (data) => {
      const response = await endpoint.init({ headers: {}, data });
      check(response[0] === 200, 'relay response status');
      return JSON.parse(response[2]);
    };
    const sessionSecret = 'synthetic-native-session-1234';
    const connected = await relayRequest({
      action: 'connect', sessionSecret, ai: 'synthetic-no-network', url: 'https://synthetic.invalid/',
    });
    check(connected.status === 'connected', 'relay connect');
    let abandonedReply;
    const abandoned = relayRequest({ action: 'poll', sessionSecret })
      .then(result => { abandonedReply = result; });
    await relayRequest({ action: 'connect', sessionSecret, ai: 'synthetic-no-network' });
    await waitFor(() => abandonedReply, 'same-page reconnect retires old poll', 1000);
    check(!abandonedReply.task, 'abandoned poll must not claim a task');
    await abandoned;
    let retriedReply;
    const retried = relayRequest({ action: 'poll', sessionSecret })
      .then(result => { retriedReply = result; });
    const currentPoll = relayRequest({ action: 'poll', sessionSecret });
    await waitFor(() => retriedReply, 'poll retry retires prior waiter', 1000);
    check(!retriedReply.task, 'superseded poll must not claim a task');
    await retried;
    const taskID = registrations.adapter.relay.enqueueTask({
      messages: [{ text: 'synthetic relay request; no web page is opened' }],
      meta: { source: 'native-smoke' },
    });
    const polled = await currentPoll;
    check(polled.task?.id === taskID, 'relay poll delivered queued task');
    const updated = await relayRequest({
      action: 'update', sessionSecret, id: taskID,
      text: 'synthetic relay response', isDone: true,
    });
    check(updated.ok === true, 'relay update');
    const disconnected = await relayRequest({ action: 'disconnect', sessionSecret });
    check(disconnected.status === 'disconnected', 'relay disconnect');

    await stage('compact chat prompt and explicit full-paper material');
    await relayRequest({ action: 'connect', sessionSecret, ai: 'Gemini' });
    const ordinaryPoll = relayRequest({ action: 'poll', sessionSecret });
    const input = body.querySelector('[data-testid="webai-chat-input"]');
    input.value = 'Explain that briefly.';
    body.querySelector('[data-testid="webai-chat-send"]').click();
    const ordinary = await ordinaryPoll;
    const ordinaryText = ordinary.task?.messages[0]?.text || '';
    check(ordinaryText.includes('Explain that briefly.') && ordinaryText.length < 250,
      'ordinary outbound prompt is compact');
    check(!/参考材料|任务要求|文献标识|twelve percent/.test(ordinaryText),
      'ordinary chat does not append PDF excerpts or repeated instructions');
    await relayRequest({ action: 'update', sessionSecret, id: ordinary.task.id,
      text: 'A synthetic short answer.', isDone: true });
    const overviewPoll = relayRequest({ action: 'poll', sessionSecret });
    body.querySelector('[data-testid="quick-full-summary"]').click();
    const overviewTask = await overviewPoll;
    const overviewText = overviewTask.task?.messages[0]?.text || '';
    check(overviewText.includes('twelve percent') && overviewText.includes('twenty-four'),
      'explicit full summary still receives both PDF pages');
    await relayRequest({ action: 'update', sessionSecret, id: overviewTask.task.id,
      text: 'A synthetic overview.', isDone: true });
    await relayRequest({ action: 'disconnect', sessionSecret });

    await stage('packaged relay recovers late text without resending the prompt');
    let relayClock = 0;
    const recoveryStore = scope.ZoteroResearchRelay.createRelayStore({
      now: () => relayClock, setTimeout: () => 0, clearTimeout: () => {},
    });
    try {
      recoveryStore.connect({ sessionSecret, ai: 'Gemini' });
      const lateID = recoveryStore.enqueueTask({ messages: [{ text: 'synthetic late-answer test' }] });
      await recoveryStore.poll({ sessionSecret }, 0);
      recoveryStore.update({ sessionSecret, id: lateID, text: 'prefix' });
      relayClock = 91000;
      await recoveryStore.poll({ sessionSecret }, 0);
      check(recoveryStore.update({ sessionSecret, id: lateID, heartbeat: true }).recoverable,
        'timed-out latest task remains eligible for text-only recovery');
      recoveryStore.update({ sessionSecret, id: lateID, text: 'prefix and full answer', isDone: true });
      check(recoveryStore._tasks.get(lateID).text === 'prefix and full answer'
        && recoveryStore._tasks.get(lateID).error === '', 'late full answer replaces timed-out prefix');
      check(!(await recoveryStore.poll({ sessionSecret }, 0)).task, 'recovery never queues the prompt again');
    } finally { recoveryStore.destroy(); }

    return {
      status: 'passed',
      production: 'current packaged XPI loaded in Gecko sandbox; original registries untouched',
      section: 'Zotero 10 ItemPaneManager section captured and rendered',
      sidebar: 'real Gecko DOM panel restored Markdown with native MathML',
      pdf: 'current physical page 1 and full two-page text extracted by Zotero.PDFWorker',
      chat: 'save, restore, and clear archive verified in isolated profile',
      prompt: 'ordinary chat is compact without excerpts; explicit full summary contains both PDF pages',
      relay: 'local connect/reconnect/poll-retry/update/disconnect verified; abandoned polls cannot claim tasks; no web request',
      lateRecovery: 'packaged relay replaces timed-out prefix with full answer; no prompt resend',
      browser: 'packaged launcher validates URL and locates Chrome in Gecko; OS launch intercepted, no user browser opened',
      modelExecution: 'not configured or invoked; no GPU/Python bridge',
    };
  } finally {
    try { await addon?.stop(); } catch (_) {}
    try { body?.remove(); } catch (_) {}
    try { Components.utils.nukeSandbox(scope); } catch (_) {}
  }
}
