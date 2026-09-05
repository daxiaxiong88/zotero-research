# Zotero Research XPI 打包

`scripts/build_addon.py` 使用 Python 标准库生成确定性的 Zotero 10 XPI。它把本机 bridge 可执行文件和项目目录写入 XPI 内的 `config.json`，不会修改 addon 源文件。

## 构建

在仓库根目录执行：

```powershell
\.venv-zotero10\Scripts\python.exe scripts/build_addon.py `
  --bridge-executable 'D:\Research\ChatGPT\.venv-zotero10\Scripts\zotero-research-bridge.exe' `
  --working-directory 'D:\Research\ChatGPT'
```

默认产物：

- `dist/zotero-research-0.3.0.xpi`
- `dist/zotero-research-0.3.0.xpi.sha256`
- `dist/zotero-research-0.3.0.xpi.manifest.json`

## XPI 内容

XPI 必须包含 `manifest.json`、`bootstrap.js`、`config.json`、`prefs.js`、`content/` 下的面板文件、两个 locale 文件和图标。manifest 固定使用：

```json
{
  "manifest_version": 2,
  "version": "0.3.0",
  "applications": {
    "zotero": {
      "id": "zotero-research@local.invalid",
      "strict_min_version": "10.0",
      "strict_max_version": "10.0.*"
    }
  }
}
```

构建器会校验文件白名单、扩展身份、Zotero 版本范围、路径格式和 ZIP 结构；时间戳与文件顺序固定，因此相同输入会得到相同的 XPI。

## 安装

在 Zotero 中选择“工具 → 插件 → 齿轮 → 从文件安装插件”，选中 `dist/zotero-research-0.3.0.xpi`，完成后重启 Zotero。用户脚本需要单独安装，位于 `userscripts/zotero-research-webai.user.js`。
