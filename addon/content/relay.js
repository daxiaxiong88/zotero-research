/* In-plugin relay store: browser pages poll this store through the local
 * Zotero endpoint. No secrets, no PDF text at rest beyond the active task. */
(function (root) {
  'use strict';

  const TOKEN_PATTERN = /[a-z0-9]+|[㐀-䶿一-鿿]/gi;
  const MAX_TEXT_LENGTH = 200000;
  const MAX_QUEUE = 8;
  // A claimed task whose page stops sending updates (crash, refresh, silent
  // failure) must not wedge the sidebar's pending state forever.
  const STALE_CLAIM_MS = 90000;

  function tokenize(text) {
    const tokens = [];
    const pattern = new RegExp(TOKEN_PATTERN.source, 'gi');
    let match;
    const source = String(text || '');
    while ((match = pattern.exec(source)) !== null) tokens.push(match[0].toLowerCase());
    return tokens;
  }

  function splitText(text, maxChunk, overlap) {
    const normalized = String(text || '').replace(/[ \t]+/g, ' ').trim();
    if (!normalized) return [];
    const chunks = [];
    let start = 0;
    while (start < normalized.length) {
      const hardEnd = Math.min(start + maxChunk, normalized.length);
      let end = hardEnd;
      if (hardEnd < normalized.length) {
        const boundary = Math.max(
          normalized.lastIndexOf('\n', hardEnd),
          normalized.lastIndexOf('. ', hardEnd),
          normalized.lastIndexOf('。', hardEnd),
        );
        if (boundary > start + Math.floor(maxChunk / 2)) end = boundary + 1;
      }
      const chunk = normalized.slice(start, end).trim();
      if (chunk) chunks.push(chunk);
      if (end >= normalized.length) break;
      start = Math.max(end - overlap, start + 1);
    }
    return chunks;
  }

  /** Deterministic BM25 over page-addressable text; mirrors the retired Python retriever. */
  function rankEvidence(pages, query, topK) {
    const queryTokens = tokenize(query);
    if (!queryTokens.length || !Array.isArray(pages) || !pages.length) return [];
    const chunks = [];
    for (const page of pages) {
      const parts = splitText(page.text, 1200, 160);
      parts.forEach((text, partIndex) => {
        const tokens = tokenize(text);
        if (tokens.length) chunks.push({ page: page.number, index: partIndex + 1, text, tokens });
      });
    }
    if (!chunks.length) return [];
    const docFreq = new Map();
    for (const chunk of chunks) {
      for (const token of new Set(chunk.tokens)) docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
    const avgLength = chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0) / chunks.length;
    const queryFreq = new Map();
    for (const token of queryTokens) queryFreq.set(token, (queryFreq.get(token) || 0) + 1);
    const ranked = [];
    for (const chunk of chunks) {
      const freq = new Map();
      for (const token of chunk.tokens) freq.set(token, (freq.get(token) || 0) + 1);
      let score = 0;
      for (const [token, queryCount] of queryFreq) {
        const tf = freq.get(token) || 0;
        if (!tf) continue;
        const df = docFreq.get(token) || 0;
        const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
        const norm = tf + 1.5 * (0.25 + 0.75 * chunk.tokens.length / Math.max(avgLength, 1));
        score += idf * tf * 2.5 / norm * queryCount;
      }
      if (query.trim() && chunk.text.toLowerCase().includes(query.trim().toLowerCase())) score += 1.5;
      if (score > 0) ranked.push({ score, chunk });
    }
    ranked.sort((a, b) => b.score - a.score || a.chunk.page - b.chunk.page || a.chunk.index - b.chunk.index);
    return ranked.slice(0, topK).map(({ score, chunk }) => ({
      evidence_id: `p${chunk.page}:c${chunk.index}`,
      page: chunk.page,
      chunk_index: chunk.index,
      text: chunk.text,
      score: Number(score.toFixed(6)),
    }));
  }

  /** Query-independent material for overviews; never label excerpts as full text. */
  function overviewMaterial(pages, maxChars = 60000) {
    const limit = Math.min(60000, Math.max(1, Math.floor(Number(maxChars) || 60000)));
    const readable = (pages || []).filter(page => String(page.text || '').trim());
    const total = readable.reduce((sum, page) => sum + String(page.text).length, 0);
    const complete = readable.length > 0 && total <= limit;
    const count = complete ? readable.length : Math.min(16, readable.length, limit);
    const spans = [];
    for (let index = 0; index < count; index += 1) {
      const at = complete || count === 1 ? index : Math.round(index * (readable.length - 1) / (count - 1));
      const page = readable[at];
      const source = String(page.text);
      const budget = complete ? source.length : Math.floor(limit / count);
      const clipped = source.length > budget;
      const parts = clipped
        ? [source.slice(0, Math.ceil(budget / 2)), source.slice(source.length - Math.floor(budget / 2))]
        : [source];
      parts.filter(Boolean).forEach((part, partIndex) => spans.push({
        evidence_id: `p${page.number}:overview${partIndex + 1}`,
        page: page.number, chunk_index: partIndex + 1, text: part,
        score: 0, truncated: clipped,
      }));
    }
    return { kind: complete ? 'full-text' : 'overview-excerpts', spans };
  }

  function createRelayStore(options) {
    const schedule = options && options.setTimeout ? options.setTimeout : setTimeout.bind(globalThis);
    const cancel = options && options.clearTimeout ? options.clearTimeout : clearTimeout.bind(globalThis);
    const now = (options && options.now) || (() => Date.now());

    let session = null; // {secret, ai, url, connectedAt}
    let sequence = 0;
    const tasks = new Map(); // id -> task record
    const queue = []; // task ids awaiting claim
    const pollWaiters = []; // {resolve, timer}
    const listeners = new Set();
    let watchdog = null;

    function armWatchdog() {
      if (watchdog !== null) cancel(watchdog);
      watchdog = null;
      let deadline = Infinity;
      for (const task of tasks.values()) {
        if (!task.complete) deadline = Math.min(deadline,
          (task.claimedAt === null ? task.queuedAt : task.claimedAt) + STALE_CLAIM_MS);
      }
      if (!Number.isFinite(deadline)) return;
      watchdog = schedule(() => {
        watchdog = null;
        reclaimStaleClaims();
        armWatchdog();
      }, Math.max(1, deadline - now()));
    }

    function removeQueued(id) {
      const index = queue.indexOf(id);
      if (index >= 0) queue.splice(index, 1);
    }

    function notify(event) {
      for (const listener of Array.from(listeners)) {
        try { listener(event); } catch (_) { /* a broken panel must not kill the relay */ }
      }
    }

    function releaseWaiters(result) {
      for (const waiter of pollWaiters.splice(0)) {
        cancel(waiter.timer);
        waiter.resolve(result);
      }
    }

    function sessionError(secret) {
      if (!session || session.secret !== secret) return { error: 'SESSION_EXPIRED' };
      return null;
    }

    function state() {
      return session
        ? { connected: true, ai: session.ai, url: session.url, connectedAt: session.connectedAt, queue: queue.length }
        : { connected: false, queue: queue.length };
    }

    function connect(payload) {
      const secret = String((payload && payload.sessionSecret) || '');
      if (!secret || secret.length < 8) return { error: 'INVALID_SESSION' };
      if (session && session.secret !== secret) {
        releaseWaiters({ error: 'SESSION_EXPIRED' });
        failClaimedTasks('已切换网页，请在当前网页重新发送问题。');
      }
      // A fresh connect supersedes an old page; the old page sees SESSION_EXPIRED.
      session = {
        secret,
        ai: String(payload.ai || 'web-ai').slice(0, 100),
        url: String(payload.url || '').slice(0, 500),
        connectedAt: now(),
      };
      notify({ type: 'session', connected: true, ai: session.ai, url: session.url });
      return { status: 'connected' };
    }

    function disconnect(payload) {
      const error = sessionError(String((payload && payload.sessionSecret) || ''));
      if (error) return error;
      session = null;
      releaseWaiters({ error: 'SESSION_EXPIRED' });
      failClaimedTasks('网页连接已断开，请重新连接后重试。');
      notify({ type: 'session', connected: false });
      return { status: 'disconnected' };
    }

    function nextQueuedTask() {
      while (queue.length) {
        const id = queue.shift();
        const task = tasks.get(id);
        if (task && !task.complete) {
          const mismatch = providerMismatch(task.meta);
          if (mismatch) failTask(id, mismatch);
          else return task;
        }
      }
      return null;
    }

    function providerMismatch(meta) {
      const provider = String(meta?.provider || '').toLowerCase();
      if (!session || !provider) return '';
      const active = session.ai.toLowerCase().replace(/[^a-z]/g, '');
      return provider === active ? ''
        : '当前连接的是 ' + session.ai + '，所选提供方为 ' + provider + '。请点击“打开网页”连接所选站点，或切换提供方后重试。';
    }

    function reclaimStaleClaims() {
      for (const task of tasks.values()) {
        if (task.complete) continue;
        if (now() - (task.claimedAt === null ? task.queuedAt : task.claimedAt) < STALE_CLAIM_MS) continue;
        failTask(task.id, task.claimedAt === null
          ? '网页长时间未领取消息，请连接网页后在侧栏重新发送。'
          : '网页长时间未回传回答（可能已刷新或断开），请在侧栏重新发送。');
      }
    }

    function poll(payload, waitMs) {
      const error = sessionError(String((payload && payload.sessionSecret) || ''));
      if (error) return Promise.resolve(error);
      reclaimStaleClaims();
      const task = nextQueuedTask();
      if (task) {
        task.claimedAt = now();
        armWatchdog();
        return Promise.resolve({ task: { id: task.id, messages: task.messages } });
      }
      if (waitMs === 0) return Promise.resolve({});
      return new Promise((resolve) => {
        const timer = schedule(() => {
          const index = pollWaiters.findIndex((entry) => entry.resolve === resolve);
          if (index >= 0) pollWaiters.splice(index, 1);
          resolve({});
        }, waitMs === undefined ? 30000 : waitMs);
        pollWaiters.push({ resolve, timer });
      });
    }

    function update(payload) {
      const error = sessionError(String((payload && payload.sessionSecret) || ''));
      if (error) return error;
      const task = tasks.get(String((payload && payload.id) || ''));
      if (!task) return { error: 'UNKNOWN_TASK' };
      if (task.complete) return { ok: true };
      const text = String((payload && payload.text) || '');
      if (text.length > MAX_TEXT_LENGTH) return { error: 'TEXT_TOO_LONG' };
      task.text = text;
      if (task.claimedAt !== null) task.claimedAt = now();
      task.notice = String((payload && payload.notice) || '').slice(0, 300);
      task.done = Boolean(payload && payload.isDone);
      if (task.done) {
        task.complete = true;
        task.messages = [];
        removeQueued(task.id);
        task.completedAt = now();
        task.error = String((payload && payload.failed) || '').slice(0, 300);
        notify({
          type: 'answer', id: task.id, text: task.text, done: true,
          error: task.error, meta: task.meta,
        });
      } else {
        notify({
          type: 'progress', id: task.id, text: task.text,
          notice: task.notice, meta: task.meta,
        });
      }
      armWatchdog();
      return { ok: true };
    }

    function enqueueTask({ messages, meta }) {
      if (!Array.isArray(messages) || !messages.length) throw new Error('任务内容不能为空。');
      const mismatch = providerMismatch(meta);
      if (mismatch) throw new Error(mismatch);
      reclaimStaleClaims();
      if (Array.from(tasks.values()).filter(task => !task.complete).length >= MAX_QUEUE) {
        throw new Error('待处理任务过多，请等待当前任务完成。');
      }
      // Completed records are delivered already; drop the stale ones so a long
      // Zotero session does not accumulate every answer it ever produced.
      prune();
      sequence += 1;
      const id = 'task-' + String(sequence) + '-' + Math.random().toString(36).slice(2, 10);
      const task = {
        id,
        messages: messages.map((message) => {
          if (message && message.type === 'image') {
            const data = String(message.data || '');
            if (!data || data.length > 6_000_000) {
              throw new Error('截图缺失或超过大小限制，请重新粘贴。');
            }
            return {
              type: 'image',
              data,
              mediaType: String(message.mediaType || 'image/png'),
            };
          }
          const text = String(message.text || '');
          if (text.length > MAX_TEXT_LENGTH) {
            throw new Error('任务文本超过大小限制，请拆分后发送。');
          }
          return { type: 'text', text };
        }),
        meta: meta || {},
        text: '', notice: '', done: false, complete: false, error: '', queuedAt: now(), claimedAt: null, completedAt: 0,
      };
      tasks.set(id, task);
      queue.push(id);
      if (pollWaiters.length) {
        // A page is already waiting inside poll(); hand the task over now.
        const waiting = nextQueuedTask();
        if (waiting) {
          waiting.claimedAt = now();
          const waiter = pollWaiters.shift();
          cancel(waiter.timer);
          waiter.resolve({ task: { id: waiting.id, messages: waiting.messages } });
        }
      }
      armWatchdog();
      return id;
    }

    function failTask(id, message) {
      const task = tasks.get(id);
      if (!task || task.complete) return;
      task.complete = true;
      task.messages = [];
      removeQueued(id);
      task.completedAt = now();
      task.error = String(message || '网页 AI 页面未能完成本次请求。').slice(0, 300);
      notify({ type: 'answer', id: task.id, text: task.text, done: true, error: task.error, meta: task.meta });
      armWatchdog();
    }

    function cancelTask(id) {
      failTask(id, '已取消本机等待；尚未领取的消息不会再发送，网页已发出的回答可能仍在生成。');
    }

    function failClaimedTasks(message) {
      for (const task of tasks.values()) {
        if (!task.complete && task.claimedAt !== null) failTask(task.id, message);
      }
    }

    function destroy() {
      session = null;
      releaseWaiters({ error: 'SESSION_EXPIRED' });
      for (const task of tasks.values()) failTask(task.id, '中继已关闭，请重新连接。');
      queue.length = 0;
      tasks.clear();
      listeners.clear();
      if (watchdog !== null) cancel(watchdog);
      watchdog = null;
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function prune() {
      const cutoff = now() - 30 * 60 * 1000;
      for (const [id, task] of tasks) {
        if (task.complete && Number.isFinite(task.completedAt) && task.completedAt < cutoff) tasks.delete(id);
      }
    }

    return {
      connect, disconnect, poll, update,
      enqueueTask, failTask, cancelTask, subscribe, state, prune, destroy,
      _tasks: tasks, _queue: queue, _pollWaiters: pollWaiters,
    };
  }

  const api = { createRelayStore, rankEvidence, overviewMaterial, tokenize, splitText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZoteroResearchRelay = api;
})(globalThis);
