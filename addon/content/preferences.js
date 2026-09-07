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

var ZoteroResearchPreferences = {
  _loadListener: null,
  _controlsBound: false,

  bindControls() {
    if (this._controlsBound) return;
    const ids = ['zra-reconnect', 'zra-api-import', 'zra-api-test', 'zra-api-save'];
    const actions = {
      'zra-reconnect': () => this.reconnect(),
      'zra-api-import': () => this.importFromCCSwitch(),
      'zra-api-test': () => this.testAPI(),
      'zra-api-save': () => this.save(),
    };
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element && typeof element.addEventListener === 'function') {
        element.addEventListener('click', actions[id]);
      }
    }
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
    const resolved = protocol === 'anthropic' || protocol === 'openai'
      ? protocol
      : (/\/anthropic/i.test(base) ? 'anthropic' : 'openai');
    try {
      let response;
      if (resolved === 'anthropic') {
        response = await fetch(base.replace(/\/+$/, '') + '/v1/messages', {
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
            messages: [{ role: 'user', content: '只回答：ok' }],
          }),
        });
      } else {
        let url = base.replace(/\/+$/, '');
        if (!/\/v\d+$/.test(url)) url += '/v1';
        response = await fetch(url + '/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + key,
          },
          body: JSON.stringify({
            model,
            max_tokens: 16,
            messages: [{ role: 'user', content: '只回答：ok' }],
          }),
        });
      }
      if (response.ok) {
        this.status('连接成功（HTTP ' + response.status + '），协议 ' + resolved + '。');
      } else {
        const detail = await response.text().catch(() => '');
        this.status('HTTP ' + response.status + '：' + String(detail).slice(0, 200));
      }
    } catch (error) {
      this.status('连接失败：' + String(error?.message || error));
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
