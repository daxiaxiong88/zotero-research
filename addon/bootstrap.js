/* Zotero 10 native integration. Library writes stay in supported Zotero APIs. */
'use strict';

var ZoteroResearchAddon = null;
const ZRA_TOPIC = 'zotero-research:reconnect';
const ZRA_HTML = 'http://www.w3.org/1999/xhtml';

function zraHash(text) {
  const hash = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
  const bytes = new TextEncoder().encode(text);
  hash.init(hash.SHA256);
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function zraRequest(url, options) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest({ mozAnon: true, mozSystem: true });
    xhr.open('POST', url, true);
    xhr.mozBackgroundRequest = true;
    xhr.timeout = options.timeout;
    xhr.responseType = 'json';
    for (const [key, value] of Object.entries(options.headers)) xhr.setRequestHeader(key, value);
    // Refuse even a loopback redirect: questions and tokens never follow a Location header.
    const previous = xhr.channel.notificationCallbacks;
    xhr.channel.notificationCallbacks = {
      QueryInterface: ChromeUtils.generateQI(['nsIInterfaceRequestor', 'nsIChannelEventSink']),
      getInterface(iid) {
        if (iid.equals(Ci.nsIChannelEventSink)) return this;
        if (previous) return previous.getInterface(iid);
        throw Components.results.NS_NOINTERFACE;
      },
      asyncOnChannelRedirect(_old, _next, _flags, callback) {
        callback.onRedirectVerifyCallback(Components.results.NS_ERROR_ABORT);
      },
    };
    xhr.onload = () => resolve({ status: xhr.status, data: xhr.response });
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new Error('Private request failed'));
    xhr.onprogress = (event) => { if (event.loaded > 4_000_000) xhr.abort(); };
    xhr.send(JSON.stringify(options.body));
  });
}

function zraCreateAddon(data) {
  const records = new Map();
  const documents = new Set();
  const windowListeners = new Map();
  const selections = new Map();
  let bridge = null;
  let highlights = null;
  let sectionID = null;
  let preferenceID = null;
  let config = null;
  let alive = true;
  let pendingRPC = 0;
  let focusNext = null;

  const serverID = () => {
    try { return Zotero.Server.LocalAPI.getServerID(); } catch (_) { return null; }
  };
  const preference = (key) => Zotero.Prefs.get('researchAssistant.' + key) || '';
  const alert = (message) => Services.prompt.alert(Zotero.getMainWindow(), '科研助手', message);

  async function launch() {
    const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
    if (!config.bridgeExecutable || !config.workingDirectory
      || !PathUtils.isAbsolute(config.bridgeExecutable) || !PathUtils.isAbsolute(config.workingDirectory)
      || /^(\\\\|\/\/)/.test(config.bridgeExecutable)) {
      throw new Error('Build the local package with an absolute bridge executable and working directory');
    }
    const environment = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    for (const [setting, variable] of Object.entries({
      localModelName: 'ZRM_LOCAL_MODEL_NAME', localModelBaseURL: 'ZRM_LOCAL_MODEL_BASE_URL',
      mineruModelPath: 'ZRM_MINERU_MODEL_PATH', mineruExecutable: 'ZRM_MINERU_EXECUTABLE',
    })) {
      const value = preference(setting);
      if (value) environment[variable] = value;
    }
    const process = await Subprocess.call({
      command: config.bridgeExecutable, arguments: [], workdir: config.workingDirectory,
      environment, environmentAppend: true, stderr: 'pipe',
    });
    // Discard stderr without recording potential configuration secrets or document text.
    (async () => { try { while (await process.stderr.readString()) {} } catch (_) {} })();
    let stopped = false;
    return {
      read: () => process.stdout.readString(),
      async stop() {
        if (stopped) return;
        stopped = true;
        try { await process.stdin.close(); } catch (_) {}
        let timer;
        await Promise.race([
          process.wait(),
          new Promise((resolve) => { timer = setTimeout(resolve, 1500); }),
        ]);
        clearTimeout(timer);
        if (process.exitCode === null) await process.kill(0);
      },
    };
  }

  async function rpc(method, params) {
    if (!alive || !bridge) throw new Error('科研助手已关闭。');
    pendingRPC += 1;
    try { return await bridge.rpc(method, params); } finally { pendingRPC -= 1; }
  }

  async function attachment(key) {
    const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
    if (!item || !item.isAttachment() || !item.isFileAttachment()
      || item.attachmentContentType !== 'application/pdf' || item.deleted) {
      throw new Error('该附件不是可读取的个人库 PDF。');
    }
    const path = await item.getFilePathAsync();
    if (!path || /^(\\\\|\/\/)/.test(path)) throw new Error('PDF 未下载到本机，或位于网络共享目录。');
    const stat = await IOUtils.stat(path);
    if (!Number.isFinite(stat.size) || !Number.isFinite(stat.lastModified)) throw new Error('无法核实 PDF 文件状态。');
    const parent = item.parentID ? Zotero.Items.get(item.parentID) : null;
    const library = Zotero.Libraries.get(item.libraryID);
    return {
      item, key: item.key, id: item.id, libraryID: item.libraryID,
      parentKey: parent?.key || null, editable: library.editable === true,
      isPersonal: item.libraryID === Zotero.Libraries.userLibraryID, isPDF: true,
      stamp: zraHash(JSON.stringify([path, stat.size, stat.lastModified])),
    };
  }

  function makeControllers() {
    bridge = ZoteroResearchBridge.createBridgeClient({ launch, request: zraRequest, serverID, setTimeout, clearTimeout });
    highlights = ZoteroResearchNative.createHighlightController({
      serverID, attachment, digest: async (text) => zraHash(text),
      token: () => Services.uuid.generateUUID().toString(),
      annotationKey: () => Zotero.DataObjectUtilities.generateKey(),
      locate: (params) => rpc('locate', params),
      async save(info, json) {
        const queue = new Zotero.Notifier.Queue();
        let saved;
        try {
          saved = await Zotero.Annotations.saveFromJSON(info.item, json, { notifierQueue: queue });
        } finally {
          await Zotero.Notifier.commit(queue);
        }
        const win = Zotero.getMainWindow();
        const reader = win && Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
        if (reader?.itemID === info.id) await reader.setAnnotations([saved]);
        return saved;
      },
    });
  }

  async function navigate(key, page) {
    if (!Number.isInteger(page) || page < 1) throw new Error('PDF 页码无效。');
    const info = await attachment(key);
    await Zotero.Reader.open(info.id, { pageIndex: page - 1 });
  }

  function addDocument(doc) {
    if (documents.has(doc)) return;
    doc.defaultView.MozXULElement.insertFTLIfNeeded('zotero-research.ftl');
    const link = doc.createElementNS(ZRA_HTML, 'link');
    link.id = 'zotero-research-styles';
    link.rel = 'stylesheet';
    link.href = data.rootURI + 'content/panel.css';
    doc.documentElement.appendChild(link);
    documents.add(doc);
  }

  function mount(props) {
    addDocument(props.doc);
    let record = records.get(props.body);
    if (!record) {
      record = { body: props.body, panel: null, context: null, generation: 0, refresh: props.refresh };
      records.set(props.body, record);
    }
    if (!record.panel) {
      record.panel = ZoteroResearchPanel.mount(props.body, {
        rpc, navigate,
        prepareHighlight: (args) => highlights.prepare(args),
        commitHighlight: async (preview) => {
          pendingRPC += 1;
          try { return await highlights.commit(preview, true); } finally { pendingRPC -= 1; }
        },
        openSettings: () => Zotero.Utilities.Internal.openPreferences(preferenceID),
      });
    }
    if (record.itemID !== props.item?.id) {
      record.itemID = props.item?.id;
      record.generation += 1;
      record.context = null;
      record.panel.setContext(null);
    }
    return record;
  }

  async function resolveContext(item, doc, tabType) {
    if (!item || item.libraryID !== Zotero.Libraries.userLibraryID || item.deleted) return null;
    let pdf = item.isAttachment?.() ? item : null;
    const parent = item.parentID ? Zotero.Items.get(item.parentID) : item;
    if (!parent?.isRegularItem?.()) return null;
    if (tabType === 'reader') {
      const reader = Zotero.Reader.getByTabID(doc.defaultView.Zotero_Tabs?.selectedID);
      const opened = reader && Zotero.Items.get(reader.itemID);
      if (opened?.parentID === parent.id) pdf = opened;
    }
    if (!pdf || pdf.attachmentContentType !== 'application/pdf') {
      pdf = Zotero.Items.get(parent.getAttachments()).find((child) => child.attachmentContentType === 'application/pdf' && !child.deleted);
    }
    if (!pdf) return null;
    return { item_key: parent.key, title: parent.getField('title'), attachment_key: pdf.key, library_id: parent.libraryID };
  }

  async function renderAsync(props) {
    const record = records.get(props.body);
    if (!record?.panel) return;
    const generation = record.generation;
    const context = await resolveContext(props.item, props.doc, props.tabType);
    if (!alive || !records.has(props.body) || record.generation !== generation) return;
    if (JSON.stringify(context) !== JSON.stringify(record.context)) {
      record.context = context;
      record.panel.setContext(context);
    }
    if (context && selections.has(context.attachment_key)) record.panel.setSelection(selections.get(context.attachment_key));
    if (context && focusNext === context.attachment_key) {
      focusNext = null;
      record.panel.focusQuestion();
    }
  }

  function reveal(key) {
    const win = Zotero.getMainWindow();
    if (!win) throw new Error('请先打开 Zotero 主窗口。');
    focusNext = key;
    const inReader = win.Zotero_Tabs.selectedID !== 'zotero-pane';
    if (inReader) win.ZoteroContextPane.collapsed = false;
    const sidenav = win.document.getElementById(inReader ? 'zotero-context-pane-sidenav' : 'zotero-view-item-sidenav');
    const button = sidenav && Array.from(sidenav.querySelectorAll('[data-pane]')).find((node) => node.dataset.pane === sectionID);
    if (button) button.dispatchEvent(new win.MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
    for (const record of records.values()) {
      if (record.context?.attachment_key === key) {
        record.panel.setSelection(selections.get(key) || null);
        record.panel.focusQuestion();
      }
    }
  }

  const selectionListener = ({ reader, doc, params, append }) => {
    if (!params.annotation?.text || !params.annotation?.position?.rects) return;
    const source = JSON.parse(JSON.stringify(params.annotation));
    const button = doc.createElementNS(ZRA_HTML, 'button');
    button.type = 'button';
    button.textContent = '发送到科研助手';
    button.setAttribute('title', '仅在本机保留选文；分析需要在侧边栏手动启动');
    button.style.cssText = 'margin:4px;padding:5px 9px;border:1px solid #9aa9be;border-radius:4px;background:Canvas;color:CanvasText;cursor:pointer;';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const item = Zotero.Items.get(reader.itemID);
        if (item.libraryID !== Zotero.Libraries.userLibraryID) throw new Error('当前只支持个人文献库。');
        const selected = await highlights.captureSelection(item.key, source);
        if (!alive) return;
        if (selections.size >= 16) selections.delete(selections.keys().next().value);
        selections.set(item.key, selected);
        if (reader.tabID) Zotero.getMainWindow().Zotero_Tabs.select(reader.tabID);
        reveal(item.key);
        button.textContent = '已送入右侧科研助手';
      } catch (_) {
        button.textContent = '选文不可用，请在主窗口的个人库 PDF 中重试';
        button.disabled = false;
      }
    });
    append(button); // Reader requires synchronous append; only the click work is asynchronous.
  };

  const reconnectObserver = { observe: async () => {
    if (!alive) return;
    if (pendingRPC) {
      alert('仍有处理任务。设置已保存，请在任务结束后再点击重新连接；当前连接未中断。');
      return;
    }
    await bridge.close();
    highlights.destroy();
    selections.clear();
    makeControllers();
    for (const record of records.values()) {
      record.panel?.destroy();
      record.panel = null;
      record.context = null;
      record.generation += 1;
      record.refresh?.();
    }
  } };

  return {
    async start() {
      config = JSON.parse(await Zotero.File.getContentsAsync(data.rootURI + 'config.json'));
      makeControllers();
      for (const win of Zotero.getMainWindows()) this.addWindow(win);
      sectionID = Zotero.ItemPaneManager.registerSection({
        paneID: 'research-assistant', pluginID: data.id,
        header: { l10nID: 'zotero-research-pane-header', icon: data.rootURI + 'content/icon.svg' },
        sidenav: { l10nID: 'zotero-research-pane-sidenav', icon: data.rootURI + 'content/icon.svg' },
        onInit: (props) => {
          addDocument(props.doc);
          records.set(props.body, { body: props.body, panel: null, context: null, generation: 0, refresh: props.refresh });
        },
        onItemChange: ({ item, setEnabled }) => setEnabled(!!item && item.libraryID === Zotero.Libraries.userLibraryID && !item.deleted),
        onRender: (props) => { mount(props); },
        onAsyncRender: renderAsync,
        onDestroy: ({ body }) => { records.get(body)?.panel?.destroy(); records.delete(body); },
      });
      if (!sectionID) throw new Error('无法注册 Zotero 科研助手侧边栏。');
      preferenceID = await Zotero.PreferencePanes.register({
        pluginID: data.id, label: '科研助手', src: 'content/preferences.xhtml',
        scripts: ['content/preferences.js'], stylesheets: ['content/panel.css'], image: 'content/icon.svg',
      });
      Zotero.Reader.registerEventListener('renderTextSelectionPopup', selectionListener, data.id);
      Services.obs.addObserver(reconnectObserver, ZRA_TOPIC);
    },
    addWindow(win) {
      if (!alive || windowListeners.has(win)) return;
      addDocument(win.document);
      const listener = (event) => {
        if (event.ctrlKey && event.altKey && event.code === 'KeyR') {
          const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
          if (reader) { event.preventDefault(); reveal(Zotero.Items.get(reader.itemID).key); }
        }
      };
      win.addEventListener('keydown', listener);
      windowListeners.set(win, listener);
    },
    removeWindow(win) {
      const listener = windowListeners.get(win);
      if (listener) win.removeEventListener('keydown', listener);
      windowListeners.delete(win);
      for (const [body, record] of records) {
        if (body.ownerDocument === win.document) { record.panel?.destroy(); records.delete(body); }
      }
      documents.delete(win.document);
    },
    async stop() {
      alive = false;
      Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', selectionListener);
      try { Services.obs.removeObserver(reconnectObserver, ZRA_TOPIC); } catch (_) {}
      for (const record of records.values()) record.panel?.destroy();
      records.clear();
      if (sectionID) Zotero.ItemPaneManager.unregisterSection(sectionID);
      if (preferenceID) Zotero.PreferencePanes.unregister(preferenceID);
      for (const doc of documents) {
        doc.getElementById('zotero-research-styles')?.remove();
        doc.querySelector('link[href="zotero-research.ftl"]')?.remove();
      }
      for (const win of Array.from(windowListeners.keys())) this.removeWindow(win);
      documents.clear();
      selections.clear();
      highlights?.destroy();
      await bridge?.close();
    },
  };
}

async function startup(data, _reason) {
  for (const name of ['native.js', 'bridge-client.js', 'panel.js']) {
    Services.scriptloader.loadSubScript(data.rootURI + 'content/' + name, globalThis, 'UTF-8');
  }
  ZoteroResearchAddon = zraCreateAddon(data);
  try { await ZoteroResearchAddon.start(); }
  catch (error) { await ZoteroResearchAddon.stop(); ZoteroResearchAddon = null; throw error; }
}

async function shutdown(_data, _reason) {
  await ZoteroResearchAddon?.stop();
  ZoteroResearchAddon = null;
}
function onMainWindowLoad({ window }) { ZoteroResearchAddon?.addWindow(window); }
function onMainWindowUnload({ window }) { ZoteroResearchAddon?.removeWindow(window); }
function install() {}
function uninstall() {}
