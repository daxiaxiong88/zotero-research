/* Private per-plugin process capability. The token never leaves this closure. */
(function (root) {
  'use strict';

  function createBridgeClient(adapter) {
    let connection = null;
    let starting = null;
    let startingChild = null;
    let startingCancellation = null;
    let closing = null;
    let closed = false;
    const schedule = adapter.setTimeout || setTimeout;
    const cancel = adapter.clearTimeout || clearTimeout;
    const stopPromises = new Map();

    function makeCancellation() {
      let cancelled = false;
      let rejectCancellation;
      const promise = new Promise((_, reject) => { rejectCancellation = reject; });
      // The cancellation promise can be rejected after its race has settled.
      promise.catch(() => {});
      return {
        promise,
        isCancelled: () => cancelled,
        cancel: () => {
          if (cancelled) return;
          cancelled = true;
          rejectCancellation(new Error('连接已关闭。'));
        },
      };
    }

    function stopChild(child) {
      const existing = stopPromises.get(child);
      if (existing) return existing;
      let stopped;
      try {
        // Request termination synchronously so close() never waits for an
        // uncancellable stdout read before asking the child to stop.
        stopped = child.stop();
      } catch (_) {
        stopped = undefined;
      }
      const promise = Promise.resolve(stopped).catch(() => {});
      stopPromises.set(child, promise);
      return promise;
    }

    async function readHandshake(child, cancellation) {
      let timeout;
      try {
        return await Promise.race([
          (async () => {
            let buffer = '';
            while (!buffer.includes('\n')) {
              const chunk = await child.read();
              if (cancellation.isCancelled()) throw new Error('连接已关闭。');
              if (!chunk) throw new Error('启动信息不完整。');
              buffer += chunk;
              if (buffer.length > 4096) throw new Error('启动信息过大。');
            }
            const info = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
            const urlMatch = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(info.url || '');
            if (info.protocol !== 1 || !urlMatch || Number(urlMatch[1]) < 1 || Number(urlMatch[1]) > 65535
              || typeof info.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(info.token)) {
              throw new Error('启动信息不可信。');
            }
            return info;
          })(),
          new Promise((_, reject) => {
            timeout = schedule(() => reject(new Error('启动超时。')), 15000);
          }),
          cancellation.promise,
        ]);
      } finally {
        if (timeout !== undefined) cancel(timeout);
      }
    }

    async function connect() {
      if (closed) throw new Error('科研助手连接已关闭。');
      if (connection) return connection;
      if (!starting) {
        const cancellation = makeCancellation();
        startingCancellation = cancellation;
        starting = (async () => {
          let child;
          try {
            child = await adapter.launch();
            startingChild = child;
            if (closed) throw new Error('连接已关闭。');
            const info = await readHandshake(child, cancellation);
            if (closed) throw new Error('连接已关闭。');
            connection = { child, ...info };
            return connection;
          } catch (_) {
            if (child) await stopChild(child);
            throw new Error('本机科研服务未能安全启动。请在设置中检查后端路径和模型配置。');
          } finally {
            if (startingChild === child) startingChild = null;
            if (startingCancellation === cancellation) startingCancellation = null;
            starting = null;
          }
        })();
      }
      return starting;
    }

    return {
      async rpc(method, params = {}) {
        const expected = adapter.serverID();
        if (typeof expected !== 'string' || !expected) {
          throw new Error('请先在 Zotero 高级设置中启用“允许此计算机上的其他应用程序与 Zotero 通信”。');
        }
        const active = await connect();
        if (closed) throw new Error('科研助手连接已关闭。');
        let response;
        try {
          response = await adapter.request(active.url + '/rpc', {
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + active.token },
            body: { method, params, expected_server_id: expected },
            timeout: method === 'authorize_write' ? 150000 : (params.allow_heavy_fallback ? 900000 : 660000),
          });
        } catch (_) {
          if (method === 'write_note') {
            throw new Error('笔记写入结果不确定，请先检查 Zotero，不要重复提交。');
          }
          throw new Error('本机连接失败或处理超时。请检查设置；本次没有自动重试。');
        }
        const data = response.data;
        if (!data || data.ok !== true || response.status !== 200) {
          const message = data && data.error && typeof data.error.message === 'string'
            ? data.error.message : '本机服务返回无效响应；未自动重试。';
          throw new Error(message);
        }
        if (adapter.serverID() !== expected
          || (method === 'health' && data.result?.zotero?.server_id !== expected)) {
          throw new Error('扩展与服务连接的文献库不一致，已停止显示结果。');
        }
        return data.result;
      },

      async close() {
        if (!closing) {
          closing = (async () => {
            closed = true;
            if (startingCancellation) startingCancellation.cancel();
            const child = startingChild || (connection && connection.child);
            const stopping = child ? stopChild(child) : Promise.resolve();
            if (starting) await starting.catch(() => {});
            await stopping;
            connection = null;
          })();
        }
        return closing;
      },
    };
  }

  const api = { createBridgeClient };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZoteroResearchBridge = api;
})(globalThis);
