// ==UserScript==
// @name         Zotero 网页 AI 中继
// @namespace    zotero-research
// @version      1.0.19
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
  const TASK_WAIT_LIMIT_MS = 20 * 60 * 1000;
  const DIAGNOSTIC_TRACE_KEY = 'zra-diagnostic-trace-v1';

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
    if (!think) { return response; }
    return response ? `<think>${think}</think>\n${response}` : `<think>${think}`;
  }

  // Providers differ on whether each frame is a delta or the full text so far.
  // A shorter later frame can be a rewound cumulative snapshot: keep the longer
  // text instead of appending the regression.
  function mergeStreamText(current, next) {
    const left = String(current || '');
    const right = String(next || '');
    if (!right) { return left; }
    if (!left || left === right) { return right || left; }
    if (right.startsWith(left)) { return right; }
    if (left.startsWith(right)) { return left; }
    if (left.endsWith(right)) { return left; }
    const maxOverlap = Math.min(left.length, right.length);
    for (let length = maxOverlap; length > 0; length -= 1) {
      if (left.endsWith(right.slice(0, length))) { return left + right.slice(length); }
    }
    return left + right;
  }

  /**
   * ChatGPT sometimes puts its private file-citation protocol markers directly
   * in the streamed text. They are useful to ChatGPT's own renderer, but the
   * Zotero relay has no renderer for them and would show private-use glyphs in
   * the sidebar. Strip only citation-shaped markers at the parser boundary so
   * ordinary answer text and line breaks remain untouched.
   */
  function stripChatGPTInternalCitations(value) {
    let text = String(value ?? '');
    if (!/(?:filecite|felicite|\bcite\b|(?:turn|return)\d+file\d+)/i.test(text)) { return text; }
    const pua = '[\\uE000-\\uF8FF]';
    const marker = '(?:filecite|felicite|cite)';
    const reference = '(?:turn|return)\\d+file\\d+';
    const lineReference = `(?:${pua}*(?:\\s+)?L\\d+(?:-L\\d+)?)?`;
    // Complete protocol markers may use private-use delimiters between every
    // component. Consume only the delimiters directly attached to a marker;
    // ordinary private-use characters elsewhere are answer text and survive.
    text = text.replace(
      new RegExp(`${pua}*\\b${marker}\\b${pua}*${reference}${lineReference}${pua}*`, 'gi'),
      '',
    );
    // A failed/older decode can leave the same marker without private-use
    // delimiters. Handle that representation too.
    text = text.replace(
      new RegExp(`\\b${marker}\\b\\s*${reference}${lineReference}`, 'gi'),
      '',
    );
    // Keep the same narrow rule for a plain-text token whose file number is
    // still incomplete (for example, `filecite turn0file`).
    text = text.replace(
      /\b(?:filecite|felicite)\b\s*(?:turn|return)\d+file\d*(?![A-Za-z0-9])/gi,
      '',
    );
    // Streaming can expose a protocol token before its reference is complete.
    // Only a PUA-delimited marker is strong evidence here; do not remove a
    // normal prose word such as "cite" merely because it is incomplete.
    text = text.replace(
      new RegExp(`${pua}+(?:filecite|felicite|cite)(?:${pua}+(?:(?:turn|return)\\d*file\\d*)?)?${pua}*`, 'gi'),
      '',
    );
    return text;
  }

  function chatGPTSnapshotText(message) {
    if ((!message?.author?.role || message.author.role === 'assistant')
      && (!message.channel || message.channel === 'final')
      && (!message.recipient || message.recipient === 'all')
      && message?.content?.content_type === 'text'
      && Array.isArray(message.content.parts)) {
      return message.content.parts.filter((part) => typeof part === 'string').join('\n');
    }
    return null;
  }

  function chatGPTFrameDone(data, message) {
    const types = [data?.type, data?.event]
      .map((value) => String(value || '').toLowerCase());
    const stopReason = String(data?.delta?.stop_reason ?? data?.stop_reason ?? '').toLowerCase();
    return data?.done === true || data?.complete === true || data?.completed === true
      || data?.is_done === true || (message?.end_turn === true && chatGPTSnapshotText(message) !== null)
      || types.some((type) => ['done', 'complete', 'completed', 'response.completed'].includes(type))
      || ['end_turn', 'stop'].includes(stopReason);
  }

  function chatGPTPatchValue(patch) {
    const value = Object.prototype.hasOwnProperty.call(patch || {}, 'v') ? patch.v : patch?.value;
    if (typeof value === 'string') { return value; }
    if (Array.isArray(value)) { return value.filter((part) => typeof part === 'string').join('\n'); }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Per-site response parsers (ported from the reference connector)
  // ---------------------------------------------------------------------------

  function parseChatGPT(raw) {
    let state = { message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [] } } };
    const messages = new Map();
    let done = false;
    let lastPath = '';
    let lastOperation = '';
    const remember = () => {
      const text = chatGPTSnapshotText(state.message);
      if (text !== null) { messages.set(state.message.id || 'legacy', text); }
    };
    const apply = (patch) => {
      const path = patch?.p ?? patch?.path ?? lastPath;
      const operation = String(patch?.o ?? patch?.op ?? lastOperation).toLowerCase();
      const value = Object.hasOwn(patch || {}, 'v') ? patch.v : patch?.value;
      if (operation === 'patch' && Array.isArray(value)) { value.forEach(apply); return; }
      if (typeof path !== 'string') { return; }
      lastPath = path;
      lastOperation = operation;
      if (!path && value?.message) { state = value; remember(); return; }
      const keys = path.split('/').slice(1).map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
      if (!keys.length || keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) { return; }
      let target = state;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!target[keys[i]] || typeof target[keys[i]] !== 'object') {
          target[keys[i]] = /^\d+$/.test(keys[i + 1]) ? [] : {};
        }
        target = target[keys[i]];
      }
      const key = keys.at(-1);
      if (operation === 'remove' || operation === 'delete') { delete target[key]; }
      else if ((operation === 'append' || operation === 'add') && typeof target[key] === 'string' && typeof value === 'string') { target[key] += value; }
      else if (!operation && typeof target[key] === 'string' && typeof value === 'string') { target[key] = mergeStreamText(target[key], value); }
      else if (value !== undefined) { target[key] = value; }
      remember();
    };
    for (const payload of ssePayloads(raw)) {
      if (payload === '[DONE]') { done = true; continue; }
      const data = parseJson(payload);
      if (!data) { continue; }
      if (data.message) { state = { message: data.message }; remember(); }
      else if (data.v?.message && !data.p) { state = data.v; remember(); lastPath = ''; lastOperation = ''; }
      else if (Array.isArray(data.v) && data.v.every(value => value && typeof value === 'object')) { data.v.forEach(apply); }
      else if (data.p || data.path || lastPath) { apply(data); }
      if (chatGPTFrameDone(data, state.message)) { done = true; }
    }
    return { text: stripChatGPTInternalCitations(Array.from(messages.values()).filter(Boolean).join('\n\n')), done };
  }

  function extractGeminiFrames(raw) {
    const source = String(raw || '');
    const frames = [];
    for (let index = 0; index < source.length;) {
      const start = source.indexOf('[', index);
      if (start < 0) { break; }
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let cursor = start; cursor < source.length; cursor += 1) {
        const character = source[cursor];
        if (inString) {
          if (escaped) { escaped = false; }
          else if (character === '\\') { escaped = true; }
          else if (character === '"') { inString = false; }
          continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === '[') { depth += 1; }
        else if (character === ']' && --depth === 0) { end = cursor + 1; break; }
      }
      if (end < 0) { index = start + 1; continue; }
      const parsed = parseJson(source.slice(start, end));
      if (Array.isArray(parsed)) { frames.push(parsed); index = end; }
      else { index = start + 1; }
    }
    return frames;
  }

  function parseGemini(raw) {
    let think = '';
    let response = '';
    let done = false;
    for (const data of extractGeminiFrames(raw)) {
      for (const record of data) {
        if (!Array.isArray(record)) { continue; }
        const terminalCode = record[1];
        const hasTerminalCode = (typeof terminalCode === 'number' && Number.isFinite(terminalCode))
          || (typeof terminalCode === 'string' && terminalCode.trim() !== ''
            && Number.isFinite(Number(terminalCode)));
        if (record[0] === 'e' && hasTerminalCode) { done = true; continue; }
        if (record[0] !== 'wrb.fr') { continue; }
        const result = parseJson(record[2])?.[4]?.[0];
        const nextResponse = result?.[1]?.[0];
        if (typeof nextResponse === 'string' && nextResponse) { response = nextResponse; }
        if (typeof result?.[37]?.[0]?.[0] === 'string') { think = result[37][0][0]; }
      }
    }
    return {
      text: withThinking(response.replace(/\[cite.+?\]/g, ''), think),
      hasAnswer: Boolean(response.trim()),
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
      if (!data) { continue; }
      let block = {};
      if (data.v?.response) { block = data.v.response.fragments?.[0] || {}; }
      else if (Array.isArray(data.v)) { block = data.v[0] || {}; }
      else if (typeof data.v === 'string') { block = { content: data.v }; }
      if (block.type) { responseType = block.type; }
      if (!block.content) { responseType = 'system'; }
      if (responseType === 'RESPONSE') { response += block.content || ''; }
      else if (responseType === 'THINK') { think += block.content || ''; }
    }
    return { text: withThinking(response, think), done: false };
  }

  function extractFramedJsonObjects(raw) {
    const source = String(raw || '');
    const objects = [];
    for (let index = 0; index < source.length;) {
      const start = source.indexOf('{', index);
      if (start < 0) { break; }
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let cursor = start; cursor < source.length; cursor += 1) {
        const character = source[cursor];
        if (inString) {
          if (escaped) { escaped = false; }
          else if (character === '\\') { escaped = true; }
          else if (character === '"') { inString = false; }
          continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === '{') { depth += 1; }
        else if (character === '}' && --depth === 0) { end = cursor + 1; break; }
      }
      if (end < 0) { index = start + 1; continue; }
      const parsed = parseJson(source.slice(start, end));
      if (parsed) { objects.push(parsed); index = end; }
      else { index = start + 1; }
    }
    return objects;
  }

  function parseKimi(raw) {
    let response = '';
    let think = '';
    let streamDone = false;
    for (const data of extractFramedJsonObjects(raw)) {
      if (Object.prototype.hasOwnProperty.call(data, 'done')
        && data.done !== false && data.done !== null) { streamDone = true; }
      const block = data.block || {};
      const kind = block.think || data.mask === 'block.think' ? 'think'
        : block.text || data.mask === 'block.text' ? 'text' : '';
      const content = kind === 'think'
        ? (typeof block.think?.content === 'string' ? block.think.content : '')
        : (typeof block.text?.content === 'string' ? block.text.content : '');
      if (!content) { continue; }
      if (kind === 'think') { think = mergeStreamText(think, content); }
      else { response = mergeStreamText(response, content); }
    }
    return { text: withThinking(response, think), done: streamDone };
  }

  function parseClaude(raw) {
    let response = '';
    for (const payload of ssePayloads(raw)) {
      const data = parseJson(payload);
      if (data?.type === 'completion') { response += data.completion || ''; }
      else if (data?.type === 'content_block_delta') { response += data.delta?.text || ''; }
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
      if (!text) { continue; }
      if (item?.[0]?.[0]?.[0]?.[0]?.[0]?.[12]) { think += text; }
      else { response += text; }
    }
    return { text: withThinking(response, think), done: false };
  }

  function genericNetworkDone(source) {
    return /(?:^|\n)\s*(?:data\s*:\s*\[DONE\]|event\s*:\s*(?:done|complete|completed|SSE_REPLY_END))\s*(?:$|\n)/im.test(source)
      || /"(?:done|complete|completed|finished|finished_successfully)"\s*:\s*true/i.test(source);
  }

  // Read the rendered answer as Markdown, retaining the original math source
  // instead of concatenating KaTeX's accessibility text and visible glyphs.
  function chatGPTAnswerMarkdown(root) {
    const walk = (node) => {
      if (node.nodeType === 3) { return node.textContent || ''; }
      if (node.nodeType !== 1) { return ''; }
      const tag = node.localName;
      const cls = node.getAttribute('class') || '';
      const mathNode = node.matches('[data-math-source], .katex-display, .katex, math');
      if (mathNode) {
        const source = node.getAttribute('data-math-source')
          || node.querySelector('annotation[encoding="application/x-tex"]')?.textContent
          || node.closest('[data-math-source]')?.getAttribute('data-math-source');
        const display = cls.includes('katex-display') || node.querySelector('.katex-display')
          || node.getAttribute('display') === 'block' || (tag === 'div' && node.hasAttribute('data-math-source'));
        if (source?.trim()) { return display ? '\n$$' + source.trim() + '$$\n' : '$' + source.trim() + '$'; }
        return (node.querySelector('.katex-html') || node).textContent || '';
      }
      if (node.matches('button, script, style, svg, annotation, [aria-hidden="true"], [data-testid*="reasoning"], [data-testid*="thinking"]')) { return ''; }
      const content = () => Array.from(node.childNodes, walk).join('');
      if (tag === 'pre') {
        const code = node.querySelector('code') || node;
        const language = /language-([\w+-]+)/.exec(code.className || '')?.[1] || '';
        const text = code.textContent || '';
        const fence = '`'.repeat(Math.max(3, ...((text.match(/`+/g) || []).map(value => value.length + 1))));
        return '\n' + fence + language + '\n' + text + '\n' + fence + '\n';
      }
      if (tag === 'code') { return '`' + content() + '`'; }
      if (/^h[1-6]$/.test(tag)) { return '\n' + '#'.repeat(Number(tag[1])) + ' ' + content() + '\n'; }
      if (tag === 'strong' || tag === 'b') { return '**' + content() + '**'; }
      if (tag === 'em' || tag === 'i') { return '*' + content() + '*'; }
      if (tag === 'br') { return '\n'; }
      if (tag === 'hr') { return '\n---\n'; }
      if (tag === 'li') { return '\n' + (node.parentElement?.localName === 'ol'
        ? (Array.from(node.parentElement.children).indexOf(node) + 1) + '. ' : '- ') + content().trim(); }
      if (tag === 'blockquote') { return '\n' + content().trim().split('\n').map(line => '> ' + line).join('\n') + '\n'; }
      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        return /^https?:\/\//.test(href) ? '[' + content() + '](' + href + ')' : content();
      }
      if (tag === 'table') {
        const rows = Array.from(node.querySelectorAll('tr'), row => Array.from(row.children, cell => walk(cell).trim()));
        if (!rows.length) { return ''; }
        return '\n' + rows.map((row, index) => '| ' + row.join(' | ') + ' |'
          + (index === 0 ? '\n| ' + row.map(() => '---').join(' | ') + ' |' : '')).join('\n') + '\n';
      }
      const value = content();
      return ['p', 'div', 'section', 'ul', 'ol'].includes(tag) ? '\n' + value + '\n' : value;
    };
    return walk(root).replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------------------------------------------------------------------------
  // Site configuration
  // ---------------------------------------------------------------------------

  const SITES = {
    ChatGPT: {
      hosts: ['chatgpt.com'],
      input: { text: { selector: '#prompt-textarea, [data-testid="text-input"], [role="textbox"][contenteditable="true"]', method: 'chatgpt' },
        send: '#composer-submit-button, button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], form button[type="submit"]',
        message: '[data-message-author-role="user"]' },
      output: { type: 'network', regex: /\/backend-api\/(?:f\/)?conversation\/?(?:\?|$)/, parser: parseChatGPT },
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
      if (config.hosts.some((entry) => host.includes(entry))) { return { name, ...config }; }
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
      this.activeStreams = new Map();
      this.activeRequests = new Map();
      this.setupFetch();
      this.setupXHR();
    }

    clearIdle() {
      this.idleToken = null;
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    }

    beginRequest(taskId) {
      this.clearIdle();
      if (this.connector.currentTaskId === taskId && this.connector.config.name === 'Gemini') {
        this.connector.geminiTransportDone = false;
        this.connector.cancelGeminiCompletion?.();
        this.connector.cancelGeminiCompletion = null;
      }
      this.activeRequests.set(taskId, (this.activeRequests.get(taskId) || 0) + 1);
      let released = false;
      return () => {
        if (released) { return; }
        released = true;
        const remaining = (this.activeRequests.get(taskId) || 1) - 1;
        if (remaining) { this.activeRequests.set(taskId, remaining); }
        else { this.activeRequests.delete(taskId); }
        if (this.connector.currentTaskId === taskId) { this.scheduleIdle(taskId); }
      };
    }

    scheduleIdle(taskId) {
      this.clearIdle();
      if (this.connector.config.name === 'Gemini') {
        this.connector.scheduleGeminiCompletion();
        this.connector.startDomWatcher();
        return;
      }
      if (this.connector.config.name === 'ChatGPT') {
        this.connector.startDomWatcher();
        return;
      }
      // A model/tool pause is not transport completion. Only arm an idle
      // fallback after every response stream belonging to this task closes.
      if (this.activeStreams.get(taskId) || this.activeRequests.get(taskId)) { return; }
      // Pace through the timer-worker sleep so a hidden tab does not stretch
      // the idle-completion wait; a token cancels superseded schedules.
      const token = (this.idleToken = {});
      sleep(NETWORK_IDLE_COMPLETE_MS).then(() => {
        if (this.idleToken !== token) { return; }
        this.idleToken = null;
        const connector = this.connector;
        if (!connector.isRunning || connector.currentTaskId !== taskId
          || connector.doneSignal || !connector.accumulatedText
          || this.activeStreams.get(taskId) || this.activeRequests.get(taskId)) { return; }
        connector.onNewData(connector.accumulatedText, true, 'network');
      });
    }

    parseOutput(outputConfig, allText) {
      const parsed = outputConfig?.parser?.(allText);
      const hasDone = parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'done');
      return {
        text: typeof parsed === 'string' ? parsed : String(parsed?.text || ''),
        done: hasDone ? Boolean(parsed.done) : genericNetworkDone(allText),
        waitingForResponse: Boolean(parsed?.waitingForResponse),
        hasAnswer: parsed?.hasAnswer !== false,
      };
    }

    handleCapture(allText, taskId) {
      if (this.connector.currentTaskId !== taskId || !this.connector.isRunning) { return; }
      if (this.connector.lastTask) {
        this.connector.lastTask.networkCaptures += 1;
        this.connector.lastTask.networkChars = allText.length;
      }
      const outputConfig = this.connector.config.output;
      if (!outputConfig?.parser) { return; }
      const parsed = this.parseOutput(outputConfig, allText);
      if (this.connector.lastTask) { this.connector.lastTask.networkDone = parsed.done; }
      if (this.connector.config.name === 'Gemini') {
        const connector = this.connector;
        if (connector.doneSignal) { return; }
        connector.geminiTransportDone = parsed.done;
        // Gemini may stop painting after its first sentence in a hidden tab.
        // Its response stream already contains Markdown/TeX; do not wait for
        // stale DOM to catch up or let that DOM replace the stream snapshot.
        if (parsed.text && parsed.hasAnswer) {
          connector.geminiNetworkText = parsed.text;
          connector.onNewData(parsed.text, false, 'network');
        }
        connector.scheduleGeminiCompletion();
        connector.startDomWatcher();
        return;
      }
      if (this.connector.config.name === 'ChatGPT') {
        // A message-level end or a closed transport is only supporting
        // evidence. ChatGPT can continue in another message/stream.
        this.connector.chatGPTTransportDone = parsed.done;
        if (parsed.text) { this.connector.onNewData(parsed.text, false, 'network'); }
        this.connector.startDomWatcher();
        return;
      }
      if (parsed.text) {
        this.connector.onNewData(parsed.text, parsed.done, 'network');
        if (parsed.done || parsed.waitingForResponse) { this.clearIdle(); }
        else { this.scheduleIdle(taskId); }
      } else if (parsed.done && this.connector.accumulatedText) {
        this.connector.onNewData(this.connector.accumulatedText, true, 'network');
      }
    }

    setupFetch() {
      const originalFetch = unsafeWindow && typeof unsafeWindow.fetch === 'function'
        ? unsafeWindow.fetch : null;
      if (!originalFetch) { return; } // environments without fetch (tests, old engines)
      const self = this;
      const proxy = new Proxy(originalFetch, {
        apply(target, thisArg, args) {
          const fetchPromise = Reflect.apply(target, thisArg, args);
          const input = args[0];
          const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input?.url || ''));
          if (urlStr.includes('zotero-research')) { return fetchPromise; }
          const outputConfig = self.connector.config?.output;
          if (self.connector.isRunning && self.connector.currentTaskId
            && outputConfig?.type === 'network' && outputConfig.regex?.test(urlStr)) {
            const taskId = self.connector.currentTaskId;
            const release = self.beginRequest(taskId);
            fetchPromise.then(async (response) => {
              if (!response.ok) { return; }
              try {
                const cloned = response.clone();
                if (cloned.body) { await self.readStream(cloned.body, taskId); }
              } catch (_) { /* ignore */ }
            }).catch(() => {}).finally(release);
          }
          return fetchPromise;
        },
      });
      proxy.toString = () => 'function fetch() { [native code] }';
      unsafeWindow.fetch = proxy;
    }

    async readStream(stream, taskId) {
      const reader = stream.getReader();
      this.clearIdle();
      this.activeStreams.set(taskId, (this.activeStreams.get(taskId) || 0) + 1);
      const decoder = new TextDecoder();
      let allText = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { break; }
          if (this.connector.currentTaskId !== taskId) { break; }
          allText += decoder.decode(value, { stream: true });
          this.handleCapture(allText, taskId);
        }
        const tail = decoder.decode();
        if (tail) {
          allText += tail;
          this.handleCapture(allText, taskId);
        }
      } catch (error) {
        if (error?.name !== 'AbortError') { console.warn('[Zotero relay] readStream', error); }
      } finally {
        const remaining = (this.activeStreams.get(taskId) || 1) - 1;
        if (remaining) { this.activeStreams.set(taskId, remaining); }
        else { this.activeStreams.delete(taskId); }
        try { reader.releaseLock(); } catch (_) {}
        if (this.connector.currentTaskId === taskId && !this.connector.doneSignal
          && this.connector.accumulatedText) { this.scheduleIdle(taskId); }
      }
    }

    setupXHR() {
      // Tampermonkey may expose a different constructor inside its sandbox.
      // Hook the page's XHR, as setupFetch already does for page fetch.
      const PageXHR = unsafeWindow?.XMLHttpRequest || XMLHttpRequest;
      const originalOpen = PageXHR.prototype.open;
      const self = this;
      PageXHR.prototype.open = function (method, url, ...rest) {
        const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : String(url));
        if (!urlStr.includes('zotero-research')) {
          const outputConfig = self.connector.config?.output;
          if (self.connector.isRunning && self.connector.currentTaskId
            && outputConfig?.type === 'network' && outputConfig.regex?.test(urlStr)) {
            const taskId = self.connector.currentTaskId;
            let release = null;
            const started = () => { release = self.beginRequest(taskId); };
            const captured = function () {
              if (self.connector.currentTaskId !== taskId) { return; }
              if (![3, 4].includes(this.readyState)) { return; }
              try { self.handleCapture(this.responseText, taskId); }
              catch (error) { console.warn('[Zotero relay] xhr parse', error); }
            };
            const ended = () => {
              if (release) { release(); }
              this.removeEventListener('loadstart', started);
              this.removeEventListener('readystatechange', captured);
              this.removeEventListener('loadend', ended);
            };
            this.addEventListener('loadstart', started, { once: true });
            this.addEventListener('readystatechange', captured);
            this.addEventListener('loadend', ended, { once: true });
          }
        }
        return originalOpen.apply(this, [method, url, ...rest]);
      };
      PageXHR.prototype.open.toString = () => 'function open() { [native code] }';
    }
  }

  // ---------------------------------------------------------------------------
  // Connector: protocol against the Zotero endpoint
  // ---------------------------------------------------------------------------

  function gmRequest(payload, timeout = 10000) {
    let abortFn = null;
    const promise = new Promise((resolve, reject) => {
      let req, settled = false, cancelDeadline = () => {};
      const finish = (error, value) => {
        if (settled) { return; }
        settled = true;
        cancelDeadline();
        if (error) { reject(error); } else { resolve(value); }
      };
      const abortTransport = () => { try { req?.abort(); } catch (_) {} };
      const expire = () => {
        if (settled) { return; }
        if (String(payload.action).toLowerCase() === 'poll') { finish(null, {}); }
        else { finish(new Error('Timeout: Zotero 请求超过 ' + timeout + 'ms')); }
        abortTransport();
      };
      abortFn = () => { finish(new DOMException('Aborted', 'AbortError')); abortTransport(); };
      // Tampermonkey anonymous:true enforces fetch; Chrome ignores its native
      // timeout in fetch mode. A cancellable independent deadline is required.
      cancelDeadline = scheduleDeadline(expire, timeout);
      try { req = GM_xmlhttpRequest({
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
          if (settled) { return; }
          if (res.status >= 200 && res.status < 300) {
            try { finish(null, JSON.parse(res.responseText)); }
            catch (error) { finish(error); }
          } else {
            const error = new Error(res.statusText || `HTTP ${res.status}`);
            error.status = res.status;
            finish(error);
          }
        },
        onerror: () => finish(new Error('无法连接 Zotero 本机端点')),
        onabort: () => finish(new DOMException('Aborted', 'AbortError')),
        ontimeout: expire,
      }); } catch (error) { finish(error); }
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
      if (config.output?.type === 'network') { this.proxy = new NetworkProxy(this); }
      this.sessionSecret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      this.isConnected = false;
      this.isRunning = false;
      this.currentTaskId = null;
      this.accumulatedText = '';
      this.lastDataSource = null;
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
      this.runtime = {
        id: TAB_ID, startedAt: new Date().toISOString(), sourceRevision: 'relay-background-3',
        version: GM_info.script.version, handler: GM_info.scriptHandler || 'unknown',
        timeOrigin: performance.timeOrigin || null,
        navigationType: performance.getEntriesByType?.('navigation')?.[0]?.type || 'unknown',
      };
      this.traceEvents = [];
      this.traceStorageAvailable = true;
      this.recordDiagnostic('startup');
      for (const event of ['pagehide', 'pageshow']) {
        window.addEventListener(event, () => this.recordDiagnostic(event));
      }
    }

    // Diagnostic evidence only: never restore task execution, prompts or
    // session credentials. sessionStorage survives reloads in this same tab.
    readDiagnosticHistory() {
      try {
        const raw = sessionStorage.getItem(DIAGNOSTIC_TRACE_KEY) || '[]';
        if (raw.length > 48000) { return []; }
        const entries = JSON.parse(raw);
        return Array.isArray(entries) ? entries.filter(entry => entry?.runtime
          && typeof entry.runtime.id === 'string').slice(0, 4) : [];
      } catch (_) { this.traceStorageAvailable = false; return []; }
    }

    recordDiagnostic(event, throttled = false) {
      const now = Date.now();
      if (throttled && now - (this.lastTraceAt || 0) < 5000) { return; }
      this.lastTraceAt = now;
      this.traceEvents.push({ at: new Date(now).toISOString(), event });
      this.traceEvents = this.traceEvents.slice(-20);
      // Freeze the snapshot: later mutations must not rewrite prior evidence.
      const entry = JSON.parse(JSON.stringify({
        runtime: this.runtime, recordedAt: new Date(now).toISOString(), events: this.traceEvents,
        lastTask: this.lastTask || null, lastUpload: this.lastUpload || null,
        lastPoll: this.lastPoll || null, lastTaskPoll: this.lastTaskPoll || null,
        connection: this.lastConnection || null,
        activeTaskId: this.currentTaskId, connected: this.isConnected, running: this.isRunning,
        heartbeatError: this.lastHeartbeatError || '',
      }));
      this.lastTrace = entry;
      const entries = [entry, ...this.readDiagnosticHistory().filter(old => old.runtime.id !== this.runtime.id)].slice(0, 4);
      try {
        const serialized = JSON.stringify(entries);
        if (serialized.length > 48000) { throw new Error('diagnostic capacity'); }
        sessionStorage.setItem(DIAGNOSTIC_TRACE_KEY, serialized);
        this.traceStorageAvailable = true;
      } catch (_) { this.traceStorageAvailable = false; }
    }

    setTaskPhase(phase) {
      if (this.lastTask) { this.lastTask.phase = phase; }
      this.recordDiagnostic('task-' + phase);
    }

    // --- cross-tab lock: only one connected tab per browser ---
    getLock() { try { return JSON.parse(GM_getValue(LOCK_KEY, '{}')) || {}; } catch { return {}; } }
    acquireLock() {
      const lock = this.getLock();
      if (lock.isLocked && lock.expiresAt > Date.now()) { return lock.tabId === TAB_ID; }
      return this.forceLock();
    }
    forceLock() {
      GM_setValue(LOCK_KEY, JSON.stringify({ isLocked: true, tabId: TAB_ID, expiresAt: Date.now() + 60000 }));
      return true;
    }
    releaseLock() {
      const lock = this.getLock();
      if (lock.tabId === TAB_ID) { GM_setValue(LOCK_KEY, JSON.stringify({ isLocked: false, tabId: null })); }
    }
    hasLock() { const lock = this.getLock(); return lock.isLocked && lock.tabId === TAB_ID; }

    initDom() {
      if (this.domInitialized) { return; }
      this.domInitialized = true;
      createBadge();
      GM_registerMenuCommand('🔗 连接 Zotero', () => { this.startConnection(true); });
      GM_registerMenuCommand('🎊 断开 Zotero', () => { this.isRunning = false; void this.disconnect(); });
      GM_registerMenuCommand('联动诊断（复制给开发者）', () => this.showDiagnostic());
      GM_addValueChangeListener(LOCK_KEY, (_name, _old, _next, remote) => {
        if (remote && this.isRunning && !this.hasLock()) {
          void this.disconnect();
          setStatus('已切换到另一网页；从脚本菜单可重新连接');
        }
      });
      window.addEventListener('beforeunload', () => { void this.disconnect(); });
      this.lockTimer = setInterval(() => {
        if (this.isRunning && this.hasLock()) { this.forceLock(); }
      }, 10000);
      const connectHere = new URLSearchParams(location.hash.slice(1)).get('zra-connect') === '1';
      if (connectHere) { history.replaceState(null, document.title, location.pathname + location.search); }
      this.startConnection(connectHere);
    }

    startConnection(force = false) {
      if (force ? this.forceLock() : this.acquireLock()) {
        if (!this.isRunning) {
          this.sessionSecret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        }
        this.isRunning = true;
        void this.handshake();
      } else { setStatus('另一标签页已连接 Zotero；从脚本菜单可切换'); }
    }

    handshake(options = {}) {
      if (!this.isRunning || !this.hasLock()) { return Promise.resolve(); }
      if (this.handshakePromise) { return this.handshakePromise; }
      const pending = this.performHandshake(options).finally(() => {
        if (this.handshakePromise === pending) { this.handshakePromise = null; }
      });
      this.handshakePromise = pending;
      return pending;
    }

    async performHandshake({ silent = false } = {}) {
      const generation = this.connectionGeneration;
      const secret = this.sessionSecret;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.killPoll();
      this.recordDiagnostic('connect-start');
      try {
        const res = await gmRequest({
          action: 'connect',
          ai: this.config.name,
          url: location.href,
          sessionSecret: secret,
          version: GM_info.script.version,
        }, 5000).promise;
        this.lastConnection = { at: new Date().toISOString(), status: res.status || '', error: res.error || '' };
        this.recordDiagnostic('connect-response');
        if (!this.isRunning || !this.hasLock() || generation !== this.connectionGeneration) {
          // A connect can finish after the user disconnects. Undo only this
          // attempt's session; the server leaves any newer page untouched.
          if (res.status === 'connected') {
            await gmRequest({ action: 'disconnect', sessionSecret: secret }, 2000).promise;
          }
          return;
        }
        if (res.status !== 'connected') { throw new Error(res.error || 'Zotero 未确认连接'); }
        if (res.status === 'connected') {
          this.isConnected = true;
          this.supportsHeartbeat = res.capabilities?.includes('task-heartbeat') === true;
          this.startHeartbeatLoop();
          if (!silent) { notify('Zotero：联动成功'); }
          setStatus('已连接，等待 Zotero 消息');
          if (this.currentTaskId && this.hasPendingData) { this.flushData(); }
          else { this.startPolling(); }
        }
      } catch (error) {
        if (!this.isRunning || !this.hasLock() || generation !== this.connectionGeneration) { return; }
        this.isConnected = false;
        const detail = error?.status ? `HTTP ${error.status}` : String(error?.message || error || '');
        if (!silent) { notify(`Zotero：联动失败（${detail}）`); }
        setStatus(`连接 Zotero 失败：${detail}，5 秒后重试`);
        if (this.isRunning) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isRunning) { void this.handshake({ silent: true }); }
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
      this.heartbeatToken = null;
      this.killPoll();
      this.resetTaskState('disconnected');
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.releaseLock();
      setStatus('未连接');
      if (!owned) { return null; }
      try {
        return await gmRequest({ action: 'disconnect', sessionSecret: this.sessionSecret }, 2000).promise;
      } catch (_) { return null; }
    }

    killPoll() {
      if (this.pollReq) { this.pollReq.abort(); this.pollReq = null; }
      if (this.pollDelayTimer) { clearTimeout(this.pollDelayTimer); this.pollDelayTimer = null; }
    }

    schedulePolling() {
      if (this.pollDelayTimer) { clearTimeout(this.pollDelayTimer); }
      this.pollDelayTimer = setTimeout(() => {
        this.pollDelayTimer = null;
        if (!this.isSendingUpdate) { this.startPolling(); }
      }, 500);
    }

    async startPolling() {
      if (this.currentTaskId || this.isSendingUpdate || this.pollReq || !this.isConnected || !this.isRunning || !this.hasLock()) { return; }
      const request = gmRequest({ action: 'poll', sessionSecret: this.sessionSecret }, POLL_TIMEOUT_MS + 5000);
      this.pollReq = request;
      try {
        const res = await request.promise;
        this.lastPoll = { at: new Date().toISOString(), taskId: res.task?.id || null,
          error: res.error || '', accepted: this.pollReq === request && this.isRunning && Boolean(this.hasLock()) };
        if (res.task) { this.lastTaskPoll = this.lastPoll; }
        this.recordDiagnostic(res.task ? 'poll-task' : 'poll-response');
        if (this.pollReq !== request || !this.isRunning || !this.hasLock()) { return; }
        this.pollReq = null;
        if (res.error === 'SESSION_EXPIRED') {
          this.isConnected = false;
          this.handshake({ silent: true });
          return;
        }
        if (res.task) { this.executeTask(res.task); }
        this.startPolling();
      } catch (error) {
        if (this.pollReq !== request || !this.isRunning || !this.hasLock()) { return; }
        this.lastPoll = { at: new Date().toISOString(), error: String(error?.message || error).slice(0, 300) };
        this.recordDiagnostic('poll-error');
        this.pollReq = null;
        if (error?.name === 'AbortError') { return; }
        if (this.isSendingUpdate) { return; }
        if (isEndpointMissing(error)) {
          this.isConnected = false;
          this.handshake({ silent: true });
          return;
        }
        if (this.isConnected && this.isRunning) { setTimeout(() => this.startPolling(), 1000); }
      }
    }

    resetTaskState(reason = 'reset') {
      if (this.currentTaskId && this.lastTask) {
        this.lastTask.phase = 'finished';
        this.lastTask.endReason = reason;
        this.lastTask.finishedAt = new Date().toISOString();
        this.lastTask.captureSource = this.lastDataSource;
        this.lastTask.capturedChars = this.accumulatedText.length;
      }
      this.proxy?.clearIdle();
      this.cancelGeminiCompletion?.();
      this.cancelGeminiCompletion = null;
      this.cancelUpdateRetry?.();
      this.cancelUpdateRetry = null;
      this.currentTaskId = null;
      this.doneSignal = false;
      this.accumulatedText = '';
      this.lastDataSource = null;
      this.hasPendingData = false;
      this.awaitingManualSend = false;
      this.manualBaseline = null;
      // Stale timing from a finished task must not leak into the next one.
      this.taskStartedAt = null;
      this.chatGPTBaseline = null;
      this.chatGPTUser = null;
      this.chatGPTStableText = '';
      this.chatGPTStableSince = null;
      this.chatGPTTransportDone = false;
      this.geminiBaseline = null;
      this.geminiUser = null;
      this.geminiStableText = '';
      this.geminiStableSince = null;
      this.geminiTransportDone = false;
      this.geminiNetworkText = '';
      this.stopDomWatcher();
      this.recordDiagnostic('reset-' + reason);
    }

    onNewData(text, isDone, source = 'unknown') {
      if (!this.isRunning) { return; }
      const rawText = String(text || '');
      // Network parsing and visible-DOM fallback converge here. Keep the
      // cleanup at this shared boundary as well, otherwise a manually
      // recovered ChatGPT turn bypasses parseChatGPT and leaks filecite tags.
      const nextText = this.config.name === 'ChatGPT'
        ? stripChatGPTInternalCitations(rawText) : rawText;
      const networkData = source === 'network';
      const chatGPTDom = this.config.name === 'ChatGPT' && source === 'chatgpt-dom';
      const geminiDom = this.config.name === 'Gemini' && source === 'gemini-dom';
      if (networkData && this.lastDataSource === 'chatgpt-dom') { return; }
      if (geminiDom && this.geminiNetworkText && !isDone) { return; }
      if (source === 'dom' && this.lastDataSource === 'network') { return; }
      if (networkData && this.config.output?.type === 'network' && !['ChatGPT', 'Gemini'].includes(this.config.name)) { this.stopDomWatcher(); }
      // Network parsers return the latest complete value, so even a shorter
      // replace/snapshot is authoritative. Before network data arrives,
      // retain the old length guard for unknown/DOM-compatible callers.
      const stableText = networkData || chatGPTDom || geminiDom ? nextText
        : (nextText.length < this.accumulatedText.length
          ? this.accumulatedText : (nextText || this.accumulatedText));
      const nextDone = Boolean(isDone);
      if (chatGPTDom) { this.lastDataSource = 'chatgpt-dom'; }
      else if (geminiDom) { this.lastDataSource = 'gemini-dom'; }
      else if (networkData) { this.lastDataSource = 'network'; }
      else if (source === 'dom' && this.lastDataSource !== 'network') { this.lastDataSource = 'dom'; }
      if (stableText === this.accumulatedText && nextDone === this.doneSignal) { return; }
      this.clearManualFallback();
      this.accumulatedText = stableText;
      if (this.lastTask) {
        this.lastTask.phase = 'receiving';
        this.lastTask.captureSource = this.lastDataSource;
        this.lastTask.capturedChars = stableText.length;
      }
      if (nextDone) {
        this.doneSignal = true;
        if (this.taskStartedAt) {
          setStatus('回答完成 ' + ((Date.now() - this.taskStartedAt) / 1000).toFixed(1) + 's');
        }
      }
      this.recordDiagnostic(nextDone ? 'answer-complete' : 'answer-progress', !nextDone);
      this.hasPendingData = true;
      this.flushData();
    }

    flushData() {
      if (this.isSendingUpdate || !this.hasPendingData) { return; }
      this.cancelUpdateRetry?.();
      this.cancelUpdateRetry = null;
      if (this.pollDelayTimer) { clearTimeout(this.pollDelayTimer); this.pollDelayTimer = null; }
      if (this.pollReq) { this.killPoll(); }
      this.performUpdate();
    }

    async performUpdate() {
      const tid = this.currentTaskId;
      if (!tid) { return; }
      this.isSendingUpdate = true;
      this.hasPendingData = false;
      const textToSend = this.accumulatedText;
      const doneToSend = this.doneSignal;
      const startedAt = Date.now();
      if (this.lastTask) { this.lastTask.updateAttempts = (this.lastTask.updateAttempts || 0) + 1; }
      this.recordDiagnostic('update-start', !doneToSend);
      try {
        const response = await gmRequest({
          action: 'update', id: tid, text: textToSend || '', isDone: doneToSend,
          sessionSecret: this.sessionSecret,
        }, 8000).promise;
        if (this.currentTaskId !== tid) { return; }
        if (this.lastTask) {
          this.lastTask.lastUpdate = { ok: response?.ok === true, error: response?.error || '',
            textLength: textToSend.length, isDone: doneToSend,
            durationMs: Date.now() - startedAt, recovered: response?.recovered === true };
        }
        this.recordDiagnostic('update-response', !doneToSend && !response?.error);
        if (response?.error === 'SESSION_EXPIRED') {
          this.isSendingUpdate = false;
          this.hasPendingData = true;
          this.handshake({ silent: true });
          return;
        }
        if (['TASK_CLOSED', 'UNKNOWN_TASK'].includes(response?.error)) {
          this.isSendingUpdate = false;
          this.resetTaskState(response.error.toLowerCase());
          this.startPolling();
          return;
        }
        if (!response?.ok) { throw new Error(response?.error || 'Zotero 未确认收到回答'); }
        this.isSendingUpdate = false;
        if (doneToSend) {
          this.resetTaskState('delivered');
          this.startPolling();
        } else if (this.hasPendingData) { this.performUpdate(); }
        else { this.schedulePolling(); }
      } catch (error) {
        if (this.currentTaskId !== tid) { return; }
        if (this.lastTask) {
          this.lastTask.updateError = String(error?.message || error).slice(0, 300);
          this.lastTask.lastUpdate = { ok: false, error: this.lastTask.updateError,
            textLength: textToSend.length, isDone: doneToSend, durationMs: Date.now() - startedAt };
        }
        this.recordDiagnostic('update-error');
        this.isSendingUpdate = false;
        if (this.currentTaskId === tid && this.isRunning) {
          this.hasPendingData = true;
          if (isEndpointMissing(error)) { this.handshake({ silent: true }); }
          else {
            this.cancelUpdateRetry?.();
            this.cancelUpdateRetry = scheduleDeadline(() => {
              this.cancelUpdateRetry = null;
              if (this.currentTaskId === tid && this.isRunning) { this.flushData(); }
            }, 500);
          }
        }
      }
    }

    // --- task execution ---
    startHeartbeatLoop() {
      if (!this.supportsHeartbeat || this.heartbeatToken) { return; }
      const token = (this.heartbeatToken = {});
      void (async () => {
        while (this.heartbeatToken === token && this.isRunning && this.isConnected) {
          // Use the existing worker pacer; background page intervals may be
          // suspended while the user is reading in Zotero instead of Chrome.
          await sleep(10000);
          if (this.heartbeatToken !== token || !this.isRunning || !this.isConnected) { break; }
          if (this.hasLock()) { this.forceLock(); }
          await this.sendHeartbeat();
        }
        if (this.heartbeatToken === token) { this.heartbeatToken = null; }
      })();
    }

    async sendHeartbeat() {
      const id = this.currentTaskId;
      // Never send the new message shape to an old XPI: it would interpret
      // the missing text as an empty answer. Negotiate support at connect.
      if (!id || !this.isRunning || !this.isConnected || !this.supportsHeartbeat) { return; }
      if (this.taskStartedAt && Date.now() - this.taskStartedAt > TASK_WAIT_LIMIT_MS) {
        this.stopDomWatcher();
        await this.reportFailure('网页回答等待超时（20 分钟）；已保留收到的内容，但未确认回答完整，请检查网页。');
        return;
      }
      try {
        const response = await gmRequest({ action: 'update', id, heartbeat: true, sessionSecret: this.sessionSecret }, 5000).promise;
        if (this.currentTaskId !== id) { return; }
        this.lastHeartbeatAt = Date.now();
        this.lastHeartbeatError = response.error || '';
        if (this.lastTask) {
          this.lastTask.heartbeatReplies += 1;
          this.lastTask.lastHeartbeatComplete = response.complete === true;
        }
        this.recordDiagnostic('heartbeat-response');
        if (response.complete && response.recoverable) {
          // A suspended page can resume after the sidebar timeout. Re-deliver
          // captured text only; never re-upload or re-send the model prompt.
          if (this.accumulatedText) { this.hasPendingData = true; this.flushData(); }
        } else if (response.complete) {
          this.resetTaskState('relay-completed'); this.isSendingUpdate = false; this.startPolling();
        }
      } catch (error) {
        this.lastHeartbeatError = String(error?.message || error).slice(0, 300);
        this.recordDiagnostic('heartbeat-error');
      }
    }

    async executeTask(task) {
      try {
        this.killPoll();
        this.isSendingUpdate = true;
        this.resetTaskState('replaced');
        this.currentTaskId = task.id;
        this.taskStartedAt = Date.now();
        this.lastUpload = null;
        this.lastHeartbeatAt = null;
        this.lastHeartbeatError = '';
        this.lastTask = {
          id: task.id,
          startedAt: new Date(this.taskStartedAt).toISOString(), phase: 'received',
          imageCount: (task.messages || []).filter(message => message.type === 'image' && message.data).length,
          sendAcknowledged: false, captureSource: null, capturedChars: 0,
          networkCaptures: 0, networkChars: 0, heartbeatReplies: 0,
        };
        this.recordDiagnostic('task-received');
        if (this.config.name === 'ChatGPT') { this.captureChatGPTTurn(); }
        if (this.config.name === 'Gemini') { this.captureGeminiTurn(); }
        if (this.config.name === 'ChatGPT' && this.hasStreamingControl()) {
          throw new Error('ChatGPT 仍在生成上一轮回答，请等它结束或在网页停止后再发送。');
        }
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
          this.setTaskPhase('uploading');
          const channel = await this.deliverImages(images);
          if (this.currentTaskId !== task.id) { return; }
          if (!channel) {
            this.setTaskPhase('waiting-manual-send');
            this.isSendingUpdate = false;
            this.manualBaseline = this.captureBaseline(this.config.input.message);
            this.awaitingManualSend = true;
            this.startDomWatcher();
            setStatus('网页未确认截图；请先检查预览，已有图片时无需再次粘贴');
            notify('网页未确认截图：请检查输入框；已有图片请直接发送，不要重复粘贴。没有图片时再 Ctrl+V；文字已自动填好。');
            if (prompt) { await this.fillInput(this.config.input.text, prompt); }
            await this.notifySidebar('网页未确认截图：请先检查网页预览；已有图片时直接发送，无需再次粘贴。没有图片时再 Ctrl+V，问题文字已自动填好。');
            return;
          }
        }
        const inputConfig = this.config.input.text;
        this.setTaskPhase('filling');
        let filled = prompt ? await this.fillInput(inputConfig, prompt) : true;
        if (prompt && (!filled || !this.inputAccepts(inputConfig, prompt))) {
          filled = await this.refillByReplace(inputConfig, prompt);
        }
        if (this.currentTaskId !== task.id) { return; }
        if (this.taskStartedAt) {
          setStatus('输入完成 ' + ((Date.now() - this.taskStartedAt) / 1000).toFixed(1) + 's，正在发送…');
        }
        if (prompt && (!filled || !this.inputAccepts(inputConfig, prompt))) {
          this.isSendingUpdate = false;
          await this.reportFailure('无法把问题填入网页 AI 输入框（页面可能改版），请手动粘贴发送。');
          return;
        }
        this.setTaskPhase('sending');
        const sent = await this.handleSend(this.config.input.send, this.config.input.message);
        if (this.currentTaskId !== task.id) { return; }
        if (!sent) {
          this.isSendingUpdate = false;
          await this.reportFailure('未能确认网页 AI 发送；请手动点击发送按钮。');
          return;
        }
        this.lastTask.sendAcknowledged = !this.awaitingManualSend;
        this.setTaskPhase(this.awaitingManualSend ? 'waiting-manual-send' : 'waiting-answer');
        if (this.config.output?.type === 'dom' || ['ChatGPT', 'Gemini'].includes(this.config.name)) { this.startDomWatcher(); }
        this.isSendingUpdate = false;
        this.flushData();
      } catch (error) {
        if (this.currentTaskId !== task.id) { return; }
        this.isSendingUpdate = false;
        await this.reportFailure(String(error?.message || error || '任务执行失败'));
      }
    }

    async reportFailure(message) {
      const id = this.currentTaskId;
      try {
        await gmRequest({
          action: 'update', id, text: this.accumulatedText || '', isDone: true, failed: message,
          sessionSecret: this.sessionSecret,
        }, 8000).promise;
      } catch (_) { /* the sidebar shows its pending state if the bridge is gone */ }
      if (this.currentTaskId !== id) { return; }
      setStatus('本次中继失败：' + message);
      notify(message);
      this.resetTaskState('failed');
      this.schedulePolling();
    }

    // --- input strategies (subset of the reference connector) ---
    /**
     * Resolve with the first truthy check() result. Re-checks run on every
     * DOM mutation and on paced sleep ticks. MutationObserver callbacks are
     * microtasks: they run at full speed in background tabs, immune to the
     * timer clamping that stalls a hidden page (and independent of the
     * timer worker, which strict page CSP can block on some sites).
     */
    async waitForValue(check, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const recheck = () => {
        try { return check() || null; } catch (_) { return null; }
      };
      let value = recheck();
      if (value) { return value; }
      while (Date.now() < deadline) {
        value = await new Promise((resolve) => {
          let settled = false;
          let observer = null;
          const finish = (result) => {
            if (settled) { return; }
            settled = true;
            if (observer) { try { observer.disconnect(); } catch (_) { } }
            resolve(result);
          };
          if (typeof MutationObserver === 'function' && document.documentElement) {
            try {
              observer = new MutationObserver(() => { const hit = recheck(); if (hit) { finish(hit); } });
              observer.observe(document.documentElement, {
                childList: true, subtree: true, attributes: true, characterData: true,
              });
            } catch (_) { observer = null; }
          }
          const tick = Math.max(20, Math.min(250, deadline - Date.now()));
          sleep(tick).then(() => finish(recheck()));
        });
        if (value) { return value; }
      }
      return null;
    }

    async waitForCondition(check, timeout) {
      return this.waitForValue(check, timeout);
    }

    findUsable(selector) {
      try {
        for (const element of document.querySelectorAll(selector)) {
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') { continue; }
          if (element.getBoundingClientRect().width <= 0) { continue; }
          if (element.disabled || element.getAttribute('aria-disabled') === 'true') { continue; }
          return element;
        }
      } catch (_) { /* invalid selector */ }
      return null;
    }

    readText(el) {
      if (!el) { return ''; }
      return 'value' in el ? String(el.value || '') : String(el.innerText || el.textContent || '');
    }

    matchesInput(el, expected) {
      const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').trim();
      return normalize(this.readText(el)) === normalize(expected);
    }

    pasteEvent(transfer) {
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
      // Firefox can ignore ClipboardEventInit.clipboardData. Preserve the
      // same native DataTransfer so page paste handlers receive the files/text.
      if (!event.clipboardData
        || (transfer.files?.length && event.clipboardData.files?.length !== transfer.files.length)
        || (transfer.getData?.('text/plain') && event.clipboardData.getData('text/plain') !== transfer.getData('text/plain'))) {
        Object.defineProperty(event, 'clipboardData', { value: transfer });
      }
      return event;
    }

    async fillInput(inputConfig, text) {
      if (!inputConfig) { return false; }
      const taskId = this.currentTaskId;
      const el = await this.waitForCondition(() => this.findUsable(inputConfig.selector), 5000)
        || document.querySelector(inputConfig.selector);
      if (!el || this.currentTaskId !== taskId) { return false; }
      el.focus();
      if (inputConfig.method === 'chatgpt') {
        // ProseMirror must see a paste transaction: mutating textContent can
        // show the right words while its internal document (and Send) stays empty.
        if (!('value' in el)) {
          const selection = window.getSelection();
          const range = document.createRange(); range.selectNodeContents(el);
          selection?.removeAllRanges(); selection?.addRange(range);
          let accepted = false;
          try {
            const transfer = new DataTransfer(); transfer.setData('text/plain', text);
            const event = this.pasteEvent(transfer);
            accepted = !el.dispatchEvent(event) || event.defaultPrevented;
          } catch (_) { /* no paste support: compatibility path below */ }
          if (accepted) {
            const committed = await this.waitForValue(() => this.currentTaskId !== taskId
              || this.inputAccepts(inputConfig, text), 5000);
            selection?.removeAllRanges();
            if (this.currentTaskId !== taskId) { return false; }
            if (!committed) { throw new Error('ChatGPT 已接收文字粘贴，但输入框尚未完成更新；请检查网页输入框后再发送。'); }
            return true;
          }
        }
        return this.refillByReplace(inputConfig, text);
      }
      try {
        switch (inputConfig.method) {
          case 'react': {
            const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
            const props = key ? el[key] : null;
            if (props?.onChange) { props.onChange({ target: { value: text }, currentTarget: { value: text } }); }
            else {
              const proto = el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) { setter.call(el, text); } else { el.value = text; }
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            break;
          }
          case 'lexical':
          case 'paste': {
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            el.dispatchEvent(this.pasteEvent(dt));
            break;
          }
          case 'div': {
            el.innerHTML = text.split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('');
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
            break;
          }
          case 'gemini':
          case 'contenteditable': {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            selection?.removeAllRanges();
            selection?.addRange(range);
            let inserted = false;
            try { inserted = document.execCommand('insertText', false, text); } catch { }
            if (!inserted || !this.readText(el).trim()) { el.textContent = text; }
            selection?.removeAllRanges();
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            // Gemini/Angular can replace the editor node; refill the live one.
            const accepted = await this.waitForCondition(() => {
              const current = this.findUsable(inputConfig.selector);
              return current && (this.matchesInput(current, text) || this.readText(current).trim()) ? current : null;
            }, 1500);
            if (!accepted) { return false; }
            break;
          }
          default: {
            el.value = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        await sleep(120);
        return true;
      } catch (error) {
        console.warn('[Zotero relay] fillInput', error);
        return false;
      }
    }

    base64ToBytes(base64) {
      const binary = atob(String(base64 || ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) { bytes[index] = binary.charCodeAt(index); }
      return bytes;
    }

    /** Build transfer files from task images; extension matches media type. */
    buildImageFiles(images) {
      if (typeof DataTransfer !== 'function') { return null; }
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
     * Deliver task images through whichever channel the site actually
     * accepts, verifying each attempt before falling through:
     * 1. a real input[type=file] (files assignment, no trust checks);
     * 2. paste event on the composer (most sites listen document-wide);
     * 3. drop events on the composer (DeepSeek/AIStudio drag targets).
     * Returns the channel name that verified, or null when all failed.
     */
    /** The composer region mutations are scoped to; body as a fallback. */
    composerWatchScope() {
      const input = this.findUsable(this.config.input.text.selector)
        || document.querySelector(this.config.input.text.selector)
        || document.querySelector('textarea, [contenteditable="true"]');
      const fileInput = this.pickFileInput();
      const anchor = input || fileInput;
      // Upload cards are siblings of the text editor, not children of it.
      // Prefer the enclosing form/composer over a nearer input-only wrapper.
      if (!anchor) { return document.body; }
      const form = anchor.closest('form');
      const region = anchor.closest('[data-testid*="composer" i], [id*="composer" i], #thread-bottom-container, .input-area-container, .input-area, [class*="composer" i]');
      const containsHistory = node => node?.querySelector('[data-message-author-role], user-query-content, model-response, main, article');
      // Some composers keep previews ABOVE an inner form. A named surrounding
      // region is preferable, but never expand into the conversation history.
      if (region && !containsHistory(region)) {
        return form?.contains(region) ? form : region;
      }
      const parent = form?.parentElement;
      if (parent && parent !== document.body && parent.localName !== 'main'
        && !containsHistory(parent) && parent.querySelectorAll('form').length === 1) { return parent; }
      return form || anchor.parentElement || document.body;
    }

    /**
     * A file-bearing event makes the site mutate the composer (attachment
     * chip, progress bar, preview URL or test-id). Class-name probes miss
     * most of those, so watch relevant DOM changes during the delivery window.
     */
    startMutationWatch() {
      if (typeof MutationObserver !== 'function') {
        const inert = () => false;
        inert.stop = () => false;
        return inert;
      }
      const scope = this.composerWatchScope();
      const bodyScope = scope === document.body;
      const attachmentSelector = [
        'img[src^="blob:"], img[src^="data:"]',
        '[class*="attach" i], [class*="file-preview" i], [class*="upload" i], [class*="preview" i]',
        '[data-testid*="attach" i], [data-testid*="file" i], [data-testid*="upload" i], [data-testid*="preview" i]',
      ].join(', ');
      const hasAttachmentNode = (node) => {
        if (!node || node.nodeType !== 1) { return false; }
        try { return node.matches(attachmentSelector) || Boolean(node.querySelector(attachmentSelector)); }
        catch (_) { return false; }
      };
      const relevantMutation = (record) => {
        if (record.type === 'attributes') {
          return !bodyScope && ['src', 'data-testid'].includes(record.attributeName);
        }
        if (record.type !== 'childList' || (!record.addedNodes.length && !record.removedNodes.length)) { return false; }
        if (!bodyScope) { return true; }
        return [...record.addedNodes, ...record.removedNodes].some(hasAttachmentNode);
      };
      let mutated = false;
      const observer = new MutationObserver((records) => {
        if (records.some(relevantMutation)) { mutated = true; }
      });
      try {
        const options = { childList: true, subtree: true };
        if (!bodyScope) { Object.assign(options, { attributes: true, attributeFilter: ['src', 'data-testid'] }); }
        observer.observe(scope, options);
      } catch (_) {
        const inert = () => false;
        inert.stop = () => false;
        return inert;
      }
      // The returned function is a peek: it only reads the flag. Disconnecting
      // is a separate .stop() — waitRegistered polls the peek every tick, and
      // a peek that also disconnected would kill the observer on first check.
      const peek = () => mutated;
      peek.stop = () => {
        try { observer.disconnect(); } catch (_) {}
        return mutated;
      };
      return peek;
    }

    async deliverImages(images) {
      const transfer = this.buildImageFiles(images);
      if (!transfer) { return null; }
      const before = this.attachmentSnapshot();
      this.lastUpload = { startedAt: new Date().toISOString(), beforeCount: before.count, attempts: [] };
      const taskId = this.currentTaskId;
      const confirmed = async (channel) => {
        const attempt = { channel, accepted: false, ready: false, newPreviews: 0 };
        this.lastUpload.attempts.push(attempt);
        // Acceptance gets its own deadline. A late card must not trigger a
        // second upload through a different transport.
        if (!await this.waitRegistered(before, 15000)) { return null; }
        attempt.accepted = true;
        attempt.newPreviews = this.newAttachments(before).length;
        setStatus('图片已到网页，正在等待上传完成…');
        try { await this.waitAttachmentsReady(before, taskId); }
        catch (error) { attempt.error = String(error?.message || error); throw error; }
        attempt.ready = true;
        return channel;
      };
      const assertActive = () => {
        if (this.currentTaskId !== taskId || (taskId && !this.isRunning)) { throw new Error('图片任务已取消。'); }
      };
        const fileInput = this.pickFileInput();
        if (fileInput) {
          let dispatched = false;
          try {
            assertActive();
            fileInput.files = transfer.files;
            fileInput.dispatchEvent(new Event('input', { bubbles: true }));
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            dispatched = true;
          } catch (error) {
            console.warn('[Zotero relay] file-input channel failed', error);
          }
          if (dispatched && await confirmed('file-input')) { return 'file-input'; }
        }

        const input = this.findUsable(this.config.input.text.selector)
          || document.querySelector(this.config.input.text.selector)
          // Site redesign fallback: any visible composer still accepts drops.
          || document.querySelector('textarea, [contenteditable="true"]');
        if (input) {
          input.focus();
          let pasted = false;
          try {
            assertActive();
            input.dispatchEvent(this.pasteEvent(transfer));
            pasted = true;
          } catch (error) {
            console.warn('[Zotero relay] paste channel failed', error);
          }
          if (pasted && await confirmed('paste')) { return 'paste'; }
          let dropped = false;
          let dropTarget = input;
          const rect = input.getBoundingClientRect();
          const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
          const drag = (target, type) => target.dispatchEvent(new DragEvent(type, {
            bubbles: true, cancelable: true, dataTransfer: transfer, ...point,
          }));
          const liveDropTarget = () => document.elementFromPoint?.(point.clientX, point.clientY) || input;
          try {
            assertActive();
            drag(input, 'dragenter');
            // React/Angular mount the full-page drop surface asynchronously.
            // Dropping immediately on the old editor leaves that surface stuck.
            await sleep(120);
            assertActive();
            dropTarget = liveDropTarget(); drag(dropTarget, 'dragover');
            await sleep(120);
            assertActive();
            dropTarget = liveDropTarget(); drag(dropTarget, 'drop');
            dropped = true;
          } catch (error) {
            console.warn('[Zotero relay] drop channel failed', error);
          } finally {
            for (const target of new Set([dropTarget, input])) {
              try { drag(target, 'dragleave'); drag(target, 'dragend'); } catch (_) { /* detached surface */ }
            }
          }
          if (dropped && await confirmed('drop')) { return 'drop'; }
        }
        return null;
    }

    /** Prefer an input accepting images; any file input beats none. */
    pickFileInput() {
      const inputs = Array.from(document.querySelectorAll('input[type=file]'));
      if (!inputs.length) { return null; }
      return inputs.find((node) => /image/i.test(node.accept || ''))
        || inputs.find((node) => !node.accept)
        || inputs[0];
    }

    /** Baseline previews in the same region as the mutation observer. */
    attachmentSnapshot() {
      const scope = this.composerWatchScope();
      const selector = scope === document.body
        ? 'img[src^="blob:"], img[src^="data:"], [class*="attachment" i], [class*="file-preview" i], [class*="upload-preview" i]'
        : 'img, [style*="background" i], [class*="attachment" i], [class*="file-preview" i], [class*="file-pill" i], [class*="upload-preview" i], [data-testid*="attachment" i], [data-testid*="file" i], [data-testid*="upload" i], [aria-label*="附件"], [aria-label*="attachment" i], button[aria-label*="remove" i], button[aria-label*="移除"], button[aria-label*="删除"]';
      const nodes = new Map();
      for (const node of scope.querySelectorAll(selector)) {
        const background = window.getComputedStyle(node).backgroundImage || '';
        if (node.matches('[style*="background" i]') && !/url\(/i.test(background)
          && !node.matches('img, [data-testid*="attachment" i], [class*="attachment" i]')) { continue; }
        if (node.matches('button') && /remove|移除|删除/i.test(node.getAttribute('aria-label') || '')
          && !/file|image|attachment|文件|图片|附件|\.(?:png|jpe?g|webp|gif)\b/i.test(node.getAttribute('aria-label') || '')
          && !node.parentElement?.querySelector('img, [style*="background-image" i]')) { continue; }
        nodes.set(node, [node.getAttribute('src'), background, node.getAttribute('data-testid'),
          node.getAttribute('aria-label'), node.getAttribute('title')].join('|'));
      }
      return { scope, count: nodes.size, nodes };
    }

    newAttachments(before) {
      const now = this.attachmentSnapshot();
      if (now.scope !== before.scope) { return []; }
      return Array.from(now.nodes.keys()).filter(node => !before.nodes.has(node)
        || before.nodes.get(node) !== now.nodes.get(node));
    }

    registeredSince(before) {
      // An unrelated history image or a replaced conversation's old previews
      // must not turn an unacknowledged file event into a successful upload.
      return this.newAttachments(before).length > 0;
    }

    showDiagnostic() {
      // Chromium elides native prompt default values to 2000 characters,
      // replacing the middle (including lastTask) with "...". A readonly
      // textarea and Blob download preserve the original JSON byte-for-byte.
      let serialized = JSON.stringify(this.diagnosticReport(), null, 2);
      document.getElementById('zra-diagnostic-dialog')?.remove();
      const previousFocus = document.activeElement;
      const dialog = document.createElement('dialog');
      dialog.id = 'zra-diagnostic-dialog';
      dialog.setAttribute('aria-label', 'Zotero 联动诊断');
      dialog.style.cssText = 'position:fixed;inset:5vh auto auto 50%;transform:translateX(-50%);margin:0;box-sizing:border-box;width:820px;max-width:94vw;max-height:90vh;overflow:auto;padding:20px;border:1px solid #8894a7;border-radius:10px;background:#fff;color:#18202d;z-index:2147483647;font:14px/1.5 sans-serif';
      const title = document.createElement('h3');
      title.textContent = 'Zotero 联动诊断 · ' + GM_info.script.version;
      const help = document.createElement('p');
      help.textContent = '请下载 JSON 文件并发送给开发者，或复制下方完整报告。内容仅含状态、计数与页面结构，不含对话正文。';
      const field = document.createElement('textarea');
      field.readOnly = true;
      field.setAttribute('aria-label', '完整诊断 JSON');
      field.value = serialized;
      field.style.cssText = 'display:block;box-sizing:border-box;width:100%;height:52vh;resize:vertical;white-space:pre;font:12px/1.5 monospace;color:#18202d;background:#f7f8fa';
      const status = document.createElement('p');
      status.setAttribute('role', 'status');
      status.textContent = '完整报告：' + serialized.length + ' 字符';
      const controls = document.createElement('div');
      controls.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap';
      const refresh = () => {
        serialized = JSON.stringify(this.diagnosticReport(), null, 2);
        field.value = serialized;
        status.textContent = '完整报告：' + serialized.length + ' 字符';
      };
      const button = (name, text, action) => {
        const node = document.createElement('button');
        node.type = 'button'; node.textContent = text;
        node.setAttribute('data-zra-diag', name);
        node.addEventListener('click', action); controls.append(node);
      };
      button('copy', '复制完整报告', async () => {
        refresh();
        field.focus(); field.select();
        try {
          await navigator.clipboard.writeText(serialized);
          status.textContent = '已复制完整报告：' + serialized.length + ' 字符';
        } catch (_) { status.textContent = '自动复制不可用，已全选；请按 Ctrl+C，或下载 JSON。'; }
      });
      button('download', '下载 JSON', () => {
        refresh();
        const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url; link.download = 'zotero-diagnostic-' + location.hostname + '.json';
        dialog.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        status.textContent = '已请求下载完整 JSON；请把下载的文件拖入对话。';
      });
      const close = () => { dialog.remove(); if (previousFocus?.isConnected) { previousFocus.focus(); } };
      button('close', '关闭', close);
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
      dialog.append(title, help, field, status, controls);
      document.documentElement.append(dialog);
      if (typeof dialog.showModal === 'function') { dialog.showModal(); }
      else { dialog.setAttribute('open', ''); }
      field.focus(); field.select();
    }

    diagnosticReport() {
      this.recordDiagnostic('diagnostic-export');
      const label = node => node ? [node.localName, node.id ? '#' + node.id : '',
        (node.getAttribute('class') || '').slice(0, 120)].filter(Boolean).join(' ') : null;
      const input = document.querySelector(this.config.input.text.selector);
      const ancestors = [];
      for (let node = input; node && ancestors.length < 6; node = node.parentElement) { ancestors.push(label(node)); }
      const snapshot = this.attachmentSnapshot();
      return {
        scriptVersion: GM_info.script.version, site: location.host,
        collectedAt: new Date().toISOString(), runtime: this.runtime,
        connected: this.isConnected, taskActive: Boolean(this.currentTaskId),
        lastTask: this.lastTask || null,
        recentRuntimes: [this.lastTrace, ...this.readDiagnosticHistory().filter(entry => entry.runtime.id !== this.runtime.id)].slice(0, 4),
        traceStorageAvailable: this.traceStorageAvailable,
        transport: {
          running: this.isRunning, hasLock: Boolean(this.hasLock()), polling: Boolean(this.pollReq),
          sendingUpdate: this.isSendingUpdate, pendingData: this.hasPendingData,
          awaitingManualSend: this.awaitingManualSend, domWatching: Boolean(this.domWatchInterval),
          workerTimerAvailable: Boolean(timerWorker),
        },
        visibility: document.visibilityState, heartbeatSupported: Boolean(this.supportsHeartbeat),
        lastHeartbeatSecondsAgo: this.lastHeartbeatAt ? Math.round((Date.now() - this.lastHeartbeatAt) / 1000) : null,
        heartbeatError: this.lastHeartbeatError || '', lastCaptureSource: this.lastDataSource,
        inputAncestors: ancestors, previewScope: label(snapshot.scope), previewCount: snapshot.count,
        previews: Array.from(snapshot.nodes.keys()).slice(0, 20).map(node => ({
          element: label(node), image: node.localName === 'img',
          backgroundImage: /url\(/i.test(window.getComputedStyle(node).backgroundImage || ''),
          busy: node.getAttribute('aria-busy') === 'true',
        })),
        fileInputs: Array.from(document.querySelectorAll('input[type=file]')).slice(0, 10)
          .map(node => ({ element: label(node), accept: node.accept, disabled: node.disabled })),
        lastUpload: this.lastUpload || null,
        answerStructure: this.config.name === 'Gemini' ? {
          userQuery: document.querySelectorAll('user-query').length,
          userQueryContent: document.querySelectorAll('user-query-content').length,
          modelResponse: document.querySelectorAll('model-response').length,
          messageContent: document.querySelectorAll('message-content').length,
          recentModels: Array.from(document.querySelectorAll('model-response')).slice(-3).map(node => ({
            element: label(node),
            bodies: Array.from(node.querySelectorAll('message-content, .model-response-text')).map(body => ({
              element: label(body), textLength: (body.textContent || '').length,
            })),
          })),
        } : null,
      };
    }

    /** Poll for an upload indicator until the deadline. */
    async waitRegistered(before, timeoutMs, mutationSignal) {
      const taskId = this.currentTaskId;
      return Boolean(await this.waitForValue(() => {
        if (this.currentTaskId !== taskId || (taskId && !this.isRunning)) { return { cancelled: true }; }
        return this.registeredSince(before) || null;
      }, timeoutMs));
    }

    async waitAttachmentsReady(before, taskId) {
      let readySince = null;
      const result = await this.waitForValue(() => {
        if (this.currentTaskId !== taskId || (taskId && !this.isRunning)) { return { error: '图片任务已取消。' }; }
        const cards = this.newAttachments(before);
        if (!cards.length) { readySince = null; return null; }
        const evidence = cards.map(node => [node.textContent, node.getAttribute('aria-label'), node.getAttribute('title')].join(' ')).join(' ');
        if (/upload failed|failed to upload|上传失败|上传出错|文件太大|file too large|unsupported file/i.test(evidence)) {
          return { error: '网页报告图片上传失败，请查看附件旁的具体错误后重试。' };
        }
        const pending = /\b(uploading|processing|scanning)\b|上传中|正在上传|处理中|正在处理/i.test(evidence)
          || cards.some(node => node.matches('[aria-busy="true"], [role="progressbar"]')
            || node.querySelector('[aria-busy="true"], [role="progressbar"], progress'));
        if (pending) { readySince = null; return null; }
        if (readySince === null) { readySince = Date.now(); }
        return Date.now() - readySince >= 750 ? { ready: true } : null;
      }, 60000);
      if (result?.error) { throw new Error(result.error); }
      if (!result) { throw new Error('图片已到网页，但上传处理仍未完成；请检查网页附件状态，无需再次粘贴。'); }
    }

    /** Match the whole prompt; a long stale draft or matching tail is not enough. */
    inputAccepts(inputConfig, expected) {
      const current = this.findUsable(inputConfig.selector) || document.querySelector(inputConfig.selector);
      if (!current) { return false; }
      const wanted = String(expected || '').replace(/\s+/g, ' ').trim();
      if (!wanted) { return false; }
      // Gecko innerText may remove a CJK segment break under white-space:
      // normal. Check the unrendered text as well, still matching the WHOLE
      // prompt rather than accepting a suffix or a longer unrelated draft.
      const values = 'value' in current ? [this.readText(current)] : [this.readText(current), current.textContent];
      return values.some(value => String(value || '').replace(/\s+/g, ' ').trim() === wanted);
    }

    /** Select-all + insertText, forcing frameworks to accept the text. */
    async refillByReplace(inputConfig, text) {
      const el = this.findUsable(inputConfig.selector) || document.querySelector(inputConfig.selector);
      if (!el) { return false; }
      el.focus();
      if ('value' in el) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) { setter.call(el, text); } else { el.value = text; }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(150);
        return this.inputAccepts(inputConfig, text);
      }
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection?.removeAllRanges();
      selection?.addRange(range);
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, text); } catch (_) { }
      if (!inserted) {
        if ('value' in el) { el.value = text; }
        else { el.textContent = text; }
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(150);
      return this.inputAccepts(inputConfig, text);
    }

    captureBaseline(messageSelector) {
      let messages = [];
      try { if (messageSelector) { messages = [...document.querySelectorAll(messageSelector)]; } } catch { }
      return {
        selector: messageSelector,
        count: messages.length,
        last: messages.at(-1) || null,
        lastContent: messages.length ? String(messages.at(-1).innerText ?? messages.at(-1).textContent ?? '') : null,
      };
    }

    conversationAdvanced(baseline) {
      if (!baseline) { return false; }
      let messages;
      try { messages = [...document.querySelectorAll(baseline.selector || this.config.input.message)]; } catch { return false; }
      const last = messages.at(-1) || null;
      const lastContent = last ? String(last.innerText ?? last.textContent ?? '') : null;
      return messages.length > baseline.count
        || (messages.length === baseline.count && last !== baseline.last)
        || (last === baseline.last && lastContent !== baseline.lastContent);
    }

    controlIsVisible(control) {
      for (let node = control; node?.nodeType === 1; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true'
          || style.display === 'none' || style.visibility === 'hidden') { return false; }
      }
      return Boolean(control?.isConnected);
    }

    hasStreamingControl() {
      let controls = [];
      try { controls = [...document.querySelectorAll('button, [role="button"]')]; } catch { }
      return controls.some((control) => {
        if (!this.controlIsVisible(control)) { return false; }
        const label = [control.getAttribute('aria-label'), control.getAttribute('title'), control.textContent]
          .filter(Boolean).join(' ');
        return control.matches('[data-testid="stop-button"]')
          || /stop(?:ping)?|cancel (?:response|generation)|停止(?:生成|回答|响应)?|终止(?:生成|回答|响应)?/i.test(label);
      });
    }

    /**
     * A submitted turn can be acknowledged before its first response section
     * is mounted. A stop/cancel label is a positive state transition; a bare
     * disabled flag is not, because sites also disable controls before send
     * and while a click is being processed.
     */
    sendButtonAccepted(button) {
      if (!button) { return false; }
      const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
        .filter(Boolean).join(' ');
      return /stop(?:ping| generating| streaming)?|cancel(?: generation| response)?|停止(?:生成|回答|响应)?|终止(?:生成|回答|响应)?/i.test(label);
    }

    observedManualSend(baseline) {
      return this.hasPendingData || this.doneSignal || Boolean(this.accumulatedText)
        || this.conversationAdvanced(baseline)
        || this.hasStreamingControl();
    }

    async handleSend(send, messageSelector) {
      const taskId = this.currentTaskId;
      const cancelled = () => this.currentTaskId !== taskId || (taskId && !this.isRunning);
      if (this.config.name === 'ChatGPT' && !this.chatGPTBaseline) { this.captureChatGPTTurn(); }
      const baseline = this.captureBaseline(messageSelector);
      this.killPoll();
      this.isSendingUpdate = true;
      const inputConfig = this.config.input.text;
      let inputWasNonEmpty = false;
      const initialInput = this.findUsable(inputConfig?.selector || '')
        || document.querySelector(inputConfig?.selector || '');
      if (this.readText(initialInput).trim()) { inputWasNonEmpty = true; }
      const inputWasCleared = () => {
        const input = this.findUsable(inputConfig?.selector || '');
        if (!input) { return false; } // A remount is not a submitted message.
        const value = this.readText(input).trim();
        if (value) {
          inputWasNonEmpty = true;
          return false;
        }
        return inputWasNonEmpty;
      };
      const sendConfirmed = (button = null) => this.conversationAdvanced(baseline)
        || Boolean(this.accumulatedText) || inputWasCleared()
        || this.sendButtonAccepted(button) || this.hasStreamingControl();
      let sentButton = null;
      if (typeof send === 'string') {
        const ready = await this.waitForCondition(() => {
          if (cancelled()) { return { cancelled: true }; }
          if (this.observedManualSend(baseline)) { return { manual: true }; }
          const button = this.findUsable(send);
          return button ? { button } : null;
        }, SEND_BUTTON_WAIT_MS);
        if (cancelled()) { return false; }
        if (ready?.manual) {
          this.manualBaseline = baseline;
          this.awaitingManualSend = true;
          this.startDomWatcher();
          return true;
        }
        const button = ready?.button;
        sentButton = button;
        if (!button) {
          this.manualBaseline = baseline;
          this.awaitingManualSend = true;
          this.startDomWatcher();
          setStatus('30 秒未找到发送按钮；请手动发送');
          this.notifySidebar('网页未找到发送按钮：请手动点击发送，或回到侧栏重新发送。');
          return true;
        }
        // Wall-clock deadlines, not iteration counts: background tabs clamp
        // setTimeout to >=1s, so a 25x100ms loop would stretch to 25s and the
        // send would visibly fire only when the tab regains focus.
        setStatus('正在输入并发送…');
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        button.click();
        await this.waitForValue(() => (cancelled() || sendConfirmed(button) ? true : null), 15000);
      } else {
        await this.waitForValue(() => (cancelled() || sendConfirmed() ? true : null), 15000);
      }
      if (cancelled()) { return false; }
      if (sendConfirmed(sentButton)) {
        this.clearManualFallback();
        if (this.taskStartedAt) {
          setStatus('已发送 ' + ((Date.now() - this.taskStartedAt) / 1000).toFixed(1) + 's，等待回答…');
        }
        return true;
      }
      // Click never registered. Surface it in the sidebar, then watch for a
      // manual send as the recovery path.
      this.manualBaseline = baseline;
      this.awaitingManualSend = true;
      this.startDomWatcher();
      setStatus('未能自动发送；请手动点击发送按钮');
      notify('未能自动发送：请在网页手动点击发送，或回到侧栏重新发送。');
      this.notifySidebar('网页未能自动发送：请手动点击发送按钮，或回到侧栏重新发送。');
      return true;
    }

    /** Push a human-readable notice to the sidebar's pending message. */
    async notifySidebar(message) {
      if (!this.currentTaskId) { return; }
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

    captureChatGPTTurn() {
      const selector = '[data-message-author-role="assistant"]';
      const answers = Array.from(document.querySelectorAll(selector));
      const users = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      this.chatGPTBaseline = {
        answers: new Set(answers), answerIDs: new Set(answers.map(node => node.getAttribute('data-message-id')).filter(Boolean)),
        users: new Set(users), userIDs: new Set(users.map(node => node.getAttribute('data-message-id')).filter(Boolean)),
      };
      this.chatGPTUser = null;
      this.chatGPTStableText = '';
      this.chatGPTStableSince = null;
    }

    sampleChatGPTAnswer() {
      const baseline = this.chatGPTBaseline;
      if (!baseline || !this.currentTaskId || this.doneSignal) { return; }
      const follows = (node, before) => Boolean(before.compareDocumentPosition(node) & 4);
      const users = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      if (!this.chatGPTUser || !this.chatGPTUser.isConnected) {
        this.chatGPTUser = users.find(node => !baseline.users.has(node)
          && !baseline.userIDs.has(node.getAttribute('data-message-id')));
      }
      if (!this.chatGPTUser) { return; }
      const nextUser = users.find(node => node !== this.chatGPTUser && follows(node, this.chatGPTUser));
      const answers = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).filter(node =>
        !baseline.answers.has(node) && !baseline.answerIDs.has(node.getAttribute('data-message-id'))
        && follows(node, this.chatGPTUser) && (!nextUser || follows(nextUser, node)));
      if (!answers.length) { return; }
      const text = answers.map(chatGPTAnswerMarkdown).filter(Boolean).join('\n\n');
      if (!text) { return; }
      if (text !== this.chatGPTStableText) {
        this.chatGPTStableText = text;
        this.chatGPTStableSince = Date.now();
        this.onNewData(text, false, 'chatgpt-dom');
      }
      const turn = answers.at(-1).closest('[data-testid^="conversation-turn"], article') || answers.at(-1).parentElement;
      const actions = Array.from(turn?.querySelectorAll('button[data-testid="copy-turn-action-button"], button[data-testid="good-response-turn-action-button"], button[data-testid="bad-response-turn-action-button"], button[data-testid*="thumbs-"], button[aria-label="Copy"], button[aria-label="复制"], button[aria-label="Good response"], button[aria-label="Regenerate"]') || [])
        .some(control => this.controlIsVisible(control) && !control.closest('pre, code')
          && (/(?:turn-action-button|thumbs-)/.test(control.getAttribute('data-testid') || '')
            || !answers.some(answer => answer.contains(control))));
      const active = (this.proxy?.activeStreams.get(this.currentTaskId) || 0)
        + (this.proxy?.activeRequests.get(this.currentTaskId) || 0);
      const busy = this.composerWatchScope()?.matches('[aria-busy="true"]')
        || this.composerWatchScope()?.querySelector('[aria-busy="true"]');
      if (active || this.hasStreamingControl() || busy || !actions) {
        this.chatGPTStableSince = Date.now();
        return;
      }
      if (Date.now() - this.chatGPTStableSince >= 1500) {
        this.onNewData(text, true, 'chatgpt-dom');
        this.stopDomWatcher();
      }
    }

    geminiUserNodes() {
      const selector = 'user-query, user-query-content';
      // Some Gemini layouts use user-query directly; others nest content in
      // it. Keep one boundary per user turn instead of counting both nodes.
      return Array.from(document.querySelectorAll(selector)).filter(node =>
        !node.parentElement?.closest(selector));
    }

    captureGeminiTurn() {
      this.geminiBaseline = {
        users: new Set(this.geminiUserNodes()),
        answers: new Set(document.querySelectorAll('model-response')),
      };
      this.geminiUser = null;
      this.geminiStableText = '';
      this.geminiStableSince = null;
    }

    scheduleGeminiCompletion() {
      this.cancelGeminiCompletion?.();
      this.cancelGeminiCompletion = null;
      const id = this.currentTaskId;
      const eligible = () => this.isRunning && this.currentTaskId === id && !this.doneSignal
        && this.geminiTransportDone && this.geminiNetworkText
        && !this.proxy?.activeStreams.get(id) && !this.proxy?.activeRequests.get(id);
      if (!id || !eligible()) { return; }
      // A terminal frame plus a closed transport is positive evidence; an
      // idle/pause without that terminal never completes. New streams cancel
      // this quiet window. No copy button, repaint or focus change is needed.
      this.cancelGeminiCompletion = scheduleDeadline(() => {
        this.cancelGeminiCompletion = null;
        if (!eligible()) { return; }
        this.onNewData(this.geminiNetworkText, true, 'network');
        this.stopDomWatcher();
      }, NETWORK_IDLE_COMPLETE_MS);
    }

    sampleGeminiAnswer() {
      if (!this.geminiBaseline || !this.currentTaskId || this.doneSignal) { return; }
      const follows = (node, before) => Boolean(before.compareDocumentPosition(node) & 4);
      const users = this.geminiUserNodes();
      const reading = {
        users: users.length, newUsers: users.filter(node => !this.geminiBaseline.users.has(node)).length,
        models: document.querySelectorAll('model-response').length, boundUser: false,
      };
      if (this.lastTask) { this.lastTask.dom = reading; }
      if (!this.geminiUser?.isConnected) {
        this.geminiUser = users.find(node => !this.geminiBaseline.users.has(node));
      }
      if (!this.geminiUser) { return; }
      reading.boundUser = true;
      const nextUser = users.find(node => node !== this.geminiUser && follows(node, this.geminiUser));
      const answers = Array.from(document.querySelectorAll('model-response')).filter(node =>
        !this.geminiBaseline.answers.has(node) && follows(node, this.geminiUser)
        && (!nextUser || follows(nextUser, node)));
      const bodies = answers.map(node => node.querySelector('message-content, .model-response-text')).filter(Boolean);
      reading.boundModels = answers.length; reading.bodies = bodies.length;
      // Reuse the math-aware DOM→Markdown serializer, not the old user-message
      // selector. A missing network hook must not echo the prompt as an answer.
      const text = bodies.map(chatGPTAnswerMarkdown).filter(Boolean).join('\n\n');
      reading.textLength = text.length;
      if (!text) { return; }
      if (text !== this.geminiStableText) {
        this.geminiStableText = text;
        this.geminiStableSince = Date.now();
        this.onNewData(text, false, 'gemini-dom');
      }
      const controls = answers.at(-1)?.querySelectorAll('button[data-test-id="copy-button"], button[aria-label*="Copy" i], button[aria-label*="复制"], button:has(mat-icon[data-mat-icon-name="copy"])') || [];
      const completeControl = Array.from(controls).some(node => this.controlIsVisible(node)
        && !node.closest('pre, code') && !bodies.some(body => body.contains(node)));
      const active = (this.proxy?.activeStreams.get(this.currentTaskId) || 0)
        + (this.proxy?.activeRequests.get(this.currentTaskId) || 0);
      const busy = answers.some(node => node.matches('[aria-busy="true"]') || node.querySelector('[aria-busy="true"]'));
      const streaming = this.hasStreamingControl();
      const transportDone = this.geminiTransportDone === true;
      Object.assign(reading, { completeControl, active, busy, streaming, transportDone });
      // A parsed final response owns completion even if the page still shows
      // the first sentence / Stop button. Its separate worker pacer finishes.
      if (this.geminiNetworkText && transportDone) { return; }
      // Current-turn terminal frame is a second positive completion signal.
      // Hidden copy actions / stale busy widgets must not veto that signal;
      // live generation and additional response streams still veto completion.
      if (active || streaming || (!transportDone && (!completeControl || busy))) {
        this.geminiStableSince = Date.now(); return;
      }
      if (Date.now() - this.geminiStableSince >= 1500) {
        this.onNewData(text, true, 'gemini-dom'); this.stopDomWatcher();
      }
    }

    // --- DOM fallback watcher (dom-mode sites, or manual send recovery) ---
    startDomWatcher() {
      if (this.domWatchInterval) { return; }
      if (this.config.name === 'ChatGPT' && !this.chatGPTBaseline) { this.captureChatGPTTurn(); }
      if (this.config.name === 'Gemini' && !this.geminiBaseline) { this.captureGeminiTurn(); }
      const outputConfig = this.config.output;
      let lastLength = 0;
      let stableCycles = 0;
      let ticking = false;
      let lastRun = 0;
      const tick = async () => {
        if (ticking) { return; }
        ticking = true;
        try {
          if (typeof document === 'undefined' || !document.documentElement || !this.isRunning || !this.currentTaskId) { this.stopDomWatcher(); return; }
          if (this.config.name === 'ChatGPT') { this.sampleChatGPTAnswer(); return; }
          if (this.config.name === 'Gemini') { this.sampleGeminiAnswer(); return; }
          if (this.awaitingManualSend && this.manualBaseline) {
            if (!this.conversationAdvanced(this.manualBaseline)) { return; }
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
          if (!result || typeof result.text !== 'string') { return; }
          if (result.isDone) {
            if (result.text.length > lastLength) { stableCycles = 0; this.onNewData(result.text, false, 'dom'); }
            else if (++stableCycles >= 5) { this.onNewData(result.text, true, 'dom'); this.stopDomWatcher(); }
            else { this.onNewData(result.text, false, 'dom'); }
          } else {
            stableCycles = 0;
            this.onNewData(result.text, false, 'dom');
          }
          lastLength = result.text.length;
        } catch (error) {
          if (this.lastTask) { this.lastTask.domError = String(error?.message || error).slice(0, 300); }
        } finally {
          ticking = false;
        }
      };
      // One shared pacer: the interval keeps working when nothing mutates,
      // the observer reacts immediately — page intervals are throttled in
      // background tabs, MutationObserver callbacks are not.
      const paced = () => {
        const nowMs = Date.now();
        if (nowMs - lastRun < 150) { return; }
        lastRun = nowMs;
        void tick();
      };
      this.domWatchInterval = setInterval(paced, 200);
      if (typeof MutationObserver === 'function' && document.documentElement) {
        try {
          this.domWatchObserver = new MutationObserver(paced);
          this.domWatchObserver.observe(document.documentElement, {
            childList: true, subtree: true, characterData: true,
          });
        } catch (_) { this.domWatchObserver = null; }
      }
    }

    stopDomWatcher() {
      if (this.domWatchInterval) { clearInterval(this.domWatchInterval); this.domWatchInterval = null; }
      if (this.domWatchObserver) {
        try { this.domWatchObserver.disconnect(); } catch (_) { }
        this.domWatchObserver = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities & UI
  // ---------------------------------------------------------------------------

  // Worker pacing reduces background timer throttling; the page timer is a
  // fallback if CSP blocks the worker. Neither can run during a full page
  // freeze, so the relay separately supports bounded late-answer recovery.
  const sleepWaiters = new Map();
  let sleepSequence = 0;
  const timerWorker = (() => {
    try {
      const source = 'const timers=new Map();onmessage=({data:d})=>{if(d.cancel){clearTimeout(timers.get(d.cancel));timers.delete(d.cancel);return;}timers.set(d.id,setTimeout(()=>{timers.delete(d.id);postMessage(d.id)},d.ms))}';
      const url = URL.createObjectURL(new Blob([source]));
      let worker;
      try { worker = new Worker(url); } finally { URL.revokeObjectURL?.(url); }
      worker.onmessage = (event) => {
        sleepWaiters.get(event.data)?.();
      };
      return worker;
    } catch (_) { return null; }
  })();

  function scheduleDeadline(callback, ms) {
    const id = ++sleepSequence;
    let active = true, pageTimer;
    const cancel = () => {
      if (!active) { return; }
      active = false;
      clearTimeout(pageTimer);
      sleepWaiters.delete(id);
      try { timerWorker?.postMessage({ cancel: id }); } catch (_) {}
    };
    const fire = () => { if (active) { cancel(); callback(); } };
    pageTimer = setTimeout(fire, ms);
    if (timerWorker) {
      sleepWaiters.set(id, fire);
      try { timerWorker.postMessage({ id, ms }); } catch (_) { sleepWaiters.delete(id); }
    }
    return cancel;
  }

  function sleep(ms) {
    return new Promise(resolve => scheduleDeadline(resolve, ms));
  }

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
    if (badge) { badge.textContent = 'Zotero：' + message; }
  }

  function createBadge() {
    let badge = document.getElementById('zra-relay-status');
    if (badge) { return badge; }
    badge = document.createElement('button');
    badge.id = 'zra-relay-status';
    badge.type = 'button';
    badge.textContent = 'Zotero：连接中…';
    badge.title = 'Zotero 网页 AI 中继 ' + GM_info.script.version;
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
    globalThis.__ZRA_TEST__.stripChatGPTInternalCitations = stripChatGPTInternalCitations;
    globalThis.__ZRA_TEST__.siteConfig = siteConfig;
    globalThis.__ZRA_TEST__.connector = connector;
  }
})();
