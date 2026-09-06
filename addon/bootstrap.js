/* Zotero 10 native integration. The panel, evidence and web-AI relay live in
 * this plugin process; the userscript talks to Zotero's own local endpoint. */
'use strict';

var ZoteroResearchAddon = null;
const ZRA_TOPIC = 'zotero-research:reconnect';
const ZRA_HTML = 'http://www.w3.org/1999/xhtml';
const RELAY_ENDPOINT_PATH = '/zotero-research/relay';

function zraHash(text) {
  const hash = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
  const bytes = new TextEncoder().encode(text);
  hash.init(hash.SHA256);
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function zraCreateAddon(data) {
  const records = new Map();
  const documents = new Set();
  const windowListeners = new Map();
  const selections = new Map();
  let highlights = null;
  let sectionID = null;
  let preferenceID = null;
  let relayStore = null;
  let alive = true;
  let focusNext = null;

  const serverID = () => {
    try { return Zotero.Server.LocalAPI.getServerID(); } catch (_) { return null; }
  };
  const preference = (key) => Zotero.Prefs.get('researchAssistant.' + key) || '';
  const alert = (message) => Services.prompt.alert(Zotero.getMainWindow(), '科研助手', message);

  async function attachment(key) {
    const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
    if (!item || !item.isAttachment() || !item.isFileAttachment()
      || item.attachmentContentType !== 'application/pdf' || item.deleted) {
      throw new Error('该附件不是可读取的本地 PDF。');
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
      isPDF: true,
      stamp: zraHash(JSON.stringify([path, stat.size, stat.lastModified])),
    };
  }

  // ---------------------------------------------------------------------------
  // Per-paper rolling chat sessions, persisted as JSON in the profile dir.
  // ---------------------------------------------------------------------------

  function sessionsDirectory() {
    const base = Zotero.Profile?.dir
      || Services.dirsvc.get('ProfD', Ci.nsIFile).path;
    const dir = PathUtils.join(base, 'zotero-research-sessions');
    return dir;
  }

  async function ensureSessionsDirectory() {
    const dir = sessionsDirectory();
    if (!(await IOUtils.exists(dir))) await IOUtils.makeDirectory(dir, { createAncestors: true });
    return dir;
  }

  async function loadChatSession(itemKey) {
    try {
      const path = PathUtils.join(sessionsDirectory(), itemKey + '.json');
      if (!(await IOUtils.exists(path))) return null;
      const raw = await Zotero.File.getContentsAsync(path);
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.messages)) return null;
      return data;
    } catch (error) {
      Zotero.logError(error);
      return null;
    }
  }

  async function saveChatSession(itemKey, session) {
    try {
      await ensureSessionsDirectory();
      const path = PathUtils.join(sessionsDirectory(), itemKey + '.json');
      const payload = {
        itemKey,
        title: String(session.title || ''),
        provider: String(session.provider || ''),
        aiUrl: String(session.aiUrl || ''),
        updatedAt: new Date().toISOString(),
        // Bound the rolling session so a long history cannot grow the file forever.
        messages: (session.messages || []).slice(-500),
      };
      await Zotero.File.putContentsAsync(path, JSON.stringify(payload));
      return true;
    } catch (error) {
      Zotero.logError(error);
      return false;
    }
  }

  async function clearChatSession(itemKey) {
    try {
      const path = PathUtils.join(sessionsDirectory(), itemKey + '.json');
      if (await IOUtils.exists(path)) await IOUtils.remove(path);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Create a child note from markdown. Uses Better Notes' converter when
   * installed (its markdown flavor understands [[note links]], [@citations]
   * and ==highlights==), otherwise falls back to this plugin's own renderer.
   */
  async function createChildNote(itemKey, title, markdown) {
    const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, itemKey);
    if (!item) throw new Error('找不到当前文献条目。');
    let html = '';
    const betterNotes = Zotero.BetterNotes;
    const converter = betterNotes?.api?.convert?.md2html;
    if (typeof converter === 'function') {
      html = await converter(markdown);
    } else {
      // Fallback: build the note HTML with our own safe renderer.
      const doc = Zotero.getMainWindow().document;
      const container = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      container.appendChild(ZoteroResearchMarkdown.renderMarkdown(doc, markdown));
      html = container.innerHTML;
    }
    const note = new Zotero.Item('note');
    note.libraryID = item.libraryID;
    note.parentID = item.id;
    const heading = '<h1>' + title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]) + '</h1>';
    note.setNote(heading + html);
    note.addTag('zotero-research');
    await note.saveTx();
    return { key: note.key, id: note.id };
  }

  function getFontSize() {
    return Zotero.Prefs.get('researchAssistant.uiFontSize') || 'm';
  }

  function setFontSize(size) {
    Zotero.Prefs.set('researchAssistant.uiFontSize', size);
  }

  /** Base64 of the attachment file for direct-API document blocks. */
  async function getAttachmentBase64(attachmentKey) {
    const info = await attachment(attachmentKey);
    const path = await info.item.getFilePathAsync();
    const bytes = await IOUtils.read(path);
    let binary = '';
    const CHUNK = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      binary += String.fromCharCode.apply(
        null, bytes.subarray(offset, offset + CHUNK),
      );
    }
    return btoa(binary);
  }

  function getAttachmentMediaType(attachmentKey) {
    return 'application/pdf';
  }

  function getAPIConfig() {
    const protocol = Zotero.Prefs.get('researchAssistant.apiProtocol') || 'auto';
    const baseUrl = (Zotero.Prefs.get('researchAssistant.apiBaseUrl') || '').trim();
    const model = (Zotero.Prefs.get('researchAssistant.apiModel') || '').trim();
    const apiKey = (Zotero.Prefs.get('researchAssistant.apiKey') || '').trim();
    const resolved = protocol === 'anthropic' || protocol === 'openai'
      ? protocol
      : (/\/anthropic/i.test(baseUrl) ? 'anthropic' : 'openai');
    return { protocol: resolved, baseUrl, model, apiKey };
  }

  async function callModelAPI({ messages, onDelta, attachment, images, signal }) {
    const config = getAPIConfig();
    if (!config.baseUrl || !config.model) {
      throw new Error('API 未配置：请在插件设置中填写，或从 CC Switch 导入。');
    }
    if (attachment && config.protocol !== 'anthropic') {
      throw new Error('附带全文 PDF 目前仅支持 Anthropic 兼容协议。');
    }
    const emit = (delta) => { if (typeof onDelta === 'function') onDelta(delta); };
    if (config.protocol === 'anthropic') {
      return callAnthropicAPI(config, messages, emit, attachment || null, signal, images || []);
    }
    return callOpenAIAPI(config, messages, emit, signal, images || []);
  }

  async function readSSEStream(response, handleEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, split).replace(/\r$/, '');
        buffer = buffer.slice(split + 1);
        if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
      }
    }
    const tail = decoder.decode();
    if (tail.trim().startsWith('data:')) handleEvent(tail.trim().slice(5).trim());
  }

  async function callAnthropicAPI(config, messages, emit, attachment, signal, images = []) {
    const base = config.baseUrl.replace(/\/+$/, '');
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      // Sending both is harmless and works with either gateway.
      Authorization: 'Bearer ' + config.apiKey,
      'x-api-key': config.apiKey,
    };
    let payloadMessages = messages;
    if ((attachment || images.length) && messages.length) {
      // Anthropic document/image blocks ride on the final user turn.
      const last = messages[messages.length - 1];
      const blocks = [];
      if (attachment) {
        blocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: attachment.mediaType || 'application/pdf',
            data: attachment.base64,
          },
        });
      }
      for (const image of images) {
        const comma = String(image.dataUrl || '').indexOf(',');
        if (comma < 0) continue;
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mediaType || 'image/png',
            data: image.dataUrl.slice(comma + 1),
          },
        });
      }
      payloadMessages = [
        ...messages.slice(0, -1),
        {
          role: 'user',
          content: [...blocks, { type: 'text', text: String(last.content || '') }],
        },
      ];
    }
    const response = await fetch(base + '/v1/messages', {
      method: 'POST', headers, signal,
      body: JSON.stringify({
        model: config.model, max_tokens: 16000, stream: true, messages: payloadMessages,
      }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error('Anthropic API HTTP ' + response.status + (detail ? '：' + detail.slice(0, 300) : ''));
    }
    let thinking = '';
    let text = '';
    await readSSEStream(response, (payload) => {
      if (!payload || payload === '[DONE]') return;
      let data;
      try { data = JSON.parse(payload); } catch (_) { return; }
      if (data.type === 'content_block_delta') {
        if (typeof data.delta?.thinking === 'string') {
          thinking += data.delta.thinking;
          emit({ type: 'thinking', text: data.delta.thinking });
        } else if (typeof data.delta?.text === 'string') {
          text += data.delta.text;
          emit({ type: 'text', text: data.delta.text });
        }
      } else if (data.type === 'error') {
        throw new Error('Anthropic API 错误：' + String(data.error?.message || '').slice(0, 300));
      }
    });
    return { thinking, text };
  }

  async function callOpenAIAPI(config, messages, emit, signal, images = []) {
    let base = config.baseUrl.replace(/\/+$/, '');
    if (!/\/v\d+$/.test(base)) base += '/v1';
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;
    let payloadMessages = messages;
    if (images.length && messages.length) {
      // Multimodal chat completions: image parts precede the text part on
      // the final user turn, using data URLs.
      const last = messages[messages.length - 1];
      const parts = [];
      for (const image of images) {
        if (!/^data:image\//i.test(String(image.dataUrl || ''))) continue;
        parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
      }
      payloadMessages = [
        ...messages.slice(0, -1),
        { role: 'user', content: [...parts, { type: 'text', text: String(last.content || '') }] },
      ];
    }
    const response = await fetch(base + '/chat/completions', {
      method: 'POST', headers, signal,
      body: JSON.stringify({ model: config.model, max_tokens: 16000, stream: true, messages: payloadMessages }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error('OpenAI API HTTP ' + response.status + (detail ? '：' + detail.slice(0, 300) : ''));
    }
    let thinking = '';
    let text = '';
    await readSSEStream(response, (payload) => {
      if (!payload || payload === '[DONE]') return;
      let data;
      try { data = JSON.parse(payload); } catch (_) { return; }
      const delta = data.choices?.[0]?.delta;
      if (!delta) return;
      if (typeof delta.reasoning_content === 'string') {
        thinking += delta.reasoning_content;
        emit({ type: 'thinking', text: delta.reasoning_content });
      }
      if (typeof delta.content === 'string') {
        text += delta.content;
        emit({ type: 'text', text: delta.content });
      }
    });
    return { thinking, text };
  }

  function makeControllers() {
    highlights = ZoteroResearchNative.createHighlightController({
      serverID, attachment, digest: async (text) => zraHash(text),
      token: () => Services.uuid.generateUUID().toString(),
      annotationKey: () => Zotero.DataObjectUtilities.generateKey(),
      locate: async () => { throw new Error('当前版本不再自动定位高亮。'); },
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
    relayStore = ZoteroResearchRelay.createRelayStore();
  }

  // Extracted text cache keyed by the attachment stamp (path+size+mtime):
  // re-parsing the whole PDF on every question cost 1-3s per message.
  const pdfTextCache = new Map();

  async function pdfPages(attachmentKey) {
    const info = await attachment(attachmentKey);
    const cached = pdfTextCache.get(info.stamp);
    if (cached) return cached;
    const pages = await extractPdfPages(info);
    if (pdfTextCache.size >= 6) {
      pdfTextCache.delete(pdfTextCache.keys().next().value);
    }
    pdfTextCache.set(info.stamp, pages);
    return pages;
  }

  async function extractPdfPages(info) {
    // Zotero 10 exposes getFullText(itemID); getPages exists only inside its
    // document worker, not on Zotero.PDFWorker. Full text uses \f between pages.
    const result = await Zotero.PDFWorker.getFullText(info.id, undefined, true);
    const count = result?.extractedPages;
    if (!Number.isInteger(count) || count < 0) throw new Error('Zotero 未返回有效的 PDF 页码信息。');
    if (!count) return [];
    let texts = String(result.text || '').split('\f');
    if (texts.length !== count) {
      // Zotero trims the whole result, including form feeds at blank edge
      // pages. Request explicit page indices in that case to avoid shifted links.
      texts = [];
      for (let index = 0; index < count; index += 1) {
        const page = await Zotero.PDFWorker.getFullText(info.id, [index], true);
        texts.push(String(page?.text || ''));
      }
    }
    return texts.map((text, index) => ({
      number: index + 1,
      text,
    })).filter((page) => page.text.trim());
  }

  async function retrieveEvidence(attachmentKey, query, topK) {
    const pages = await pdfPages(attachmentKey);
    const matched = ZoteroResearchRelay.rankEvidence(pages, query, topK || 6);
    if (matched.length) return matched;
    // Keyword misses (including Chinese questions about English papers) do not
    // mean the PDF has no text. Supply a bounded, explicitly labelled overview.
    const overview = ZoteroResearchRelay.overviewMaterial(pages, 12000);
    return overview.spans.map(span => ({ ...span, source_kind: overview.kind, retrieval_fallback: true }));
  }

  async function retrieveOverviewEvidence(attachmentKey) {
    return ZoteroResearchRelay.overviewMaterial(await pdfPages(attachmentKey));
  }

  /** 1-based page the reader currently shows for this attachment, else null. */
  function currentReaderPage(attachmentKey) {
    try {
      const win = Zotero.getMainWindow();
      const reader = win && Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
      if (!reader) return null;
      const opened = Zotero.Items.get(reader.itemID);
      if (!opened || opened.key !== attachmentKey) return null;
      const viewState = reader._internalReader && reader._internalReader._lastViewState;
      const pageIndex = viewState ? viewState.pageIndex : null;
      return Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex + 1 : null;
    } catch (_) {
      return null;
    }
  }

  /** Evidence spanning exactly the reader's current page, or null to fall back. */
  async function retrieveCurrentPageEvidence(attachmentKey) {
    const page = currentReaderPage(attachmentKey);
    if (!page) return null;
    const pages = await pdfPages(attachmentKey);
    const found = pages.find((entry) => entry.number === page);
    if (!found || !String(found.text || '').trim()) return null;
    return {
      page,
      spans: [{
        evidence_id: 'p' + String(page) + ':c1',
        page,
        chunk_index: 1,
        text: String(found.text),
        score: 1,
      }],
    };
  }

  async function navigate(key, page) {
    if (!Number.isInteger(page) || page < 1) throw new Error('PDF 页码无效。');
    const info = await attachment(key);
    await Zotero.Reader.open(info.id, { pageIndex: page - 1 });
  }

  function registerRelayEndpoint() {
    class ZRARelayEndpoint {
      supportedMethods = ['POST'];
      supportedDataTypes = ['application/json'];

      async init(requestData) {
        const headers = requestData?.headers || {};
        // Reject web-page origins (a page reading the relay directly), but let
        // extension origins through: Tampermonkey's GM_xmlhttpRequest may send
        // its own chrome-extension:// origin on the privileged request.
        const origin = String(headers.origin || headers.Origin || '');
        if (/^https?:/i.test(origin)) {
          return [403, 'application/json', JSON.stringify({ error: 'FORBIDDEN' })];
        }
        const body = requestData?.data || {};
        let result;
        try {
          const action = String(body.action || '');
          if (action === 'poll') result = await relayStore.poll(body);
          else if (action === 'connect') result = relayStore.connect(body);
          else if (action === 'disconnect') result = relayStore.disconnect(body);
          else if (action === 'update') result = relayStore.update(body);
          else result = { error: 'UNKNOWN_ACTION' };
        } catch (_) {
          result = { error: 'INTERNAL' };
        }
        return [200, 'application/json', JSON.stringify(result)];
      }
    }
    Zotero.Server.Endpoints[RELAY_ENDPOINT_PATH] = ZRARelayEndpoint;
  }

  function addDocument(doc) {
    if (documents.has(doc)) return;
    const xul = doc.defaultView?.MozXULElement;
    if (typeof xul?.insertFTLIfNeeded === 'function') {
      xul.insertFTLIfNeeded('zotero-research.ftl');
    }
    const link = doc.createElementNS(ZRA_HTML, 'link');
    link.id = 'zotero-research-styles';
    link.rel = 'stylesheet';
    link.href = data.rootURI + 'content/panel.css';
    doc.documentElement.appendChild(link);
    documents.add(doc);
  }

  function panelRoot(body) {
    return body?.querySelector?.('[data-zrp-root="true"]') || null;
  }

  function removePanelPlaceholder(body) {
    const placeholder = body?.querySelector?.('[data-zrp-placeholder="true"]');
    if (placeholder?.parentNode) placeholder.parentNode.removeChild(placeholder);
  }

  function showPanelPlaceholder(body, message, isError = false) {
    if (!body) return;
    let placeholder = body.querySelector?.('[data-zrp-placeholder="true"]') || null;
    if (!placeholder) {
      const doc = body.ownerDocument;
      if (!doc?.createElementNS || typeof body.appendChild !== 'function') return;
      placeholder = doc.createElementNS(ZRA_HTML, 'div');
      placeholder.setAttribute('class', 'zrp-panel-placeholder');
      placeholder.setAttribute('data-zrp-placeholder', 'true');
      body.appendChild(placeholder);
    }
    placeholder.toggleAttribute?.('data-zrp-error', isError);
    placeholder.textContent = message;
  }

  function showPanelError(body) {
    const roots = body?.querySelectorAll?.('[data-zrp-root="true"]') || [];
    for (const root of Array.from(roots)) {
      if (root.parentNode) root.parentNode.removeChild(root);
    }
    showPanelPlaceholder(
      body,
      '科研助手界面加载失败，请在 Zotero 中停用后重新启用插件。',
      true,
    );
  }

  function reportPanelError(stage, error) {
    try {
      if (typeof Zotero.logError === 'function') Zotero.logError(error);
      else Services.console.logStringMessage('[zotero-research] ' + stage + ': ' + String(error));
    } catch (_) {}
  }

  function mount(props) {
    addDocument(props.doc);
    let record = records.get(props.body);
    if (!record) {
      record = { body: props.body, panel: null, context: null, generation: 0, refresh: props.refresh };
      records.set(props.body, record);
    } else if (props.refresh) {
      record.refresh = props.refresh;
    }
    if (record.panel && !panelRoot(props.body)) {
      try { record.panel.destroy(); } catch (_) {}
      record.panel = null;
    }
    if (!record.panel) {
      try {
        record.panel = ZoteroResearchPanel.mount(props.body, {
          navigate,
          relay: {
            enqueueTask: (request) => relayStore.enqueueTask(request),
            subscribe: (listener) => relayStore.subscribe(listener),
            state: () => relayStore.state(),
          },
          getAPIConfig,
          callModelAPI,
          getAttachmentBase64,
          getAttachmentMediaType,
          getFontSize,
          setFontSize,
          loadChatSession,
          saveChatSession,
          clearChatSession,
          createChildNote,
          retrieveEvidence,
          retrieveOverviewEvidence,
          retrieveCurrentPageEvidence,
          clearSelection: (attachmentKey) => { selections.delete(attachmentKey); },
          getProvider: () => Zotero.Prefs.get('researchAssistant.provider') || 'gemini',
          setProvider: (provider) => Zotero.Prefs.set('researchAssistant.provider', provider),
          prepareHighlight: (args) => highlights.prepare(args),
          commitHighlight: async (preview) => highlights.commit(preview, true),
          openSettings: () => Zotero.Utilities.Internal.openPreferences(preferenceID),
          copyText: (text) => Zotero.Utilities.Internal.copyTextToClipboard(text),
          openExternal: (url) => Zotero.launchURL(url),
        });
      } catch (error) {
        record.panel = null;
        throw error;
      }
    }
    removePanelPlaceholder(props.body);
    if (record.itemID !== props.item?.id) {
      record.itemID = props.item?.id;
      record.generation += 1;
      record.context = null;
      record.panel.setContext(null);
    }
    return record;
  }

  function safeMount(props, stage) {
    try {
      return mount(props);
    } catch (error) {
      showPanelError(props.body);
      reportPanelError(stage, error);
      return null;
    }
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
    let record = records.get(props.body);
    if (!record?.panel || !panelRoot(props.body)) record = safeMount(props, 'onAsyncRender');
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
    button.setAttribute('title', '仅在本机保留选文；提问需要在侧边栏手动启动');
    button.style.cssText = 'margin:4px;padding:5px 9px;border:1px solid #9aa9be;border-radius:4px;background:Canvas;color:CanvasText;cursor:pointer;';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const item = Zotero.Items.get(reader.itemID);
        const selected = await highlights.captureSelection(item.key, source);
        if (!alive) return;
        const limit = ZoteroResearchNative.LIMITS.maxStoredSelections;
        if (selections.size >= limit) selections.delete(selections.keys().next().value);
        selections.set(item.key, selected);
        if (reader.tabID) Zotero.getMainWindow().Zotero_Tabs.select(reader.tabID);
        reveal(item.key);
        button.textContent = '已送入右侧科研助手';
      } catch (_) {
        button.textContent = '选文不可用，请在本地 PDF 中重试';
        button.disabled = false;
      }
    });
    append(button); // Reader requires synchronous append; only the click work is asynchronous.
  };

  const reconnectObserver = { observe: async () => {
    if (!alive) return;
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
      makeControllers();
      registerRelayEndpoint();
      for (const win of Zotero.getMainWindows()) this.addWindow(win);
      sectionID = Zotero.ItemPaneManager.registerSection({
        paneID: 'research-assistant', pluginID: data.id,
        header: { l10nID: 'zotero-research-pane-header', icon: data.rootURI + 'content/icon.svg' },
        sidenav: { l10nID: 'zotero-research-pane-sidenav', icon: data.rootURI + 'content/icon.svg' },
        bodyXHTML: '<html:div xmlns:html="http://www.w3.org/1999/xhtml" class="zrp-panel-placeholder" data-zrp-placeholder="true">科研助手正在加载…</html:div>',
        onInit: (props) => {
          addDocument(props.doc);
          const record = records.get(props.body) || {
            body: props.body, panel: null, context: null, generation: 0,
          };
          if (props.refresh) record.refresh = props.refresh;
          records.set(props.body, record);
        },
        onItemChange: ({ item, setEnabled }) => setEnabled(!!item && item.libraryID === Zotero.Libraries.userLibraryID && !item.deleted),
        onRender: (props) => { safeMount(props, 'onRender'); },
        onAsyncRender: (props) => renderAsync(props).catch((error) => reportPanelError('onAsyncRender', error)),
        onDestroy: (props) => {
          const { body } = props;
          records.get(body)?.panel?.destroy();
          records.delete(body);
        },
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
      relayStore?.destroy();
      Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', selectionListener);
      try { Services.obs.removeObserver(reconnectObserver, ZRA_TOPIC); } catch (_) {}
      for (const record of records.values()) record.panel?.destroy();
      records.clear();
      if (sectionID) Zotero.ItemPaneManager.unregisterSection(sectionID);
      if (preferenceID) Zotero.PreferencePanes.unregister(preferenceID);
      try { delete Zotero.Server.Endpoints[RELAY_ENDPOINT_PATH]; } catch (_) {}
      for (const doc of documents) {
        doc.getElementById('zotero-research-styles')?.remove();
        // insertFTLIfNeeded adds <link rel="localization" href="…/zotero-research.ftl">.
        doc.querySelector('link[rel="localization"][href$="zotero-research.ftl"]')?.remove();
      }
      for (const win of Array.from(windowListeners.keys())) this.removeWindow(win);
      documents.clear();
      selections.clear();
      highlights?.destroy();
    },
  };
}

async function startup(data, _reason) {
  for (const name of ['native.js', 'relay.js', 'markdown.js', 'panel.js']) {
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
