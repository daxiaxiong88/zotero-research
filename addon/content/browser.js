/* On-demand browser startup. Never closes processes or changes browser profiles. */
(function (root) {
  'use strict';
  const OCCLUSION_SWITCH = '--disable-backgrounding-occluded-windows';
  const HOSTS = new Set(['gemini.google.com', 'aistudio.google.com', 'chatgpt.com',
    'chat.deepseek.com', 'www.kimi.com', 'kimi.moonshot.cn', 'claude.ai']);

  function normalizeExecutablePath(value, windows) {
    let path = String(value || '').trim();
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    const absolute = windows ? /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/i.test(path) : path.startsWith('/');
    if (!absolute || /[\x00-\x1f"]/.test(path) || (windows && !/\.exe$/i.test(path))) {
      throw new Error(windows ? '请填写浏览器 .exe 的绝对路径，不要附带启动参数。' : '请填写浏览器可执行文件的绝对路径，不要选择 .app 目录或附带启动参数。');
    }
    return path;
  }

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
      // Serialize different panel opens too: do not race two cold browser
      // startups against one profile. Identical pending opens share one job.
      const job = queue.catch(() => {}).then(async () => {
        checkAlive();
        const windows = adapter.isWindows();
        const settings = adapter.getSettings?.() || {};
        const mode = settings.mode || (windows ? 'chrome' : 'default');
        if (!['default', 'chrome', 'edge', 'custom'].includes(mode)) {
          throw new Error('浏览器设置无效，请在“设置 → 科研助手”重新选择。');
        }
        if (mode === 'default') {
          await adapter.openDefault(target);
          return { status: 'default', message: '已使用系统默认浏览器打开；此模式不附加后台优化参数。' };
        }
        let executable;
        const label = mode === 'edge' ? 'Edge' : mode === 'chrome' ? 'Chrome' : '自定义浏览器';
        if (mode === 'custom') {
          executable = normalizeExecutablePath(settings.executable, windows);
        } else {
          if (!windows) throw new Error('Chrome / Edge 自动定位目前仅支持 Windows；请改用“系统默认”或“自定义路径”。');
          executable = await (mode === 'edge' ? adapter.findEdge() : adapter.findChrome());
        }
        checkAlive();
        if (!executable) {
          if (!settings.mode) {
            await adapter.openDefault(target);
            return { status: 'default', message: '未找到 Chrome，已使用默认浏览器；可在“设置 → 科研助手”选择浏览器。' };
          }
          throw new Error('未找到 ' + label + '，请在“设置 → 科研助手”更换浏览器或填写自定义路径。');
        }
        if (typeof adapter.isExecutable === 'function' && !await adapter.isExecutable(executable)) {
          throw new Error('浏览器路径不存在或不是可执行文件，请在“设置 → 科研助手”检查路径。');
        }
        checkAlive();
        const chromium = windows && /[\\/](?:chrome|msedge)\.exe$/i.test(executable);
        await adapter.launch(executable, chromium ? [OCCLUSION_SWITCH, target] : [target]);
        // Chromium may forward this URL to an existing process, which retains
        // its original switches. Requesting startup is not proof they applied.
        return { status: 'opened', message: chromium
          ? '已请求 ' + label + ' 联动启动。若该浏览器此前已普通启动，新参数需正常退出其全部窗口后再从侧栏打开才生效；插件不会关闭现有窗口。'
          : '已使用' + label + '打开网页，请确认该浏览器已安装配套油猴脚本。' };
      }).finally(() => pending.delete(target));
      queue = job;
      pending.set(target, job);
      return job;
    }
    return { open, destroy() { alive = false; } };
  }
  const api = { createLauncher, normalizeExecutablePath };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZoteroResearchBrowser = api;
})(globalThis);
