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

  const SESSION_FORMAT = 2;
  const SESSION_MESSAGE_LIMIT = 500;
  // The single archive-side cap for one turn's reference material. The panel
  // hands over the untrimmed text; raising this trades file size for keeping
  // more of the original excerpts a long turn pulled in.
  const SESSION_SOURCE_LIMIT = 24000;
  const SESSION_EVIDENCE_LIMIT = 200;
  const sessionQueues = new Map();

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

  function reportSessionError(error) {
    try {
      if (typeof Zotero.logError === 'function') Zotero.logError(error);
    } catch (_) {}
  }

  function sessionKey(itemKey) {
    const key = String(itemKey || '');
    // Item keys are a single legal filename component. Rejecting separators
    // keeps a bad caller from making clear() touch another profile file.
    if (!key || key === '.' || key === '..' || /[\\/\0]/.test(key)) {
      throw new Error('非法的 Zotero itemKey。');
    }
    return key;
  }

  function sessionPaths(itemKey) {
    const key = sessionKey(itemKey);
    const directory = sessionsDirectory();
    const path = PathUtils.join(directory, key + '.json');
    return { key, path, backup: path + '.pre-v2.bak' };
  }

  function cloneSessionValue(value, seen = new Map()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) throw new Error('会话数据不能包含循环引用。');
    seen.set(value, true);
    let result;
    if (Array.isArray(value)) result = value.map(entry => cloneSessionValue(entry, seen));
    else {
      result = {};
      for (const key of Object.keys(value)) result[key] = cloneSessionValue(value[key], seen);
    }
    seen.delete(value);
    return result;
  }

  function boundedSessionText(value) {
    const source = value === null || value === undefined ? '' : String(value);
    return source.length <= SESSION_SOURCE_LIMIT
      ? source
      : source.slice(0, SESSION_SOURCE_LIMIT) + '\n[此处截断，后续内容未提供]';
  }

  function evidencePage(span) {
    return span?.page === undefined || span?.page === null || span?.page === ''
      ? '?' : String(span.page);
  }

  function historicalSourceContext(evidence) {
    const lines = (Array.isArray(evidence) ? evidence : [])
      .map(span => {
        const text = span && span.text !== undefined && span.text !== null
          ? String(span.text) : '';
        return text.trim() ? '（第' + evidencePage(span) + '页）' + text : '';
      })
      .filter(Boolean);
    if (!lines.length) return '';
    return boundedSessionText(
      '材料范围：历史证据摘录（原始任务范围未记录）\n' + lines.join('\n\n'),
    );
  }

  function compactEvidence(evidence) {
    if (!Array.isArray(evidence)) return [];
    return evidence.map(span => {
      const source = span && span.text !== undefined && span.text !== null
        ? String(span.text) : '';
      const compact = {};
      // Keep only the fields the panel needs to identify and navigate to a
      // source. Scores, fallback labels and other retrieval metadata can be
      // regenerated and are intentionally not part of the archive.
      for (const field of ['evidence_id', 'id', 'page', 'chunk_index', 'index', 'sequence']) {
        if (span && span[field] !== undefined) compact[field] = cloneSessionValue(span[field]);
      }
      compact.text = source.slice(0, SESSION_EVIDENCE_LIMIT);
      if (source.length > SESSION_EVIDENCE_LIMIT || span?.truncated === true) compact.truncated = true;
      return compact;
    });
  }

  function sessionMessageSnapshot(message) {
    const source = message && typeof message === 'object' ? message : {};
    const snapshot = {
      role: cloneSessionValue(source.role),
      content: cloneSessionValue(source.content),
      sourceContext: boundedSessionText(source.sourceContext),
      evidence: compactEvidence(source.evidence),
    };
    if (Object.prototype.hasOwnProperty.call(source, 'distill')) {
      snapshot.distill = cloneSessionValue(source.distill);
    }
    if (Object.prototype.hasOwnProperty.call(source, 'distillRequest')) {
      snapshot.distillRequest = cloneSessionValue(source.distillRequest);
    }
    // The panel may add a short explanation when history/material was
    // narrowed. It is display/context data, so preserve it verbatim.
    if (Object.prototype.hasOwnProperty.call(source, 'contextNotice')) {
      snapshot.contextNotice = cloneSessionValue(source.contextNotice);
    }
    return snapshot;
  }

  function buildSessionSnapshot(itemKey, session) {
    const key = sessionKey(itemKey);
    const source = session && typeof session === 'object' ? session : {};
    const input = Array.isArray(source.messages) ? source.messages : [];
    // Bound the rolling transcript by message count only. Never use the
    // compacted evidence size as a reason to drop a question/answer pair.
    const keptInput = input.slice(-SESSION_MESSAGE_LIMIT);

    // Legacy archives did not persist sourceContext. Reconstruct it from the
    // assistant's full evidence before compactEvidence() has discarded text.
    const restoredSources = new Map();
    for (let index = 0; index < keptInput.length; index += 1) {
      const user = keptInput[index] || {};
      if (user.role !== 'user' || String(user.sourceContext || '').trim()) continue;
      let assistant = null;
      for (let next = index + 1; next < keptInput.length; next += 1) {
        if (keptInput[next]?.role === 'user') break;
        if (keptInput[next]?.role === 'assistant') {
          assistant = keptInput[next];
          break;
        }
      }
      const restored = historicalSourceContext(assistant && assistant.evidence);
      if (restored) restoredSources.set(index, restored);
    }
    const kept = keptInput.map((message, index) => {
      const snapshot = sessionMessageSnapshot(message);
      if (restoredSources.has(index)) snapshot.sourceContext = restoredSources.get(index);
      return snapshot;
    });

    const payload = {
      format: SESSION_FORMAT,
      itemKey: key,
      title: String(source.title || ''),
      provider: String(source.provider || ''),
      aiUrl: String(source.aiUrl || ''),
      updatedAt: new Date().toISOString(),
      messages: kept,
    };
    return cloneSessionValue(payload);
  }

  async function readSessionFile(paths) {
    try {
      if (!(await IOUtils.exists(paths.path))) return null;
      const raw = await Zotero.File.getContentsAsync(paths.path);
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.messages)) return null;
      return data;
    } catch (error) {
      reportSessionError(error);
      return null;
    }
  }

  function isCompleteSessionJSON(raw) {
    try {
      const data = JSON.parse(raw);
      return !!data && typeof data === 'object' && Array.isArray(data.messages);
    } catch (_) {
      return false;
    }
  }

  async function backupLegacyFile(paths) {
    const hasBackup = await IOUtils.exists(paths.backup);
    const raw = await Zotero.File.getContentsAsync(paths.path);
    let current;
    try { current = JSON.parse(raw); } catch (_) { current = null; }
    if (current && current.format === SESSION_FORMAT) return;
    if (hasBackup) {
      // A readable, complete backup is never overwritten. One that cannot be
      // parsed has no rollback value, and refusing to touch it would fail
      // every later save for this paper, so rewrite it instead of giving up.
      let saved = null;
      try { saved = await Zotero.File.getContentsAsync(paths.backup); } catch (_) { saved = null; }
      if (isCompleteSessionJSON(saved)) return;
    }
    // Do not use a read/modify/write JSON round trip: the backup must retain
    // the exact contents returned for the old archive.
    await Zotero.File.putContentsAsync(paths.backup, raw);
    const written = await Zotero.File.getContentsAsync(paths.backup);
    if (written !== raw) throw new Error('迁移备份回读与旧存档不一致。');
  }

  async function writeSessionSnapshot(payload) {
    const paths = sessionPaths(payload.itemKey);
    await ensureSessionsDirectory();
    if (await IOUtils.exists(paths.path)) await backupLegacyFile(paths);
    await Zotero.File.putContentsAsync(paths.path, JSON.stringify(payload));
    return true;
  }

  async function removeSessionFiles(itemKey) {
    const paths = sessionPaths(itemKey);
    let ok = true;
    for (const path of [paths.path, paths.backup]) {
      try {
        if (await IOUtils.exists(path)) await IOUtils.remove(path);
      } catch (error) {
        reportSessionError(error);
        ok = false;
      }
    }
    return ok;
  }

  function resolveSessionEntry(entry, result) {
    for (const resolve of entry.waiters.splice(0)) {
      try { resolve(result); } catch (_) {}
    }
  }

  async function drainSessionQueue(key, queue) {
    try {
      while (queue.entries.length) {
        const entry = queue.entries.shift();
        let result;
        try {
          if (entry.type === 'save') result = await writeSessionSnapshot(entry.payload);
          else if (entry.type === 'clear') result = await removeSessionFiles(key);
          else result = await readSessionFile(sessionPaths(key));
        } catch (error) {
          reportSessionError(error);
          result = entry.type === 'load' ? null : false;
        }
        resolveSessionEntry(entry, result);
      }
    } finally {
      queue.running = false;
      queue.drainPromise = null;
      if (!queue.entries.length && sessionQueues.get(key) === queue) sessionQueues.delete(key);
    }
  }

  function startSessionDrain(key, queue) {
    if (queue.running) return;
    queue.running = true;
    queue.drainPromise = drainSessionQueue(key, queue);
  }

  function enqueueSessionOperation(itemKey, type, payload) {
    const key = sessionKey(itemKey);
    let queue = sessionQueues.get(key);
    if (!queue) {
      queue = { entries: [], running: false, drainPromise: null };
      sessionQueues.set(key, queue);
    }
    return new Promise(resolve => {
      if (type === 'save') {
        const tail = queue.entries[queue.entries.length - 1];
        if (tail?.type === 'save') {
          // A pending save is superseded, but all callers still settle with
          // the result of the one write that represents their queue interval.
          tail.payload = payload;
          tail.waiters.push(resolve);
        } else {
          queue.entries.push({ type, payload, waiters: [resolve] });
        }
      } else if (type === 'clear') {
        // Clear is a barrier. Drop only saves that have not started and are
        // immediately before this barrier; saves after it remain after clear.
        for (let index = queue.entries.length - 1; index >= 0; index -= 1) {
          const entry = queue.entries[index];
          if (entry.type !== 'save') break;
          queue.entries.splice(index, 1);
          resolveSessionEntry(entry, false);
        }
        queue.entries.push({ type, waiters: [resolve] });
      } else {
        queue.entries.push({ type, waiters: [resolve] });
      }
      startSessionDrain(key, queue);
    });
  }

  async function flushSessionQueues() {
    // Await queue promises instead of polling. A stop call does not create
    // new panel work, but re-check after the await in case another item was
    // enqueued by a callback already on the event loop.
    while (true) {
      const pending = Array.from(sessionQueues.values())
        .map(queue => queue.drainPromise)
        .filter(Boolean);
      if (!pending.length) return;
      await Promise.all(pending);
    }
  }

  async function loadChatSession(itemKey) {
    if (!alive) return null;
    try { return await enqueueSessionOperation(itemKey, 'load'); }
    catch (error) { reportSessionError(error); return null; }
  }

  async function saveChatSession(itemKey, session) {
    if (!alive) return false;
    let payload;
    try { payload = buildSessionSnapshot(itemKey, session); }
    catch (error) { reportSessionError(error); return false; }
    try { return await enqueueSessionOperation(payload.itemKey, 'save', payload); }
    catch (error) { reportSessionError(error); return false; }
  }

  async function clearChatSession(itemKey) {
    if (!alive) return false;
    try { return await enqueueSessionOperation(itemKey, 'clear'); }
    catch (error) { reportSessionError(error); return false; }
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

  function resolveAPIProtocol(protocol, baseUrl) {
    const selected = String(protocol || 'auto').trim().toLowerCase();
    if (selected === 'anthropic' || selected === 'openai') return selected;
    return /\/anthropic/i.test(String(baseUrl || '')) ? 'anthropic' : 'openai';
  }

  function apiEndpoint(baseUrl, protocol) {
    const source = String(baseUrl || '').trim();
    const match = source.match(/^([^?#]*)([?#].*)?$/);
    let path = (match ? match[1] : source).replace(/\/+$/, '');
    const suffix = protocol === 'anthropic' ? '/messages' : '/chat/completions';
    const endpoint = protocol === 'anthropic' ? /\/messages$/i : /\/chat\/completions$/i;
    if (!endpoint.test(path)) {
      if (!/\/v\d+$/i.test(path)) path += '/v1';
      path += suffix;
    }
    return path + (match?.[2] || '');
  }

  function getAPIConfig() {
    const configuredProtocol = Zotero.Prefs.get('researchAssistant.apiProtocol') || 'auto';
    const baseUrl = (Zotero.Prefs.get('researchAssistant.apiBaseUrl') || '').trim();
    const model = (Zotero.Prefs.get('researchAssistant.apiModel') || '').trim();
    const apiKey = (Zotero.Prefs.get('researchAssistant.apiKey') || '').trim();
    return {
      protocol: resolveAPIProtocol(configuredProtocol, baseUrl),
      baseUrl, model, apiKey,
    };
  }

  const API_REQUEST_TIMEOUT_MS = 120000;

  function prepareAPIRequest(signal) {
    const Controller = typeof AbortController === 'function' ? AbortController : null;
    const controller = Controller ? new Controller() : null;
    let timer = null;
    let timedOut = false;
    let externalAbort = null;
    const abort = (reason) => {
      if (!controller) return;
      try { controller.abort(reason); } catch (_) {
        try { controller.abort(); } catch (_) {}
      }
    };
    if (controller) {
      if (signal?.aborted) abort(signal.reason);
      else if (typeof signal?.addEventListener === 'function') {
        externalAbort = () => abort(signal.reason);
        signal.addEventListener('abort', externalAbort, { once: true });
      }
      timer = setTimeout(() => {
        timedOut = true;
        abort(new Error('API 请求超时。'));
      }, API_REQUEST_TIMEOUT_MS);
    }
    return {
      signal: controller ? controller.signal : signal,
      timedOut: () => timedOut,
      cleanup() {
        if (timer !== null) clearTimeout(timer);
        if (externalAbort && typeof signal?.removeEventListener === 'function') {
          signal.removeEventListener('abort', externalAbort);
        }
      },
    };
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
    const request = prepareAPIRequest(signal);
    try {
      if (config.protocol === 'anthropic') {
        return await callAnthropicAPI(
          config, messages, emit, attachment || null, request.signal, images || [],
        );
      }
      return await callOpenAIAPI(config, messages, emit, request.signal, images || []);
    } catch (error) {
      if (request.timedOut()) throw new Error('API 请求超时。');
      throw error;
    } finally {
      request.cleanup();
    }
  }

  async function readSSEStream(response, handleEvent, signal) {
    const onEvent = typeof handleEvent === 'function' ? handleEvent : () => {};
    let reader = null;
    let readerFinished = false;
    let readerCancelled = false;
    let doneMarker = false;
    let abortReject = null;
    let abortPromise = null;
    const abortReason = () => signal?.reason instanceof Error
      ? signal.reason : new Error('API 请求已取消。');
    const abortHandler = () => { if (abortReject) abortReject(abortReason()); };
    if (typeof signal?.addEventListener === 'function') {
      abortPromise = new Promise((_, reject) => { abortReject = reject; });
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    const cancelReader = async (reason) => {
      if (!reader || readerCancelled || readerFinished || typeof reader.cancel !== 'function') return;
      readerCancelled = true;
      try { await reader.cancel(reason); } catch (_) {}
    };
    const cancelResponseBody = async (reason) => {
      if (reader) {
        await cancelReader(reason);
        return;
      }
      if (typeof response?.body?.cancel === 'function') {
        try { await response.body.cancel(reason); } catch (_) {}
      }
    };
    try {
      if (signal?.aborted) throw abortReason();
      if (!response?.body?.getReader) {
        let raw = '';
        if (typeof response?.text === 'function') {
          const value = response.text();
          raw = abortPromise ? await Promise.race([value, abortPromise]) : await value;
        } else if (typeof response?.json === 'function') {
          const value = response.json();
          raw = JSON.stringify(abortPromise ? await Promise.race([value, abortPromise]) : await value);
        }
        else throw new Error('API 响应没有可读正文。');
        if (String(raw).trim()) onEvent(String(raw).trim());
        return;
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let raw = '';
      let dataLines = [];
      let sawSSEFrame = false;
      const dispatchEvent = () => {
        if (!dataLines.length) return;
        const payload = dataLines.join('\n').trim();
        dataLines = [];
        if (!payload) return;
        if (payload === '[DONE]') doneMarker = true;
        else if (onEvent(payload) === false) doneMarker = true;
      };
      const processLine = (line) => {
        const normalized = line.replace(/\r$/, '');
        if (!normalized) {
          dispatchEvent();
          return;
        }
        if (normalized.startsWith(':')) {
          sawSSEFrame = true;
          return;
        }
        if (/^(?:event|id|retry):/.test(normalized)) {
          sawSSEFrame = true;
          return;
        }
        if (normalized.startsWith('data:')) {
          sawSSEFrame = true;
          const value = normalized.slice(5);
          dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
        }
      };
      const processAvailableLines = () => {
        let split;
        while ((split = buffer.search(/\r\n|\r|\n/)) >= 0) {
          const lineEnd = buffer[split] === '\r' && buffer[split + 1] === '\n'
            ? split + 2 : split + 1;
          processLine(buffer.slice(0, split));
          buffer = buffer.slice(lineEnd);
          if (doneMarker) break;
        }
      };
      while (!doneMarker) {
        const read = reader.read();
        const result = abortPromise ? await Promise.race([read, abortPromise]) : await read;
        if (result.done) {
          readerFinished = true;
          break;
        }
        const chunk = decoder.decode(result.value, { stream: true });
        raw += chunk;
        buffer += chunk;
        processAvailableLines();
        if (sawSSEFrame) raw = '';
      }
      const tail = decoder.decode();
      raw += tail;
      buffer += tail;
      if (!doneMarker) {
        if (buffer) {
          processLine(buffer);
          buffer = '';
        }
        dispatchEvent();
      }
      if (!sawSSEFrame && !doneMarker && raw.trim()) onEvent(raw.trim());
      if (doneMarker) await cancelReader();
    } catch (error) {
      await cancelResponseBody(error);
      throw error;
    } finally {
      if (typeof signal?.removeEventListener === 'function') {
        signal.removeEventListener('abort', abortHandler);
      }
      try { reader?.releaseLock?.(); } catch (_) {}
    }
  }

  async function callAnthropicAPI(config, messages, emit, attachment, signal, images = []) {
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
    const response = await fetch(apiEndpoint(config.baseUrl, 'anthropic'), {
      method: 'POST', headers, signal,
      body: JSON.stringify({
        model: config.model, max_tokens: 16000, stream: true, messages: payloadMessages,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error('Anthropic API HTTP ' + response.status + (detail ? '：' + detail.slice(0, 300) : ''));
    }
    if (!response?.body?.getReader
      && typeof response?.text !== 'function' && typeof response?.json !== 'function') {
      throw new Error('Anthropic API 响应没有可读正文。');
    }
    let thinking = '';
    let text = '';
    await readSSEStream(response, (payload) => {
      if (!payload || payload === '[DONE]') return;
      let data;
      try { data = JSON.parse(payload); } catch (_) {
        throw new Error('Anthropic API 响应格式无效。');
      }
      if (data.type === 'error' || data.error) {
        throw new Error('Anthropic API 错误：' + String(data.error?.message || '未知错误').slice(0, 300));
      }
      if (data.type === 'content_block_delta') {
        if (typeof data.delta?.thinking === 'string') {
          thinking += data.delta.thinking;
          emit({ type: 'thinking', text: data.delta.thinking });
        } else if (typeof data.delta?.text === 'string') {
          text += data.delta.text;
          emit({ type: 'text', text: data.delta.text });
        }
      } else if (Array.isArray(data.content)) {
        // Some OpenAI-compatible gateways ignore stream:true and return the
        // regular Anthropic response object instead.
        for (const block of data.content) {
          if (typeof block?.thinking === 'string') {
            thinking += block.thinking;
            emit({ type: 'thinking', text: block.thinking });
          } else if (typeof block?.text === 'string') {
            text += block.text;
            emit({ type: 'text', text: block.text });
          }
        }
      } else if (data.type === 'message_stop') {
        return false;
      }
    }, signal);
    return { thinking, text };
  }

  async function callOpenAIAPI(config, messages, emit, signal, images = []) {
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
    const response = await fetch(apiEndpoint(config.baseUrl, 'openai'), {
      method: 'POST', headers, signal,
      body: JSON.stringify({ model: config.model, max_tokens: 16000, stream: true, messages: payloadMessages }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error('OpenAI API HTTP ' + response.status + (detail ? '：' + detail.slice(0, 300) : ''));
    }
    if (!response?.body?.getReader
      && typeof response?.text !== 'function' && typeof response?.json !== 'function') {
      throw new Error('OpenAI API 响应没有可读正文。');
    }
    let thinking = '';
    let text = '';
    await readSSEStream(response, (payload) => {
      if (!payload || payload === '[DONE]') return;
      let data;
      try { data = JSON.parse(payload); } catch (_) {
        throw new Error('OpenAI API 响应格式无效。');
      }
      if (data.error) {
        throw new Error('OpenAI API 错误：' + String(data.error.message || data.error || '未知错误').slice(0, 300));
      }
      const delta = data.choices?.[0]?.delta;
      const message = data.choices?.[0]?.message;
      const source = delta || message;
      if (!source) return;
      const reasoning = typeof source.reasoning_content === 'string'
        ? source.reasoning_content : source.reasoning;
      if (typeof reasoning === 'string') {
        thinking += reasoning;
        emit({ type: 'thinking', text: reasoning });
      }
      if (typeof source.content === 'string') {
        text += source.content;
        emit({ type: 'text', text: source.content });
      } else if (Array.isArray(source.content)) {
        for (const part of source.content) {
          if (typeof part?.text === 'string') {
            text += part.text;
            emit({ type: 'text', text: part.text });
          }
        }
      }
      if (data.choices?.[0]?.finish_reason) return false;
    }, signal);
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
  // Only one GPU-backed MinerU process may run at a time. Repeated requests
  // for the same attachment share one promise; a different attachment gets a
  // bounded, actionable busy error instead of waiting in an unbounded queue.
  const mineruJobs = new Map();
  let activeMineruJobKey = null;

  // ---------------------------------------------------------------------------
  // MinerU deep parsing: manual-trigger, disk-cached page text per attachment.
  // ---------------------------------------------------------------------------

  // Keep potentially numerous parsed-paper caches beside Zotero's data on the
  // user's chosen drive, rather than silently consuming the OS profile drive.
  function zoteroProfileDirectory() {
    return Zotero.Profile?.dir
      || Services.dirsvc.get('ProfD', Ci.nsIFile).path;
  }

  function mineruDirectory() {
    const base = Zotero.DataDirectory?.dir
      || zoteroProfileDirectory();
    return PathUtils.join(base, 'zotero-research-mineru');
  }

  function legacyMineruDirectory() {
    return PathUtils.join(zoteroProfileDirectory(), 'zotero-research-mineru');
  }

  async function ensureDirectory(dir) {
    if (!(await IOUtils.exists(dir))) {
      try {
        await IOUtils.makeDirectory(dir, { createAncestors: true });
      } catch (error) {
        // Two independent papers may initialize the shared cache directory at
        // the same time. Treat an already-created directory as success, while
        // preserving genuine permission/IO failures.
        if (!(await IOUtils.exists(dir))) throw error;
      }
    }
  }

  async function ensureMineruDirectory() {
    const dir = mineruDirectory();
    await ensureDirectory(dir);
    return dir;
  }

  function mineruCachePath(attachmentKey) {
    return PathUtils.join(mineruDirectory(), attachmentKey + '.json');
  }

  function legacyMineruCachePath(attachmentKey) {
    return PathUtils.join(legacyMineruDirectory(), attachmentKey + '.json');
  }

  /** Flatten a MinerU table_body HTML string into readable row text. */
  function tableBodyToText(html) {
    return String(html || '')
      .replace(/<tr[^>]*>/gi, '\n')
      .replace(/<t[dh][^>]*>/gi, ' ')
      .replace(/<\/t[dh]>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ \n/g, '\n')
      .trim();
  }

  /** Group a MinerU content_list array into per-page text blocks. */
  function mineruPagesFromContentList(items, pageCount) {
    const blocks = new Map();
    for (let index = 0; index < pageCount; index += 1) blocks.set(index, []);
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue;
      const pageIndex = Number(item.page_idx);
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) continue;
      const type = String(item.type || '');
      let text = '';
      if (type === 'table') {
        const parts = [];
        for (const caption of Array.isArray(item.table_caption) ? item.table_caption : []) {
          if (caption) parts.push(String(caption));
        }
        parts.push(tableBodyToText(item.table_body));
        text = parts.filter(Boolean).join('\n');
      } else if (type === 'image') {
        continue;
      } else {
        text = String(item.text || '');
      }
      if (text.trim()) blocks.get(pageIndex).push(text.trim());
    }
    const pages = [];
    for (let index = 0; index < pageCount; index += 1) {
      const text = blocks.get(index).join('\n').trim();
      if (text) pages.push({ number: index + 1, text });
    }
    return pages;
  }

  function validMineruCache(data, stamp) {
    if (!data || data.stamp !== stamp || !Array.isArray(data.pages) || !data.pages.length) return null;
    if (data.pages.some(page => !page || !Number.isInteger(page.number)
      || page.number < 1 || typeof page.text !== 'string' || !page.text.trim())) return null;
    return data;
  }

  function rememberPdfPages(stamp, pages) {
    if (pdfTextCache.has(stamp)) pdfTextCache.delete(stamp);
    else if (pdfTextCache.size >= 6) pdfTextCache.delete(pdfTextCache.keys().next().value);
    pdfTextCache.set(stamp, pages);
  }

  async function readMineruCacheAt(path, stamp) {
    try {
      if (!(await IOUtils.exists(path))) return null;
      const raw = await Zotero.File.getContentsAsync(path);
      const data = JSON.parse(raw);
      // Stamp mismatch means the file changed: the archive is stale.
      return validMineruCache(data, stamp);
    } catch (_) {
      return null;
    }
  }

  async function readMineruCache(attachmentKey, stamp) {
    try {
      const currentPath = mineruCachePath(attachmentKey);
      const current = await readMineruCacheAt(currentPath, stamp);
      if (current) return current;

      // Version 0.7.7 and earlier wrote these files under the Zotero profile
      // on the OS drive. Read a valid legacy entry once, persist it beside the
      // Zotero data directory, then remove only the migrated file.
      const legacyPath = legacyMineruCachePath(attachmentKey);
      if (legacyPath === currentPath) return null;
      const legacy = await readMineruCacheAt(legacyPath, stamp);
      if (!legacy) return null;
      if (await writeMineruCache(attachmentKey, legacy)) {
        try { await IOUtils.remove(legacyPath); } catch (_) {}
      }
      return legacy;
    } catch (_) {
      // Cache availability must never block Zotero's built-in PDF extraction.
      return null;
    }
  }

  async function writeMineruCache(attachmentKey, payload) {
    try {
      if (!validMineruCache(payload, payload?.stamp)) return false;
      await ensureMineruDirectory();
      const path = mineruCachePath(attachmentKey);
      await Zotero.File.putContentsAsync(path, JSON.stringify(payload));
      // Do not report migration success until the bytes can be parsed back as
      // a complete, stamp-matching cache. The legacy file is removed only
      // after this verification succeeds.
      return Boolean(await readMineruCacheAt(path, payload.stamp));
    } catch (error) {
      try {
        if (typeof Zotero.logError === 'function') Zotero.logError(error);
      } catch (_) {}
      return false;
    }
  }

  function mineruConfigPath() {
    return PathUtils.join(mineruDirectory(), 'mineru-tools.json');
  }

  /**
   * Run the local MinerU CLI on one attachment. Manual-trigger only; results
   * land in the disk cache keyed by the attachment stamp and are then picked
   * up by pdfPages() for every later question.
   */
  async function runMineruParse(attachmentKey, info, onProgress) {
    const executable = String(Zotero.Prefs.get('researchAssistant.mineruExecutable') || '').trim();
    const modelPath = String(Zotero.Prefs.get('researchAssistant.mineruModelPath') || '').trim();
    if (!executable || !modelPath) {
      throw new Error('MinerU 未配置：请在插件设置中填写 mineru 可执行文件路径和模型目录。');
    }
    if (!(await IOUtils.exists(executable))) {
      throw new Error('mineru 可执行文件不存在：' + executable);
    }
    if (!(await IOUtils.exists(modelPath))) {
      throw new Error('MinerU 模型目录不存在：' + modelPath);
    }

    await ensureMineruDirectory();
    // A plugin-managed tools config: local model source, no downloads.
    const configPath = mineruConfigPath();
    await Zotero.File.putContentsAsync(configPath, JSON.stringify({
      'model-source': 'local',
      'models-dir': { vlm: modelPath },
    }));

    const path = await info.item.getFilePathAsync();
    const outputDirectory = PathUtils.join(mineruDirectory(), 'runs',
      info.stamp.slice(0, 16) + '-' + String(Date.now()));
    const cleanupRun = async () => {
      let cleanupError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await IOUtils.remove(outputDirectory, { recursive: true });
          return;
        } catch (error) {
          cleanupError = error;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      try {
        if (cleanupError && typeof Zotero.logError === 'function') Zotero.logError(cleanupError);
      } catch (_) {}
    };
    const failParse = (message) => { throw new Error(message); };

    try {
      await ensureDirectory(outputDirectory);
      // MinerU 3.4.x embeds the input stem in a deep temporary output path.
      // Long paper titles can push that path over Windows MAX_PATH, causing a
      // late FileNotFoundError after inference has already finished. Stage the
      // unchanged PDF under a short name inside this disposable directory.
      const stagedInput = PathUtils.join(outputDirectory, 'input.pdf');
      try {
        await IOUtils.copy(path, stagedInput);
      } catch (error) {
        const detail = error && error.message ? String(error.message) : String(error || '未知错误');
        failParse('MinerU 无法准备短路径 PDF 副本：' + detail);
      }

      const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
      const environment = {
        MINERU_TOOLS_CONFIG_JSON: configPath,
        MINERU_MODEL_SOURCE: 'local',
        HF_HUB_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
        TRANSFORMERS_OFFLINE: '1',
        HF_DATASETS_OFFLINE: '1',
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      };
      let process;
      try {
        process = await Subprocess.call({
          command: executable,
          arguments: ['-p', stagedInput, '-o', outputDirectory, '-b', 'vlm-engine'],
          environment, environmentAppend: true, stdout: 'pipe', stderr: 'pipe',
        });
      } catch (error) {
        const detail = error && error.message ? String(error.message) : String(error || '未知错误');
        failParse('无法启动 MinerU：' + detail);
      }
    // MinerU writes tqdm-style progress ("Processing pages: 3/10") and a
    // final "Processed N/M pages" to its logs; parse the page counts out of
    // the rolling tail and hand them to the panel progress bar.
    const emitProgress = (info) => {
      if (typeof onProgress !== 'function') return;
      try { onProgress(info); } catch (_) { /* progress is advisory */ }
    };
    let progressTail = '';
    let diagnosticTail = '';
    let lastEmitted = '';
    // Complex VLM papers can legitimately take well over 15 minutes. Treat
    // output from either pipe as a heartbeat: terminate only after a long
    // period with no output, while retaining a generous absolute ceiling for
    // a process that emits noise forever without completing.
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    const idleTimeoutMs = 15 * 60 * 1000;
    const maxRuntimeMs = 60 * 60 * 1000;
    const parseProgress = (chunk) => {
      const chunkText = String(chunk || '');
      if (chunkText) lastOutputAt = Date.now();
      progressTail = (progressTail + chunkText).slice(-4000);
      // Keep only a short tail for an actionable failure message. MinerU can
      // emit many megabytes of progress output for a long paper.
      diagnosticTail = (diagnosticTail + chunkText).slice(-12000);
      // MinerU writes several tqdm stages; the page count is the truth for
      // "how far through the document", while Predict is the long VLM
      // inference pass over page crops. Track both so the bar never sits
      // still through the minutes-long inference stage.
      const patterns = [
        /Processing pages:[^\r\n]*?(\d+)\s*\/\s*(\d+)/g,
        /Processed\s+(\d+)\s*\/\s*(\d+)\s*pages/g,
      ];
      let latest = null;
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(progressTail)) !== null) {
          const total = Number(match[2]);
          const current = Number(match[1]);
          if (total > 0 && current >= 0 && current <= total) {
            latest = { current, total };
          }
        }
      }
      if (latest && latest.current + '/' + latest.total !== lastEmitted) {
        lastEmitted = latest.current + '/' + latest.total;
        emitProgress({ phase: 'parsing', current: latest.current, total: latest.total });
      }
      // Stage labels: last occurrence of any known stage in the tail wins.
      const stageNames = {
        'Loading checkpoint': '加载模型权重',
        'Layout Output Parsing': '版面分析',
        'Extract Preparation': '准备推理输入',
        Predict: '模型推理',
        'Post Processing': '整理结果',
        'Processing pages': '写出页面',
      };
      let stage = null;
      let stageAt = -1;
      for (const [marker, label] of Object.entries(stageNames)) {
        const at = progressTail.lastIndexOf(marker);
        if (at > stageAt) {
          stageAt = at;
          stage = label;
        }
      }
      if (stage && stage !== lastStage) {
        lastStage = stage;
        emitProgress({ phase: 'stage', stage });
      }
    };
    const failureDetail = () => {
      const lines = diagnosticTail
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\r/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
      let detail = '';
      // MinerU's CLI ends with a long task-status line whose JSON contains the
      // real server exception. Pull that field out before the UI truncates the
      // outer status text.
      for (const line of lines.slice().reverse()) {
        const objectStart = line.indexOf('{');
        if (objectStart < 0) continue;
        try {
          const status = JSON.parse(line.slice(objectStart));
          if (status && typeof status.error === 'string' && status.error.trim()) {
            detail = status.error;
            break;
          }
        } catch (_) { /* not a standalone task-status object */ }
      }
      if (!detail) {
        detail = lines.slice().reverse().find(line =>
          /(?:FileNotFoundError|RuntimeError|ValueError|TypeError|OSError|ImportError|ModuleNotFoundError|OutOfMemoryError):/i.test(line),
        ) || '';
      }
      if (!detail) {
        detail = lines.slice().reverse().find(line =>
          /error|exception|traceback|cuda|out of memory|not found|no module named|failed|unsupported|invalid|cannot|could not/i.test(line),
        ) || '';
      }
      detail = detail
        .replace(/^.*?\|\s*(?:ERROR|CRITICAL)\s*\|.*?\s-\s*/i, '')
        .replace(/^(?:FileNotFoundError|RuntimeError|ValueError|TypeError|OSError|ImportError|ModuleNotFoundError|OutOfMemoryError):\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      return detail.length > 360 ? detail.slice(0, 360) + '…' : detail;
    };
    let lastStage = '';
    emitProgress({ phase: 'starting' });
    const stdoutTask = (async () => {
      try { while (true) { const chunk = await process.stdout.readString(); if (!chunk) break; parseProgress(chunk); } }
      catch (_) {}
    })();
    const stderrTask = (async () => {
      try { while (true) { const chunk = await process.stderr.readString(); if (!chunk) break; parseProgress(chunk); } }
      catch (_) {}
    })();
    const bounded = async (promise, timeoutMs) => {
      const timeoutSentinel = {};
      let timer = null;
      const result = await Promise.race([
        Promise.resolve(promise).then(() => true, () => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(timeoutSentinel), timeoutMs); }),
      ]);
      if (timer !== null) clearTimeout(timer);
      return result === true;
    };
    const terminateProcess = async () => {
      try {
        // BaseProcess.kill() resolves only after wait() observes termination;
        // bound that await so an uncooperative child cannot wedge cleanup.
        await bounded(process.kill(0), 5000);
      } catch (_) {}
    };
    const closePipe = (pipe) => {
      try {
        const result = pipe && typeof pipe.close === 'function' ? pipe.close() : null;
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_) {}
    };
    const drainPipes = async () => {
      const pipesDone = Promise.allSettled([stdoutTask, stderrTask]);
      if (await bounded(pipesDone, 5000)) return;
      // A terminated child normally closes both pipes, but a broken native
      // pipe must not keep the parse promise alive forever. Closing the handles
      // also lets Subprocess release its worker resources.
      closePipe(process.stdout);
      closePipe(process.stderr);
    };
    const deadline = startedAt + maxRuntimeMs;
    const waitPromise = (async () => {
      try { return { ok: true, outcome: await process.wait() }; }
      catch (error) { return { ok: false, error }; }
    })();
    const pollSentinel = {};
    let completed = false;
    let outcome = null;
    let timeoutReason = 'maximum';
    while (Date.now() < deadline) {
      if (Date.now() - lastOutputAt >= idleTimeoutMs) {
        timeoutReason = 'idle';
        break;
      }
      let pollTimer = null;
      const current = await Promise.race([
        waitPromise,
        new Promise(resolve => {
          pollTimer = setTimeout(() => resolve(pollSentinel), 2000);
        }),
      ]);
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (current !== pollSentinel) {
        if (!current.ok) {
          await terminateProcess();
          await drainPipes();
          const detail = current.error && current.error.message
            ? String(current.error.message) : String(current.error || '未知错误');
          failParse('等待 MinerU 子进程失败：' + detail);
        }
        outcome = current.outcome;
        completed = true;
        break;
      }
    }
    if (!completed) {
      await terminateProcess();
      // Give stdout/stderr handles a bounded window to close before finally
      // removes the run directory; this avoids intermittent Windows leftovers.
      await drainPipes();
      failParse(timeoutReason === 'idle'
        ? 'MinerU 已连续 15 分钟没有输出，已终止。'
        : 'MinerU 解析超过 60 分钟，已终止。');
    }
    // wait() resolves only after the child exits, so both pipes should now
    // reach EOF. Await them before selecting the final useful error line.
    await drainPipes();
    // Zotero 10 resolves wait() as {exitCode}; retaining bare-number support
    // also keeps the adapter testable and compatible with older runtimes.
    const exitCode = outcome && typeof outcome === 'object' ? outcome.exitCode : outcome;
    if (!Number.isInteger(exitCode)) {
      failParse('MinerU 子进程返回了无法识别的退出状态；请更新 Zotero 或插件后重试。');
    }
    if (exitCode !== 0) {
      const detail = failureDetail();
      failParse('MinerU 退出码 ' + exitCode + '：'
        + (detail || '未捕获到具体错误，请检查模型目录、显存和 MinerU 安装。'));
    }

    // Locate the content_list JSON produced under <output>/input/vlm/.
    let contentPath = null;
    const queue = [outputDirectory];
    while (queue.length && !contentPath) {
      const dir = queue.shift();
      for (const child of await IOUtils.getChildren(dir)) {
        const stat = await IOUtils.stat(child);
        if (stat.isDir) queue.push(child);
        else if (child.endsWith('_content_list.json')) contentPath = child;
      }
    }
    if (!contentPath) {
      failParse('MinerU 未生成 content_list.json；请确认模型目录指向完整权重。');
    }
    const payload = JSON.parse(await Zotero.File.getContentsAsync(contentPath));
    const sourceCount = await (async () => {
      const pageTexts = await extractPdfPages(info);
      // Count physical pages even when the text layer is empty (scanned PDFs).
      const result = await Zotero.PDFWorker.getFullText(info.id, undefined, true);
      const physicalPages = Number.isInteger(result?.totalPages) && result.totalPages > 0
        ? result.totalPages : result?.extractedPages;
      return Number.isInteger(physicalPages) && physicalPages > 0
        ? physicalPages : Math.max(pageTexts.length, 1);
    })();
    const pages = mineruPagesFromContentList(payload, sourceCount);
    if (!pages.length) {
      failParse('MinerU 解析完成但没有可用文本；该 PDF 可能是纯图像扫描件。');
    }
    emitProgress({ phase: 'saving' });
    const stats = {
      pageCount: sourceCount,
      textPages: pages.length,
      parsedAt: new Date().toISOString(),
    };
    if (!(await writeMineruCache(attachmentKey, { stamp: info.stamp, pages, stats }))) {
      failParse('MinerU 解析成功，但无法写入持久缓存。请检查 Zotero 数据目录权限。');
    }
    rememberPdfPages(info.stamp, pages);
    return { pages, cached: false, stats };
    } finally {
      // All exits—success, parse failure, wait failure and timeout—converge on
      // one awaited cleanup path. Cache files live outside this run directory.
      await cleanupRun();
    }
  }

  async function deepParseWithMineru(attachmentKey, onProgress) {
    const info = await attachment(attachmentKey);
    const jobKey = String(info.key || attachmentKey) + '\0' + info.stamp;
    const cached = await readMineruCache(attachmentKey, info.stamp);
    if (cached) {
      rememberPdfPages(info.stamp, cached.pages);
      return { pages: cached.pages, cached: true, stats: cached.stats };
    }

    const existing = mineruJobs.get(jobKey);
    if (existing) {
      if (typeof onProgress === 'function') existing.listeners.add(onProgress);
      try {
        return await existing.promise;
      } finally {
        if (typeof onProgress === 'function') existing.listeners.delete(onProgress);
      }
    }
    if (activeMineruJobKey && activeMineruJobKey !== jobKey) {
      throw new Error('MinerU 正在解析另一篇论文，请等待当前任务完成后重试。');
    }

    const listeners = new Set();
    if (typeof onProgress === 'function') listeners.add(onProgress);
    const emitProgress = (progress) => {
      for (const listener of listeners) {
        try { listener(progress); } catch (_) { /* progress is advisory */ }
      }
    };
    activeMineruJobKey = jobKey;
    let promise;
    promise = runMineruParse(attachmentKey, info, emitProgress).finally(() => {
      if (mineruJobs.get(jobKey)?.promise === promise) mineruJobs.delete(jobKey);
      if (activeMineruJobKey === jobKey) activeMineruJobKey = null;
    });
    mineruJobs.set(jobKey, { promise, listeners });
    try {
      return await promise;
    } finally {
      if (typeof onProgress === 'function') listeners.delete(onProgress);
    }
  }

  async function pdfPages(attachmentKey) {
    const info = await attachment(attachmentKey);
    const cached = pdfTextCache.get(info.stamp);
    if (cached) return cached;
    // A deep-parsed archive (manual MinerU run, stamp-matched) always wins:
    // the user explicitly asked for the better text layer on this paper.
    const mineru = await readMineruCache(attachmentKey, info.stamp);
    if (mineru && mineru.pages.length) {
      rememberPdfPages(info.stamp, mineru.pages);
      return mineru.pages;
    }
    const pages = await extractPdfPages(info);
    rememberPdfPages(info.stamp, pages);
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
            cancelTask: (id) => relayStore.cancelTask(id),
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
          deepParseWithMineru,
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
      await flushSessionQueues();
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
  for (const name of ['native.js', 'relay.js', 'katex.min.js', 'markdown.js', 'panel.js']) {
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
