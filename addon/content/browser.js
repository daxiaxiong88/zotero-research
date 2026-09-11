/* On-demand browser startup. Never closes processes or changes browser profiles. */
(function (root) {
  'use strict';
  const OCCLUSION_SWITCH = '--disable-backgrounding-occluded-windows';
  const HOSTS = new Set(['gemini.google.com', 'aistudio.google.com', 'chatgpt.com',
    'chat.deepseek.com', 'www.kimi.com', 'kimi.moonshot.cn', 'claude.ai']);

  function createLauncher(adapter) {
    let alive = true;
    let queue = Promise.resolve();
    const pending = new Map();
    const checkAlive = () => { if (!alive) throw new Error('插件已关闭，未启动浏览器。'); };
    function open(value) {
      let url;
      try {
        url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port
          || !HOSTS.has(url.hostname) || url.href.length > 4096) throw new Error('host');
      } catch (_) { return Promise.reject(new Error('不是支持的 AI 网页地址。')); }
      const target = url.href;
      if (pending.has(target)) return pending.get(target);
      // Serialize different panel opens too: do not race two cold Chrome
      // startups against one profile. Identical pending opens share one job.
      const job = queue.catch(() => {}).then(async () => {
        checkAlive();
        if (!adapter.isWindows()) {
          await adapter.openDefault(target);
          return { status: 'default', message: '' };
        }
        const executable = await adapter.findChrome();
        checkAlive();
        if (!executable) {
          await adapter.openDefault(target);
          return { status: 'default', message: '未找到 Chrome，已使用默认浏览器；若后台回传停顿，请让 AI 网页保持可见。' };
        }
        await adapter.launch(executable, [OCCLUSION_SWITCH, target]);
        // Chrome may forward this URL to an existing process, which retains
        // its original switches. Requesting startup is not proof they applied.
        return { status: 'opened', message: '已请求 Chrome 联动启动。若 Chrome 此前已普通启动，新参数需正常退出全部 Chrome 后再从侧栏打开才生效；插件不会关闭现有窗口。' };
      }).finally(() => pending.delete(target));
      queue = job;
      pending.set(target, job);
      return job;
    }
    return { open, destroy() { alive = false; } };
  }
  const api = { createLauncher };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZoteroResearchBrowser = api;
})(globalThis);
