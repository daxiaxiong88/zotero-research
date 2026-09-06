// ==UserScript==
// @name         Zotero 网页 AI 中继
// @namespace    zotero-research
// @version      1.0.4
// @description  捕获已打开网页 AI 的回答流并自动回传 Zotero 侧边栏；支持 Gemini、DeepSeek、ChatGPT、Kimi、Claude、AI Studio。
// @match        https://gemini.google.com/*
// @match        https://aistudio.google.com/*
// @match        https://chat.deepseek.com/*
// @match        https://chatgpt.com/*
// @match        https://www.kimi.com/*
// @match        https://kimi.moonshot.cn/*
// @match        https://claude.ai/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        unsafeWindow
// @connect      127.0.0.1
// @run-at       document-start
// @noframes
// ==/UserScript==

/* eslint-disable no-undef */

(function () {
  'use strict';

  const ENDPOINT = 'http://127.0.0.1:23119/zotero-research/relay';
  const TAB_ID = Math.random().toString(36).slice(2, 11);
  const LOCK_KEY = 'zra_relay_lock';
  const POLL_TIMEOUT_MS = 30000;
  const SEND_BUTTON_WAIT_MS = 30000;
  const NETWORK_IDLE_COMPLETE_MS = 3500;

  // ---------------------------------------------------------------------------
  // Shared stream parsing helpers
  // ---------------------------------------------------------------------------

  function parseJson(value) {
    try { return JSON.parse(String(value || '').trim()); } catch { return null; }
  }

  function ssePayloads(raw) {
    return String(raw || '').split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
  }

  function withThinking(response = '', think = '') {
    if (!think) return response;
    return response ? `<think>${think}</think>\n${response}` : `<think>${think}`;
  }

  // Providers differ on whether each frame is a delta or the full text so far.
  // A shorter later frame can be a rewound cumulative snapshot: keep the longer
  // text instead of appending the regression.
  function mergeStreamText(current, next) {
    const left = String(current || '');
    const right = String(next || '');
    if (!right) return left;
    if (!left || left === right) return right || left;
    if (right.startsWith(left)) return right;
    if (left.startsWith(right)) return left;
    if (left.endsWith(right)) return left;
    const maxOverlap = Math.min(left.length, right.length);
    for (let length = maxOverlap; length > 0; length -= 1) {
      if (left.endsWith(right.slice(0, length))) return left + right.slice(length);
    }
    return left + right;
  }

  // ---------------------------------------------------------------------------
  // Per-site response parsers (ported from the reference connector)
  // ---------------------------------------------------------------------------

  function parseChatGPT(raw) {
    let response = '';
    let done = false;
    for (const payload of ssePayloads(raw)) {
      if (payload === '[DONE]') { done = true; continue; }
      const data = parseJson(payload);
      if (!data) continue;
      const message = data.message;
      if ((!message?.author?.role || message.author.role === 'assistant')
        && message?.content?.content_type === 'text') {
        if (Array.isArray(message.content.parts)) {
          response = message.content.parts.filter((part) => typeof part === 'string').join('\n');
        }
        if (message.status === 'finished_successfully') done = true;
        continue;
      }
      for (const patch of Array.isArray(data.v) ? data.v : [data]) {
        if (patch?.p === '/message/content/parts/0' && typeof patch.v === 'string') response += patch.v;
        else if (patch?.path === '/message/content/parts/0' && typeof patch.value === 'string') response += patch.value;
      }
    }
    return { text: response, done };
  }

  function extractGeminiFrames(raw) {
    const source = String(raw || '');
    const frames = [];
    for (let index = 0; index < source.length;) {
      const start = source.indexOf('[', index);
      if (start < 0) break;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let cursor = start; cursor < source.length; cursor += 1) {
        const character = source[cursor];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === '[') depth += 1;
        else if (character === ']' && --depth === 0) { end = cursor + 1; break; }
      }
      if (end < 0) { index = start + 1; continue; }
      const parsed = parseJson(source.slice(start, end));
      if (Array.isArray(parsed)) { frames.push(parsed); index = end; }
      else index = start + 1;
    }
    return frames;
  }

  function parseGemini(raw) {
    let think = '';
    let response = '';
    let done = false;
    for (const data of extractGeminiFrames(raw)) {
      for (const record of data) {
        if (!Array.isArray(record)) continue;
        const terminalCode = record[1];
        const hasTerminalCode = (typeof terminalCode === 'number' && Number.isFinite(terminalCode))
          || (typeof terminalCode === 'string' && terminalCode.trim() !== ''
            && Number.isFinite(Number(terminalCode)));
        if (record[0] === 'e' && hasTerminalCode) { done = true; continue; }
        if (record[0] !== 'wrb.fr') continue;
        const result = parseJson(record[2])?.[4]?.[0];
        const nextResponse = result?.[1]?.[0];
        if (typeof nextResponse === 'string' && nextResponse) response = nextResponse;
        if (typeof result?.[37]?.[0]?.[0] === 'string') think = result[37][0][0];
      }
    }
    return {
      text: withThinking(response.replace(/\[cite.+?\]/g, ''), think),
      done,
      waitingForResponse: !done,
    };
  }

  function parseDeepSeek(raw) {
    let response = '';
    let think = '';
    let responseType = 'system';
    for (const payload of ssePayloads(raw)) {
      const data = parseJson(payload);
      if (!data) continue;
      let block = {};
      if (data.v?.response) block = data.v.response.fragments?.[0] || {};
      else if (Array.isArray(data.v)) block = data.v[0] || {};
      else if (typeof data.v === 'string') block = { content: data.v };
      if (block.type) responseType = block.type;
      if (!block.content) responseType = 'system';
      if (responseType === 'RESPONSE') response += block.content || '';
      else if (responseType === 'THINK') think += block.content || '';
    }
    return { text: withThinking(response, think), done: false };
  }

  function extractFramedJsonObjects(raw) {
    const source = String(raw || '');
    const objects = [];
    for (let index = 0; index < source.length;) {
      const start = source.indexOf('{', index);
      if (start < 0) break;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let cursor = start; cursor < source.length; cursor += 1) {
        const character = source[cursor];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === '{') depth += 1;
        else if (character === '}' && --depth === 0) { end = cursor + 1; break; }
      }
      if (end < 0) { index = start + 1; continue; }
      const parsed = parseJson(source.slice(start, end));
      if (parsed) { objects.push(parsed); index = end; }
      else index = start + 1;
    }
    return objects;
  }

  function parseKimi(raw) {
    let response = '';
    let think = '';
    let streamDone = false;
    for (const data of extractFramedJsonObjects(raw)) {
      if (Object.prototype.hasOwnProperty.call(data, 'done')
        && data.done !== false && data.done !== null) streamDone = true;
      const block = data.block || {};
      const kind = block.think || data.mask === 'block.think' ? 'think'
        : block.text || data.mask === 'block.text' ? 'text' : '';
      const content = kind === 'think'
        ? (typeof block.think?.content === 'string' ? block.think.content : '')
        : (typeof block.text?.content === 'string' ? block.text.content : '');
      if (!content) continue;
      if (kind === 'think') think = mergeStreamText(think, content);
      else response = mergeStreamText(response, content);
    }
    return { text: withThinking(response, think), done: streamDone };
  }

  function parseClaude(raw) {
    let response = '';
    for (const payload of ssePayloads(raw)) {
      const data = parseJson(payload);
      if (data?.type === 'completion') response += data.completion || '';
      else if (data?.type === 'content_block_delta') response += data.delta?.text || '';
    }
    return { text: response, done: false };
  }

  function parseAIStudio(raw) {
    let data;
    let candidate = raw;
    for (let attempt = 0; !data && attempt <= 100; attempt += 1) {
      data = parseJson(candidate);
      candidate += ']';
    }
    let think = '';
    let response = '';
    for (const item of data?.[0] || []) {
      const text = item?.[0]?.[0]?.[0]?.[0]?.[0]?.[1];
      if (!text) continue;
      if (item?.[0]?.[0]?.[0]?.[0]?.[0]?.[12]) think += text;
      else response += text;
    }
    return { text: withThinking(response, think), done: false };
  }

  function genericNetworkDone(source) {
    return /(?:^|\n)\s*(?:data\s*:\s*\[DONE\]|event\s*:\s*(?:done|complete|completed|SSE_REPLY_END))\s*(?:$|\n)/im.test(source)
      || /"(?:done|complete|completed|finished|finished_successfully)"\s*:\s*true/i.test(source);
  }

  // ---------------------------------------------------------------------------
  // Site configuration
  // ---------------------------------------------------------------------------

  const SITES = {
    ChatGPT: {
      hosts: ['chatgpt.com'],
      input: { text: { selector: '#prompt-textarea', method: 'chatgpt' }, send: '#composer-submit-button', message: '#main section' },
      output: { type: 'network', regex: /\/backend-api\/f\/conversation$/, parser: parseChatGPT },
    },
    Gemini: {
      hosts: ['gemini.google.com'],
      input: { text: { selector: 'rich-textarea .textarea', method: 'gemini' }, send: '.send-button', message: 'user-query-content .user-query-container' },
      output: { type: 'network', regex: /BardFrontendService\/StreamGenerate/, parser: parseGemini },
    },
    DeepSeek: {
      hosts: ['chat.deepseek.com'],
      input: { text: { selector: 'textarea', method: 'react' }, send: '._52c986b', message: '._4f9bf79' },
      output: { type: 'network', regex: /completion$/, parser: parseDeepSeek },
    },
    Kimi: {
      hosts: ['www.kimi.com', 'kimi.moonshot.cn'],
      input: { text: { selector: '[contenteditable="true"]', method: 'lexical' }, send: '.send-button-container', message: '.chat-content-item' },
      output: { type: 'network', regex: /ChatService\/Chat(?:\?|$)/, parser: parseKimi },
    },
    Claude: {
      hosts: ['claude.ai'],
      input: { text: { selector: '[contenteditable="true"]', method: 'div' }, send: 'button[aria-label="Send message"], button[aria-label="發送訊息"]', message: '[data-test-render-count]' },
      output: { type: 'network', regex: /chat_conversations\/.+\/completion/, parser: parseClaude },
    },
    AIStudio: {
      hosts: ['aistudio.google.com'],
      input: { text: { selector: '.text-wrapper textarea', method: 'standard' }, send: 'ms-run-button button', message: 'ms-chat-turn' },
      output: { type: 'network', regex: /GenerateContent$/, parser: parseAIStudio },
    },
  };

  function siteConfig() {
    const host = location.host;
    for (const [name, config] of Object.entries(SITES)) {
      if (config.hosts.some((entry) => host.includes(entry))) return { name, ...config };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Network capture: hook fetch/XHR to read the site's own AI stream.
  // ---------------------------------------------------------------------------

  class NetworkProxy {
    constructor(connector) {
      this.connector = connector;
      this.idleTimer = null;
      this.setupFetch();
      this.setupXHR();
    }

    clearIdle() {
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    }

    scheduleIdle(taskId) {
      this.clearIdle();
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        const connector = this.connector;
        if (!connector.isRunning || connector.currentTaskId !== taskId
          || connector.doneSignal || !connector.accumulatedText) return;
        connector.onNewData(connector.accumulatedText, true);
      }, NETWORK_IDLE_COMPLETE_MS);
    }

    parseOutput(outputConfig, allText) {
      const parsed = outputConfig?.parser?.(allText);
      const hasDone = parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'done');
      return {
        text: typeof parsed === 'string' ? parsed : String(parsed?.text || ''),
        done: hasDone ? Boolean(parsed.done) : genericNetworkDone(allText),
        waitingForResponse: Boolean(parsed?.waitingForResponse),
      };
    }

    handleCapture(allText, taskId) {
      const outputConfig = this.connector.config.output;
      if (!outputConfig?.parser) return;
      const parsed = this.parseOutput(outputConfig, allText);
      if (parsed.text) {
        this.connector.onNewData(parsed.text, parsed.done);
        if (parsed.done || parsed.waitingForResponse) this.clearIdle();
        else this.scheduleIdle(taskId);
      } else if (parsed.done && this.connector.accumulatedText) {
        this.connector.onNewData(this.connector.accumulatedText, true);
      }
    }

    setupFetch() {
      const originalFetch = unsafeWindow && typeof unsafeWindow.fetch === 'function'
        ? unsafeWindow.fetch : null;
      if (!originalFetch) return; // environments without fetch (tests, old engines)
      const self = this;
      const proxy = new Proxy(originalFetch, {
        apply(target, thisArg, args) {
          const fetchPromise = Reflect.apply(target, thisArg, args);
          const input = args[0];
          const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input?.url || ''));
          if (urlStr.includes('zotero-research')) return fetchPromise;
          const outputConfig = self.connector.config?.output;
          if (self.connector.isRunning && self.connector.currentTaskId
            && outputConfig?.type === 'network' && outputConfig.regex?.test(urlStr)) {
            const taskId = self.connector.currentTaskId;
            fetchPromise.then((response) => {
              if (!response.ok) return;
              try {
                const cloned = response.clone();
                setTimeout(() => self.readStream(cloned.body, taskId), 0);
              } catch (_) { /* ignore */ }
            }).catch(() => {});
          }
          return fetchPromise;
        },
      });
      proxy.toString = () => 'function fetch() { [native code] }';
      unsafeWindow.fetch = proxy;
    }

    async readStream(stream, taskId) {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let allText = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (this.connector.currentTaskId !== taskId) break;
          allText += decoder.decode(value, { stream: true });
          this.handleCapture(allText, taskId);
        }
        const tail = decoder.decode();
        if (tail) {
          allText += tail;
          this.handleCapture(allText, taskId);
        }
        if (this.connector.currentTaskId === taskId && !this.connector.doneSignal
          && this.connector.accumulatedText) {
          this.scheduleIdle(taskId);
        }
      } catch (error) {
        if (error?.name !== 'AbortError') console.warn('[Zotero relay] readStream', error);
      }
    }

    setupXHR() {
      const originalOpen = XMLHttpRequest.prototype.open;
      const self = this;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : String(url));
        if (!urlStr.includes('zotero-research')) {
          const outputConfig = self.connector.config?.output;
          if (self.connector.isRunning && self.connector.currentTaskId
            && outputConfig?.type === 'network' && outputConfig.regex?.test(urlStr)) {
            const taskId = self.connector.currentTaskId;
            this.addEventListener('readystatechange', function () {
              if (self.connector.currentTaskId !== taskId) return;
              if (![3, 4].includes(this.readyState)) return;
              try { self.handleCapture(this.responseText, taskId); }
              catch (error) { console.warn('[Zotero relay] xhr parse', error); }
            });
          }
        }
        return originalOpen.apply(this, [method, url, ...rest]);
      };
      XMLHttpRequest.prototype.open.toString = () => 'function open() { [native code] }';
    }
  }

  // ---------------------------------------------------------------------------
  // Connector: protocol against the Zotero endpoint
  // ---------------------------------------------------------------------------

  function gmRequest(payload, timeout = 10000) {
    let abortFn = null;
    const promise = new Promise((resolve, reject) => {
      const req = GM_xmlhttpRequest({
        method: 'POST',
        url: ENDPOINT,
        anonymous: true,
        // Zotero 10 rejects browser User-Agents before dispatching to the
        // endpoint unless a connector protocol header is present.
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json',
          'X-Zotero-Connector-API-Version': '3',
        },
        data: JSON.stringify(payload),
        timeout,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); }
            catch (error) { reject(error); }
          } else {
            const error = new Error(res.statusText || `HTTP ${res.status}`);
            error.status = res.status;
            reject(error);
          }
        },
        onerror: () => reject(new Error('无法连接 Zotero 本机端点')),
        ontimeout: () => {
          if (String(payload.action).toLowerCase() === 'poll') resolve({});
          else reject(new Error('Timeout'));
        },
      });
      abortFn = () => { try { req.abort(); } catch (_) {} reject(new DOMException('Aborted', 'AbortError')); };
    });
    promise.catch(() => {});
    return { abort: abortFn, promise };
  }

  function isEndpointMissing(error) {
    return Number(error?.status) === 404
      || /(?:HTTP\s+404|Not Found)/i.test(String(error?.message || error || ''));
  }

  class Connector {
    constructor(config) {
      this.config = config;
      if (config.output?.type === 'network') this.proxy = new NetworkProxy(this);
      this.sessionSecret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      this.isConnected = false;
      this.isRunning = false;
      this.currentTaskId = null;
      this.accumulatedText = '';
      this.doneSignal = false;
      this.isSendingUpdate = false;
      this.hasPendingData = false;
      this.awaitingManualSend = false;
      this.manualBaseline = null;
      this.pollReq = null;
      this.pollDelayTimer = null;
      this.reconnectTimer = null;
      this.domWatchInterval = null;
      this.handshakePromise = null;
      this.connectionGeneration = 0;
      this.lockTimer = null;
      this.domInitialized = false;
    }

    // --- cross-tab lock: only one connected tab per browser ---
    getLock() { try { return JSON.parse(GM_getValue(LOCK_KEY, '{}')) || {}; } catch { return {}; } }
    acquireLock() {
      const lock = this.getLock();
      if (lock.isLocked && lock.expiresAt > Date.now()) return lock.tabId === TAB_ID;
      return this.forceLock();
    }
    forceLock() {
      GM_setValue(LOCK_KEY, JSON.stringify({ isLocked: true, tabId: TAB_ID, expiresAt: Date.now() + 60000 }));
      return true;
    }
    releaseLock() {
      const lock = this.getLock();
      if (lock.tabId === TAB_ID) GM_setValue(LOCK_KEY, JSON.stringify({ isLocked: false, tabId: null }));
    }
    hasLock() { const lock = this.getLock(); return lock.isLocked && lock.tabId === TAB_ID; }

    initDom() {
      if (this.domInitialized) return;
      this.domInitialized = true;
      createBadge();
      GM_registerMenuCommand('🔗 连接 Zotero', () => { this.startConnection(true); });
      GM_registerMenuCommand('🎊 断开 Zotero', () => { this.isRunning = false; void this.disconnect(); });
      GM_addValueChangeListener(LOCK_KEY, (_name, _old, _next, remote) => {
        if (remote && this.isRunning && !this.hasLock()) {
          void this.disconnect();
          setStatus('已切换到另一网页；从脚本菜单可重新连接');
        }
      });
      window.addEventListener('beforeunload', () => { void this.disconnect(); });
      this.lockTimer = setInterval(() => {
        if (this.isRunning && this.hasLock()) this.forceLock();
      }, 10000);
      const connectHere = new URLSearchParams(location.hash.slice(1)).get('zra-connect') === '1';
      if (connectHere) history.replaceState(null, document.title, location.pathname + location.search);
      this.startConnection(connectHere);
    }

    startConnection(force = false) {
      if (force ? this.forceLock() : this.acquireLock()) {
        if (!this.isRunning) {
          this.sessionSecret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        }
        this.isRunning = true;
        void this.handshake();
      } else setStatus('另一标签页已连接 Zotero；从脚本菜单可切换');
    }

    handshake(options = {}) {
      if (!this.isRunning || !this.hasLock()) return Promise.resolve();
      if (this.handshakePromise) return this.handshakePromise;
      const pending = this.performHandshake(options).finally(() => {
        if (this.handshakePromise === pending) this.handshakePromise = null;
      });
      this.handshakePromise = pending;
      return pending;
    }

    async performHandshake({ silent = false } = {}) {
      const generation = this.connectionGeneration;
      const secret = this.sessionSecret;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.killPoll();
      try {
        const res = await gmRequest({
          action: 'connect',
          ai: this.config.name,
          url: location.href,
          sessionSecret: secret,
          version: GM_info.script.version,
        }, 5000).promise;
        if (!this.isRunning || !this.hasLock() || generation !== this.connectionGeneration) {
          // A connect can finish after the user disconnects. Undo only this
          // attempt's session; the server leaves any newer page untouched.
          if (res.status === 'connected') {
            await gmRequest({ action: 'disconnect', sessionSecret: secret }, 2000).promise;
          }
          return;
        }
        if (res.status !== 'connected') throw new Error(res.error || 'Zotero 未确认连接');
        if (res.status === 'connected') {
          this.isConnected = true;
          if (!silent) notify('Zotero：联动成功');
          setStatus('已连接，等待 Zotero 消息');
          if (this.currentTaskId && this.hasPendingData) this.flushData();
          else this.startPolling();
        }
      } catch (error) {
        if (!this.isRunning || !this.hasLock() || generation !== this.connectionGeneration) return;
        this.isConnected = false;
        const detail = error?.status ? `HTTP ${error.status}` : String(error?.message || error || '');
        if (!silent) notify(`Zotero：联动失败（${detail}）`);
        setStatus(`连接 Zotero 失败：${detail}，5 秒后重试`);
        if (this.isRunning) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isRunning) void this.handshake({ silent: true });
          }, 5000);
        }
      }
    }

    async disconnect() {
      const owned = this.hasLock();
      this.connectionGeneration += 1;
      this.handshakePromise = null;
      this.isRunning = false;
      this.isConnected = false;
      this.killPoll();
      this.resetTaskState();
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.releaseLock();
      setStatus('未连接');
      if (!owned) return null;
      try {
        return await gmRequest({ action: 'disconnect', sessionSecret: this.sessionSecret }, 2000).promise;
      } catch (_) { return null; }
    }

    killPoll() {
      if (this.pollReq) { this.pollReq.abort(); this.pollReq = null; }
      if (this.pollDelayTimer) { clearTimeout(this.pollDelayTimer); this.pollDelayTimer = null; }
    }

    schedulePolling() {
      if (this.pollDelayTimer) clearTimeout(this.pollDelayTimer);
      this.pollDelayTimer = setTimeout(() => {
        this.pollDelayTimer = null;
        if (!this.isSendingUpdate) this.startPolling();
      }, 500);
    }

    async startPolling() {
      if (this.isSendingUpdate || this.pollReq || !this.isConnected || !this.isRunning || !this.hasLock()) return;
      const request = gmRequest({ action: 'poll', sessionSecret: this.sessionSecret }, POLL_TIMEOUT_MS + 5000);
      this.pollReq = request;
      try {
        const res = await request.promise;
        if (this.pollReq !== request || !this.isRunning || !this.hasLock()) return;
        this.pollReq = null;
        if (res.error === 'SESSION_EXPIRED') {
          this.isConnected = false;
          this.handshake({ silent: true });
          return;
        }
        if (res.task) this.executeTask(res.task);
        this.startPolling();
      } catch (error) {
        if (this.pollReq !== request || !this.isRunning || !this.hasLock()) return;
        this.pollReq = null;
        if (error?.name === 'AbortError') return;
        if (this.isSendingUpdate) return;
        if (isEndpointMissing(error)) {
          this.isConnected = false;
          this.handshake({ silent: true });
          return;
        }
        if (this.isConnected && this.isRunning) setTimeout(() => this.startPolling(), 1000);
      }
    }

    resetTaskState() {
      this.proxy?.clearIdle();
      this.currentTaskId = null;
      this.doneSignal = false;
      this.accumulatedText = '';
      this.hasPendingData = false;
      this.awaitingManualSend = false;
      this.manualBaseline = null;
      this.stopDomWatcher();
    }

    onNewData(text, isDone) {
      if (!this.isRunning) return;
      const nextText = String(text || '');
      const nextDone = Boolean(isDone);
      if (nextText === this.accumulatedText && nextDone === this.doneSignal) return;
      this.clearManualFallback();
      this.accumulatedText = nextText;
      if (nextDone) this.doneSignal = true;
      this.hasPendingData = true;
      this.flushData();
    }

    flushData() {
      if (this.isSendingUpdate || !this.hasPendingData) return;
      if (this.pollDelayTimer) { clearTimeout(this.pollDelayTimer); this.pollDelayTimer = null; }
      if (this.pollReq) this.killPoll();
      this.performUpdate();
    }

    async performUpdate() {
      const tid = this.currentTaskId;
      if (!tid) return;
      this.isSendingUpdate = true;
      this.hasPendingData = false;
      const textToSend = this.accumulatedText;
      const doneToSend = this.doneSignal;
      try {
        const response = await gmRequest({
          action: 'update', id: tid, text: textToSend || '', isDone: doneToSend,
          sessionSecret: this.sessionSecret,
        }, 8000).promise;
        if (response?.error === 'SESSION_EXPIRED') {
          this.isSendingUpdate = false;
          this.hasPendingData = true;
          this.handshake({ silent: true });
          return;
        }
        this.isSendingUpdate = false;
        if (doneToSend) {
          this.resetTaskState();
          this.startPolling();
        } else if (this.hasPendingData) this.performUpdate();
        else this.schedulePolling();
      } catch (error) {
        this.isSendingUpdate = false;
        if (this.currentTaskId === tid && this.isRunning) {
          this.hasPendingData = true;
          if (isEndpointMissing(error)) this.handshake({ silent: true });
          else setTimeout(() => this.flushData(), 500);
        }
      }
    }

    // --- task execution ---
    async executeTask(task) {
      try {
        this.killPoll();
        this.isSendingUpdate = true;
        this.resetTaskState();
        this.currentTaskId = task.id;
        const textMessages = (task.messages || []).filter((m) => m.type !== 'file' && m.type !== 'image');
        const prompt = textMessages.map((m) => m.text).join('\n\n');
        const images = (task.messages || []).filter((m) => m.type === 'image' && m.data);
        if (!prompt && !images.length) {
          this.isSendingUpdate = false;
          this.onNewData('', true);
          return;
        }
        // Deliver images through the site's real upload channel, then verify
        // an attachment actually registered before sending text. On any doubt
        // the text stays in the input and the user pastes manually — a wrong
        // auto-send is worse than one extra click.
        if (images.length) {
          const before = this.attachmentCount();
          const channel = await this.deliverImages(images);
          await sleep(1600);
          const registered = channel && this.uploadRegistered(before);
          if (!registered) {
            this.isSendingUpdate = false;
            this.manualBaseline = this.captureBaseline(this.config.input.message);
            this.awaitingManualSend = true;
            this.startDomWatcher();
            setStatus(channel
              ? '截图通道 ' + channel + ' 已尝试但未确认；请手动 Ctrl+V 后发送'
              : '无法投递截图：请手动 Ctrl+V 粘贴后发送');
            notify('截图未确认进入网页：请在输入框手动 Ctrl+V（剪贴板仍是那张图），再点发送；文字已自动填好。');
            if (prompt) await this.fillInput(this.config.input.text, prompt);
            await this.notifySidebar('网页未确认收到截图：请在网页输入框手动 Ctrl+V 粘贴截图（剪贴板仍是刚才那张），然后点击发送；问题文字已自动填好。');
            return;
          }
        }
        const inputConfig = this.config.input.text;
        let filled = prompt ? await this.fillInput(inputConfig, prompt) : true;
        if (prompt && (!filled || !this.inputAccepts(inputConfig, prompt))) {
          filled = await this.refillByReplace(inputConfig, prompt);
        }
        if (prompt && (!filled || !this.inputAccepts(inputConfig, prompt))) {
          this.isSendingUpdate = false;
          await this.reportFailure('无法把问题填入网页 AI 输入框（页面可能改版），请手动粘贴发送。');
          return;
        }
        const sent = await this.handleSend(this.config.input.send, this.config.input.message);
        if (!sent) {
          this.isSendingUpdate = false;
          await this.reportFailure('未能确认网页 AI 发送；请手动点击发送按钮。');
          return;
        }
        if (this.config.output?.type === 'dom') this.startDomWatcher();
        this.isSendingUpdate = false;
        this.flushData();
      } catch (error) {
        this.isSendingUpdate = false;
        await this.reportFailure(String(error?.message || error || '任务执行失败'));
      }
    }

    async reportFailure(message) {
      try {
        await gmRequest({
          action: 'update', id: this.currentTaskId, text: '', isDone: true, failed: message,
          sessionSecret: this.sessionSecret,
        }, 8000).promise;
      } catch (_) { /* the sidebar shows its pending state if the bridge is gone */ }
      setStatus('本次中继失败：' + message);
      notify(message);
      this.resetTaskState();
      this.schedulePolling();
    }

    // --- input strategies (subset of the reference connector) ---
    async waitForCondition(check, timeout) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      return null;
    }

    findUsable(selector) {
      try {
        for (const element of document.querySelectorAll(selector)) {
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (element.getBoundingClientRect().width <= 0) continue;
          if (element.disabled || element.getAttribute('aria-disabled') === 'true') continue;
          return element;
        }
      } catch (_) { /* invalid selector */ }
      return null;
    }

    readText(el) {
      if (!el) return '';
      return 'value' in el ? String(el.value || '') : String(el.innerText || el.textContent || '');
    }

    matchesInput(el, expected) {
      const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').trim();
      return normalize(this.readText(el)) === normalize(expected);
    }

    async fillInput(inputConfig, text) {
      if (!inputConfig) return false;
      const el = await this.waitForCondition(() => this.findUsable(inputConfig.selector), 5000)
        || document.querySelector(inputConfig.selector);
      if (!el) return false;
      el.focus();
      try {
        switch (inputConfig.method) {
          case 'react': {
            const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
            const props = key ? el[key] : null;
            if (props?.onChange) props.onChange({ target: { value: text }, currentTarget: { value: text } });
            else {
              const proto = el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(el, text); else el.value = text;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            break;
          }
          case 'lexical':
          case 'paste': {
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
            break;
          }
          case 'div': {
            el.innerHTML = text.split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('');
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
            break;
          }
          case 'chatgpt':
          case 'gemini':
          case 'contenteditable': {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            selection?.removeAllRanges();
            selection?.addRange(range);
            let inserted = false;
            try { inserted = document.execCommand('insertText', false, text); } catch { }
            if (!inserted || !this.readText(el).trim()) el.textContent = text;
            selection?.removeAllRanges();
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            // Gemini/Angular can replace the editor node; refill the live one.
            if (inputConfig.method !== 'chatgpt') {
              const accepted = await this.waitForCondition(() => {
                const current = this.findUsable(inputConfig.selector);
                return current && (this.matchesInput(current, text) || this.readText(current).trim()) ? current : null;
              }, 1500);
              if (!accepted) return false;
            }
            break;
          }
          default: {
            el.value = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        await sleep(120);
        if (inputConfig.method === 'chatgpt') {
          const current = this.findUsable(inputConfig.selector) || el;
          return Boolean(current && this.readText(current).trim());
        }
        return true;
      } catch (error) {
        console.warn('[Zotero relay] fillInput', error);
        return false;
      }
    }

    base64ToBytes(base64) {
      const binary = atob(String(base64 || ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }

    /** Build transfer files from task images; extension matches media type. */
    buildImageFiles(images) {
      if (typeof DataTransfer !== 'function') return null;
      const transfer = new DataTransfer();
      let added = 0;
      for (const image of images.slice(0, 4)) {
        try {
          const bytes = this.base64ToBytes(image.data);
          const type = /^image\/jpe?g$/i.test(image.mediaType || '') ? 'image/jpeg' : (image.mediaType || 'image/png');
          const extension = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] || 'png');
          transfer.items.add(new File([bytes], `zotero-${Date.now()}-${added}.${extension}`, { type }));
          added += 1;
        } catch (error) {
          console.warn('[Zotero relay] image build failed', error);
        }
      }
      return added ? transfer : null;
    }

    /**
     * Deliver task images through the channel the site actually accepts:
     * 1. a real input[type=file] (ChatGPT/Claude/Kimi) — files assignment is
     *    the most reliable path, no synthetic-paste trust checks involved;
     * 2. drop event on the input area (DeepSeek/AIStudio listen for drag);
     * 3. paste event (Gemini and generic sites).
     * Returns the channel name, or null when every channel failed.
     */
    async deliverImages(images) {
      const transfer = this.buildImageFiles(images);
      if (!transfer) return null;

      const fileInput = document.querySelector('input[type=file]:not([accept*="audio"]):not([accept*="video"])');
      if (fileInput) {
        try {
          fileInput.files = transfer.files;
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(600);
          return 'file-input';
        } catch (error) {
          console.warn('[Zotero relay] file-input channel failed', error);
        }
      }

      const input = this.findUsable(this.config.input.text.selector)
        || document.querySelector(this.config.input.text.selector)
        // Site redesign fallback: any visible composer still accepts drops.
        || document.querySelector('textarea, [contenteditable="true"]');
      if (input) {
        input.focus();
        try {
          input.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          input.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          input.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          await sleep(600);
          return 'drop';
        } catch (error) {
          console.warn('[Zotero relay] drop channel failed', error);
        }
        try {
          input.dispatchEvent(new ClipboardEvent('paste', {
            bubbles: true, cancelable: true, clipboardData: transfer,
          }));
          await sleep(400);
          return 'paste';
        } catch (error) {
          console.warn('[Zotero relay] paste channel failed', error);
        }
      }
      return null;
    }

    /**
     * Rough check that an upload actually registered: the count of images or
     * attachment-ish nodes around the composer grew after delivery.
     */
    uploadRegistered(before) {
      const now = document.querySelectorAll(
        'img[src^="blob:"], img[src^="data:"], [class*="attachment" i], [class*="upload" i] img',
      ).length;
      return now > before;
    }

    attachmentCount() {
      return document.querySelectorAll(
        'img[src^="blob:"], img[src^="data:"], [class*="attachment" i], [class*="upload" i] img',
      ).length;
    }

    /** True when the live input actually holds the expected text (tail match). */
    inputAccepts(inputConfig, expected) {
      const current = this.findUsable(inputConfig.selector) || document.querySelector(inputConfig.selector);
      if (!current) return false;
      const value = this.readText(current).replace(/\s+/g, ' ').trim();
      const wanted = String(expected || '').replace(/\s+/g, ' ').trim();
      if (!wanted) return false;
      const tail = wanted.slice(-60);
      return value === wanted || value.endsWith(tail) || value.length >= wanted.length;
    }

    /** Select-all + insertText, forcing frameworks to accept the text. */
    async refillByReplace(inputConfig, text) {
      const el = this.findUsable(inputConfig.selector) || document.querySelector(inputConfig.selector);
      if (!el) return false;
      el.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection?.removeAllRanges();
      selection?.addRange(range);
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, text); } catch (_) { }
      if (!inserted) {
        if ('value' in el) el.value = text;
        else el.textContent = text;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(150);
      return this.inputAccepts(inputConfig, text);
    }

    captureBaseline(messageSelector) {
      let messages = [];
      try { if (messageSelector) messages = [...document.querySelectorAll(messageSelector)]; } catch { }
      return {
        count: messages.length,
        last: messages.at(-1) || null,
        lastContent: messages.length ? String(messages.at(-1).innerText ?? messages.at(-1).textContent ?? '') : null,
      };
    }

    conversationAdvanced(baseline) {
      if (!baseline?.count && !baseline?.last) return false;
      let messages;
      try { messages = [...document.querySelectorAll(this.config.input.message)]; } catch { return false; }
      const last = messages.at(-1) || null;
      const lastContent = last ? String(last.innerText ?? last.textContent ?? '') : null;
      return messages.length > baseline.count
        || (messages.length === baseline.count && last !== baseline.last)
        || (last === baseline.last && lastContent !== baseline.lastContent);
    }

    hasStreamingControl() {
      let controls = [];
      try { controls = [...document.querySelectorAll('button, [role="button"]')]; } catch { }
      return controls.some((control) => {
        if (control.disabled || control.getAttribute('aria-disabled') === 'true') return false;
        const label = [control.getAttribute('aria-label'), control.getAttribute('title'), control.textContent]
          .filter(Boolean).join(' ');
        return /stop(?:ping)?|停止(?:生成|回答|响应)?|终止(?:生成|回答|响应)?/i.test(label);
      });
    }

    observedManualSend(baseline) {
      return this.hasPendingData || this.doneSignal || Boolean(this.accumulatedText)
        || this.conversationAdvanced(baseline)
        || this.hasStreamingControl();
    }

    async handleSend(send, messageSelector) {
      const baseline = this.captureBaseline(messageSelector);
      this.killPoll();
      this.isSendingUpdate = true;
      const inputConfig = this.config.input.text;
      const inputEmpty = () => {
        const input = this.findUsable(inputConfig?.selector || '');
        return !input || !this.readText(input).trim();
      };
      const sendConfirmed = () => this.conversationAdvanced(baseline)
        || Boolean(this.accumulatedText) || inputEmpty();
      if (typeof send === 'string') {
        const ready = await this.waitForCondition(() => {
          if (this.observedManualSend(baseline)) return { manual: true };
          const button = this.findUsable(send);
          return button ? { button } : null;
        }, SEND_BUTTON_WAIT_MS);
        if (ready?.manual) {
          this.manualBaseline = this.captureBaseline(messageSelector);
          this.awaitingManualSend = true;
          this.startDomWatcher();
          return true;
        }
        const button = ready?.button;
        if (!button) {
          this.manualBaseline = this.captureBaseline(messageSelector);
          this.awaitingManualSend = true;
          this.startDomWatcher();
          setStatus('30 秒未找到发送按钮；请手动发送');
          this.notifySidebar('网页未找到发送按钮：请手动点击发送，或回到侧栏重新发送。');
          return true;
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          button.click();
          for (let index = 0; index < 25; index += 1) {
            if (sendConfirmed()) break;
            await sleep(100);
          }
          if (sendConfirmed()) break;
          // One retry: the first click can land before the page re-enables.
        }
      } else {
        for (let index = 0; index < 30; index += 1) {
          if (sendConfirmed()) break;
          await sleep(100);
        }
      }
      if (sendConfirmed()) {
        this.clearManualFallback();
        return true;
      }
      // Click never registered. Surface it in the sidebar, then watch for a
      // manual send as the recovery path.
      this.manualBaseline = this.captureBaseline(messageSelector);
      this.awaitingManualSend = true;
      this.startDomWatcher();
      setStatus('未能自动发送；请手动点击发送按钮');
      notify('未能自动发送：请在网页手动点击发送，或回到侧栏重新发送。');
      this.notifySidebar('网页未能自动发送：请手动点击发送按钮，或回到侧栏重新发送。');
      return true;
    }

    /** Push a human-readable notice to the sidebar's pending message. */
    async notifySidebar(message) {
      if (!this.currentTaskId) return;
      try {
        await gmRequest({
          action: 'update',
          id: this.currentTaskId,
          text: this.accumulatedText || '',
          isDone: false,
          notice: String(message || '').slice(0, 300),
          sessionSecret: this.sessionSecret,
        }, 5000).promise;
      } catch (_) { /* the badge message already tells the user */ }
    }

    clearManualFallback() {
      this.awaitingManualSend = false;
      this.manualBaseline = null;
    }

    // --- DOM fallback watcher (dom-mode sites, or manual send recovery) ---
    startDomWatcher() {
      if (this.domWatchInterval) return;
      const outputConfig = this.config.output;
      let lastLength = 0;
      let stableCycles = 0;
      this.domWatchInterval = setInterval(async () => {
        if (!this.isRunning || !this.currentTaskId) { this.stopDomWatcher(); return; }
        if (this.awaitingManualSend && this.manualBaseline) {
          if (!this.conversationAdvanced(this.manualBaseline)) return;
          this.clearManualFallback();
        }
        let result = null;
        if (outputConfig?.type === 'dom' && typeof outputConfig.parser === 'function') {
          try { result = outputConfig.parser(); } catch (_) { result = null; }
        } else {
          // Manual-send recovery on a network site: read the visible answer.
          const node = [...document.querySelectorAll(this.config.input.message)].at(-1);
          const content = node ? String(node.innerText || node.textContent || '') : '';
          result = { text: content, isDone: false };
        }
        if (!result || typeof result.text !== 'string') return;
        if (result.isDone) {
          if (result.text.length > lastLength) { stableCycles = 0; this.onNewData(result.text, false); }
          else if (++stableCycles >= 5) { this.onNewData(result.text, true); this.stopDomWatcher(); }
          else this.onNewData(result.text, false);
        } else {
          stableCycles = 0;
          this.onNewData(result.text, false);
        }
        lastLength = result.text.length;
      }, 200);
    }

    stopDomWatcher() {
      if (this.domWatchInterval) { clearInterval(this.domWatchInterval); this.domWatchInterval = null; }
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities & UI
  // ---------------------------------------------------------------------------

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[m]);
  }

  function notify(textContent) {
    try { GM_notification({ title: 'Zotero 网页 AI 中继', text: String(textContent), timeout: 4000 }); }
    catch (_) { console.info('[Zotero relay]', textContent); }
  }

  function setStatus(message) {
    const badge = document.getElementById('zra-relay-status');
    if (badge) badge.textContent = 'Zotero：' + message;
  }

  function createBadge() {
    let badge = document.getElementById('zra-relay-status');
    if (badge) return badge;
    badge = document.createElement('button');
    badge.id = 'zra-relay-status';
    badge.type = 'button';
    badge.textContent = 'Zotero：连接中…';
    badge.title = 'Zotero 网页 AI 中继';
    badge.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'max-width:380px', 'padding:7px 11px', 'border:1px solid #9aa9be',
      'border-radius:7px', 'background:#2C5CC5', 'color:#fff',
      'font:12px/1.35 sans-serif', 'cursor:pointer', 'opacity:.92',
    ].join(';');
    badge.addEventListener('click', () => {
      notify(connector?.isConnected ? '已连接 Zotero，侧栏发送的问题会自动填入本页。' : '未连接；请通过脚本菜单“连接 Zotero”。');
    });
    document.documentElement.appendChild(badge);
    return badge;
  }

  const config = siteConfig();
  let connector = null;
  if (config) {
    connector = new Connector(config);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => connector.initDom(), { once: true });
    } else {
      connector.initDom();
    }
  }

  // Test seams
  if (globalThis.__ZRA_TEST__) {
    globalThis.__ZRA_TEST__.parseChatGPT = parseChatGPT;
    globalThis.__ZRA_TEST__.parseGemini = parseGemini;
    globalThis.__ZRA_TEST__.parseDeepSeek = parseDeepSeek;
    globalThis.__ZRA_TEST__.parseKimi = parseKimi;
    globalThis.__ZRA_TEST__.parseClaude = parseClaude;
    globalThis.__ZRA_TEST__.parseAIStudio = parseAIStudio;
    globalThis.__ZRA_TEST__.mergeStreamText = mergeStreamText;
    globalThis.__ZRA_TEST__.siteConfig = siteConfig;
    globalThis.__ZRA_TEST__.connector = connector;
  }
})();
