/* Preferences contain model names/paths only, never cloud API credentials. */
var ZoteroResearchPreferences = {
  fields: {
    'zra-local-model': 'localModelName', 'zra-local-url': 'localModelBaseURL',
    'zra-mineru-model': 'mineruModelPath', 'zra-mineru-executable': 'mineruExecutable',
  },
  async init() {
    for (const [id, preference] of Object.entries(this.fields)) {
      document.getElementById(id).value = Zotero.Prefs.get('researchAssistant.' + preference) || '';
    }
    try {
      const uri = await Zotero.Plugins.resolveURI('zotero-research@local.invalid', 'config.json');
      const config = JSON.parse(await Zotero.File.getResourceAsync(uri));
      document.getElementById('zra-backend-path').textContent = '后端目录：' + config.workingDirectory;
    } catch (_) {
      document.getElementById('zra-backend-path').textContent = '请检查 XPI 是否由本机打包脚本生成。';
    }
  },
  save() {
    const address = document.getElementById('zra-local-url').value.trim();
    try {
      const parsed = new URL(address);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
        || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('invalid local URL');
      }
    } catch (_) {
      document.getElementById('zra-settings-status').textContent = '本地模型地址必须是无凭据的回环 HTTP(S) 地址，例如 http://127.0.0.1:11434/v1。';
      return;
    }
    for (const [id, preference] of Object.entries(this.fields)) {
      Zotero.Prefs.set('researchAssistant.' + preference, document.getElementById(id).value.trim());
    }
    document.getElementById('zra-settings-status').textContent = '设置已保存。请点击重新连接；如有正在进行的任务，先等待其结束。';
  },
  reconnect() {
    Services.obs.notifyObservers(null, 'zotero-research:reconnect');
    document.getElementById('zra-settings-status').textContent = '已请求重新连接。请返回科研助手查看连接状态；忙碌时会提示稍后重试。';
  },
};
