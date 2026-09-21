const ZRA_PREFERENCES_ROOT = 'zra-preferences-root';
const MINERU_FIELDS = {
  'zra-mineru-executable': 'mineruExecutable',
  'zra-mineru-model': 'mineruModelPath',
};
const API_FIELDS = {
  'zra-api-protocol': 'apiProtocol',
  'zra-api-base': 'apiBaseUrl',
  'zra-api-model': 'apiModel',
  'zra-api-key': 'apiKey',
};

function resolveAPIProtocol(protocol, baseUrl) {
  const selected = String(protocol || 'auto').trim().toLowerCase();
  if (selected === 'anthropic' || selected === 'openai') return selected;
  const source = String(baseUrl || '');
  return /\/anthropic(?:\/|$)/i.test(source)
    || /(^|:\/\/)(?:[^/]+\.)?anthropic\.com(?:[/:?#]|$)/i.test(source)
    || /\/messages(?:[?#]|$)/i.test(source)
    ? 'anthropic' : 'openai';
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

async function closeAPIResponse(response) {
  try {
    if (typeof response?.body?.cancel === 'function') {
      await response.body.cancel();
    } else if (typeof response?.text === 'function') {
      await response.text();
    }
  } catch (_) {}
}

var ZoteroResearchPreferences = {
  _loadListener: null,
  _controlsBound: false,

  bindControls() {
    if (this._controlsBound) return;
    const ids = ['zra-reconnect', 'zra-api-import', 'zra-api-test', 'zra-api-save', 'zra-browser-save'];
    const actions = {
      'zra-reconnect': () => this.reconnect(),
      'zra-api-import': () => this.importFromCCSwitch(),
      'zra-api-test': () => this.testAPI(),
      'zra-api-save': () => this.save(),
      'zra-browser-save': () => this.saveBrowser(),
    };
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element && typeof element.addEventListener === 'function') {
        element.addEventListener('click', actions[id]);
      }
    }
    this.field('zra-browser-mode')?.addEventListener?.('change', () => this.updateBrowserFields());
    this._controlsBound = true;
  },

  field(id) {
    return document.getElementById(id);
  },

  status(message) {
    const element = this.field('zra-api-status');
    if (element) element.textContent = message || '';
  },

  init() {
    this.bindControls();
    const browserMode = this.field('zra-browser-mode');
    if (browserMode) browserMode.value = Zotero.Prefs.get('researchAssistant.browserMode') || (Zotero.isWin ? 'chrome' : 'default');
    const executable = this.field('zra-browser-executable');
    if (executable) executable.value = Zotero.Prefs.get('researchAssistant.browserExecutable') || '';
    this.updateBrowserFields();
    const protocol = this.field('zra-api-protocol');
    if (protocol) protocol.value = Zotero.Prefs.get('researchAssistant.apiProtocol') || 'auto';
    for (const [id, preference] of Object.entries(API_FIELDS)) {
      if (id === 'zra-api-protocol') continue;
      const element = this.field(id);
      if (element) element.value = Zotero.Prefs.get('researchAssistant.' + preference) || '';
    }
    for (const [id, preference] of Object.entries(MINERU_FIELDS)) {
      const element = document.getElementById(id);
      if (element) element.value = Zotero.Prefs.get('researchAssistant.' + preference) || '';
    }
    const backendPath = document.getElementById('zra-backend-path');
    if (backendPath) {
      backendPath.textContent = '网页 AI 通过 Zotero 本机端口 23119 直连本插件；'
        + '“设置 → 高级 → 允许其他应用与 Zotero 通信”需保持开启。';
    }
  },

  updateBrowserFields() {
    const custom = this.field('zra-browser-custom');
    if (custom) custom.hidden = this.field('zra-browser-mode')?.value !== 'custom';
  },

  saveBrowser() {
    const status = this.field('zra-browser-status');
    try {
      const mode = this.field('zra-browser-mode')?.value;
      if (!['default', 'chrome', 'edge', 'custom'].includes(mode)) throw new Error('请选择有效的浏览器。');
      if (!Zotero.isWin && (mode === 'chrome' || mode === 'edge')) throw new Error('当前系统请使用“系统默认”或“自定义路径”。');
      let executable = (this.field('zra-browser-executable')?.value || '').trim();
      if (mode === 'custom') {
        executable = ZoteroResearchBrowser.normalizeExecutablePath(executable, Zotero.isWin === true);
        const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
        file.initWithPath(executable);
        if (!file.exists() || !file.isFile() || !file.isExecutable()) throw new Error('浏览器路径不存在或不是可执行文件。');
      }
      Zotero.Prefs.set('researchAssistant.browserExecutable', executable);
      Zotero.Prefs.set('researchAssistant.browserMode', mode);
      if (status) status.textContent = '已保存，下次打开网页时生效，无需重启 Zotero。若要切换当前已连接的浏览器，请先在原网页的油猴菜单中断开连接。';
    } catch (error) {
      if (status) status.textContent = '未保存：' + String(error?.message || error);
    }
  },

  save() {
    for (const [id, preference] of Object.entries(MINERU_FIELDS)) {
      const element = document.getElementById(id);
      if (element) Zotero.Prefs.set('researchAssistant.' + preference, (element.value || '').trim());
    }
    const mineruStatus = document.getElementById('zra-mineru-status');
    if (mineruStatus) mineruStatus.textContent = 'MinerU 路径已保存。';
    const base = (this.field('zra-api-base')?.value || '').trim();
    const model = (this.field('zra-api-model')?.value || '').trim();
    const key = (this.field('zra-api-key')?.value || '').trim();
    if (base && !/^https?:\/\//i.test(base)) {
      this.status('Base URL 必须以 http(s):// 开头。');
      return;
    }
    for (const [id, preference] of Object.entries(API_FIELDS)) {
      const element = this.field(id);
      if (!element) continue;
      const value = id === 'zra-api-protocol' ? element.value : (element.value || '').trim();
      Zotero.Prefs.set('researchAssistant.' + preference, value);
    }
    this.status(base && model
      ? '已保存。在侧栏选择“API 直连”即可使用。'
      : '已保存（字段为空时侧栏的 API 直连不可用）。');
  },

  /** Read the provider CC Switch synced into ~/.claude/settings.json. */
  async importFromCCSwitch() {
    const status = (message) => this.status(message);
    try {
      const home = Services.dirsvc.get('Home', Ci.nsIFile).path;
      const settingsPath = PathUtils.join(home, '.claude', 'settings.json');
      const raw = await Zotero.File.getContentsAsync(settingsPath);
      const settings = JSON.parse(raw);
      const env = settings && settings.env ? settings.env : {};
      const baseUrl = env.ANTHROPIC_BASE_URL || '';
      const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
      // CC Switch writes long-context markers like "[1M]" into the model id;
      // the gateway API expects the bare model name.
      const model = String(env.ANTHROPIC_MODEL || '').replace(/\s*\[\d+[KkMm]\]\s*$/i, '');
      if (!baseUrl || !model) {
        status('未在 ~/.claude/settings.json 中找到 CC Switch 当前提供方（需要 ANTHROPIC_BASE_URL 和 ANTHROPIC_MODEL）。');
        return;
      }
      this.field('zra-api-protocol').value = 'anthropic';
      this.field('zra-api-base').value = baseUrl;
      this.field('zra-api-model').value = model;
      this.field('zra-api-key').value = apiKey;
      this.save();
      status('已导入 CC Switch 当前提供方：' + model + ' @ ' + baseUrl + '（已保存）。');
    } catch (error) {
      status('导入失败：' + String(error?.message || error));
    }
  },

  async testAPI() {
    const base = (this.field('zra-api-base')?.value || '').trim();
    const model = (this.field('zra-api-model')?.value || '').trim();
    const key = (this.field('zra-api-key')?.value || '').trim();
    const protocol = this.field('zra-api-protocol')?.value || 'auto';
    if (!base || !model) {
      this.status('请先填写 Base URL 和模型名称。');
      return;
    }
    this.status('测试中…');
    const resolved = resolveAPIProtocol(protocol, base);
    const Controller = typeof AbortController === 'function' ? AbortController : null;
    const controller = Controller ? new Controller() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 30000) : null;
    try {
      let response;
      if (resolved === 'anthropic') {
        response = await fetch(apiEndpoint(base, resolved), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            Authorization: 'Bearer ' + key,
            'x-api-key': key,
          },
          body: JSON.stringify({
            model,
            max_tokens: 16,
            stream: true,
            messages: [{ role: 'user', content: '只回答：ok' }],
          }),
          signal: controller?.signal,
        });
      } else {
        response = await fetch(apiEndpoint(base, resolved), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + key,
          },
          body: JSON.stringify({
            model,
            max_tokens: 16,
            stream: true,
            messages: [{ role: 'user', content: '只回答：ok' }],
          }),
          signal: controller?.signal,
        });
      }
      if (response.ok) {
        await closeAPIResponse(response);
        this.status('连接成功（HTTP ' + response.status + '），协议 ' + resolved + '。');
      } else {
        const detail = await response.text().catch(() => '');
        this.status('HTTP ' + response.status + '：' + String(detail).slice(0, 200));
      }
    } catch (error) {
      this.status('连接失败：' + (controller?.signal.aborted ? '测试请求超时。' : String(error?.message || error)));
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  },

  install() {
    if (this._loadListener) return;
    const onLoad = (event) => {
      if (event?.target?.id !== ZRA_PREFERENCES_ROOT) return;
      document.removeEventListener('load', onLoad, true);
      this._loadListener = null;
      this.init();
    };
    this._loadListener = onLoad;
    document.addEventListener('load', onLoad, true);
    const root = document.getElementById(ZRA_PREFERENCES_ROOT);
    if (root) onLoad({ target: root });
  },

  reconnect() {
    Services.obs.notifyObservers(null, 'zotero-research:reconnect');
    const status = document.getElementById('zra-settings-status');
    if (status) status.textContent = '已刷新侧边栏。';
  },
};

ZoteroResearchPreferences.install();
