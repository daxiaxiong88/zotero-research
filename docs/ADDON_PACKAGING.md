# Zotero Research XPI 打包

`scripts/build_addon.py` 是一个只使用 Python 标准库的确定性 XPI 打包器。它不会安装扩展、访问 Zotero 数据库，也不会修改 addon 源文件或主工作树。

## 使用

在仓库根目录执行：

```powershell
python scripts/build_addon.py `
  --bridge-executable 'C:\absolute\path\zotero-research-bridge.exe' `
  --working-directory 'D:\Research\ChatGPT'
```

默认值为：

- addon 源目录：`repo/addon`
- XPI：`repo/dist/zotero-research-0.2.0.xpi`
- SHA-256：`zotero-research-0.2.0.xpi.sha256`
- 清单：`zotero-research-0.2.0.xpi.manifest.json`

`--bridge-executable` 必须是已存在的绝对 `.exe` 文件；`--working-directory` 必须是已存在的绝对目录。两者会写入 XPI 内 `config.json` 的 `bridgeExecutable` 和 `workingDirectory` 字段。模板中的其他 JSON 配置会保留，但凭据字段和值会被拒绝。

## 输入边界

根目录必须包含 `manifest.json`、`bootstrap.js` 和 `config.json`。manifest 必须声明：

```json
{
  "version": "0.2.0",
  "applications": {
    "zotero": {
      "id": "zotero-research@local.invalid",
      "strict_min_version": "10.0",
      "strict_max_version": "10.0.*"
    }
  }
}
```

打包器会精确校验 addon id、扩展版本和 Zotero 版本范围：id 必须为
`zotero-research@local.invalid`，扩展版本必须为 `0.2.0`，Zotero 版本必须为
`10.0` 至 `10.0.*`。不符合时构建失败。

其他允许打包的运行时文件是：

```text
prefs.js
content/native.js
content/bridge-client.js
content/panel.js
content/panel.css
content/icon.svg
content/preferences.xhtml
content/preferences.js
locale/en-US/zotero-research.ftl
locale/zh-CN/zotero-research.ftl
```

未知文件、`tests`、`node_modules`、`.env`、常见凭据/密钥文件和任何 symlink 都会使构建失败。未列出的空目录不会写入 ZIP。

## 产物保证

- ZIP 根目录直接包含 `manifest.json` 和 `bootstrap.js`。
- ZIP 文件名按 POSIX 相对路径排序，时间戳固定为 `1980-01-01 00:00:00`，不写目录条目。
- `.sha256` 使用标准 `sha256sum` 格式：`<hash>  <filename>`。
- JSON 清单只包含 addon id、版本、Zotero 最低版本和文件名，不包含本机 bridge/repository 路径或凭据。
- 构建前完整验证输入，写入 XPI 和 sidecar 时使用临时文件再原子替换。

这只是打包步骤；不会实际安装 XPI，也不会操作 Zotero 配置或数据库。
