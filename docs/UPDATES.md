# 更新检查与发布

## 用户如何收到更新

旧版 XPI 使用了无效的占位更新地址，旧油猴脚本也未声明稳定的更新地址。它们无法凭空知道新的地址，因此**需要手动安装本次新版一次**。更新后不需要清空文献、对话或星标。

- Zotero 插件管理器通过本仓库根目录 `updates.json` 检查更新，校验发布包的 SHA-256；是否自动安装取决于用户现有设置。也可到“工具 → 插件 → 齿轮 → 检查更新”手动触发。
- 科研助手侧栏额外提供每日一次的检查和可关闭的新版提示，顶部“检查更新”可随时重查。该提醒只给出正式发布包及说明，不绕过 Zotero 安装流程。
- 油猴脚本的 `@updateURL` 指向最新 Release 的 `.meta.js`，`@downloadURL` 指向最新 Release 的 `.user.js`。篡改猴按用户设置检查更新，不会将未发布的开发源码当作更新。
- 网页脚本另有每天一次的版本检查，在 AI 网页右上角显示可关闭的提醒，提供“下载更新”“更新说明”。油猴菜单“检查脚本更新”可手动触发。不会弹出阻塞式确认框、抢走输入焦点或自动刷新网页。

同一版本自动提醒一次；关闭后仍可手动检查重开提醒。正常检查至少间隔 24 小时；网络错误至少间隔 1 小时后才自动重试，手动操作不受间隔限制。页面打开时检查，持续打开时每小时判断是否到了检查时间，重新可见时也会判断。完全冻结、离线或 GitHub 不可达时不能保证即时提醒。更新检查只获取公共版本信息，不携带论文、对话、API Key。

如果篡改猴已经自动安装了最新版本，当前运行中的网页可能仍使用刷新前的旧脚本；按提示刷新即可。插件不擅自改变 Zotero 或篡改猴的自动更新开关。

## 发布者检查表

1. 同步 XPI 与脚本版本、README、使用指南及发布说明。
2. 执行 `npm run build:userscript` 和 `npm run check:userscript`，再运行回归测试。
3. 执行 `python scripts/build_addon.py` 构建 XPI。
4. 执行 `python scripts/build_release_metadata.py`。它从实际 XPI 生成 `updates.json`，包含兼容范围、下载地址、更新说明及 SHA-256；同时生成 `userscripts/zotero-research-webai.meta.js`。
5. 执行 `python scripts/build_release_metadata.py --check`，拒绝与源码不一致的旧包、旧更新源。
6. 提交并推送版本标签，创建草稿 Release，上传 XPI、两个校验文件、`.user.js`、`.meta.js`、`updates.json` 和发布说明。核对 GitHub 资产哈希。
7. 先公开 Release 并设为 Latest，再推送包含新版 `updates.json` 和 README 的主分支。避免先广告一个尚不能下载的版本。
8. 检查原生更新源和 latest `.meta.js`／`.user.js` 下载地址可达、版本一致；以后每次发布都执行这些步骤。

参考：[Zotero 更新清单格式](https://www.zotero.org/support/dev/zotero_7_for_developers#updaterdf_updatesjson)、[Zotero 10 兼容范围](https://www.zotero.org/support/dev/zotero_10_for_developers)、[Tampermonkey 更新地址](https://www.tampermonkey.net/documentation.php#meta:updateURL)。
