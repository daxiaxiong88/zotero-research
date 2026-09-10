# 脚本 1.0.16：修复诊断导出截断，回传故障仍在调查

状态：本地诊断修复，未发布。Zotero XPI 仍为 0.8.6。本轮没有宣称 Gemini 回传故障已解决，也没有再改图片投递、选择器或超时策略。

## 现场与已确定的阻碍

用户截图同时显示已发送的图片、Gemini 对该图片的回答，以及侧栏超时。安装的 0.8.6 XPI 已启用，哈希与交付包一致。

用户反复复制的报告，包括提供的 `1.txt`，均在中间含有字面的 `...`。文件换行归一化后恰好 **2000 字符**，省略号下标为 **999**，关键 `lastTask` 不存在。这不是用户复制不完整，也不是对话系统截断；旧脚本用 `window.prompt` 的默认值导出长 JSON，而 Chromium 会主动在中间省略超长默认值。实现可核对 [Chromium TabModalDialogManager](https://chromium.googlesource.com/chromium/src.git/+/7a13e2645a7cd50b0bdfd96e72bcdd9b7e9fee26/components/javascript_dialogs/tab_modal_dialog_manager.cc)。

此前根据不完整诊断复现的兼容/中继问题是独立缺口，并未证实为此用户现场的根因。不能用这些测试数量替代真实失败记录。

## 本轮改动

- 诊断菜单改为只读 textarea，提供复制、下载 JSON、关闭；不再使用原生 `window.prompt`。
- 原始序列化 JSON 直接赋给 `.value` 并用于 Blob 下载，不裁剪、不插入 HTML；重复打开只保留一个面板。
- `lastTask` 提到报告前部；补充回传尝试次数、服务器返回状态、传输错误和 DOM 读取异常，以区分“未读取”“读取后未发送”“服务器未接受”。
- 仍不导出正文、图片数据或会话密钥，不自动上传；这些诊断属于当前页面内存，刷新会清空。

## 验证

单位测试 `diagnostic export preserves long JSON and lastTask without a native prompt` 修复前失败（调用了原生 prompt），修复后通过。

Chromium、Firefox 的 `tests-browser/diagnostic-export.spec.cjs` 均通过：超过 5700 字符、包含中文和 HTML 字面量的报告，在文本框及下载 JSON 中与原始字符串逐字一致，中间的 `lastTask` 完整。

```powershell
node --test --test-name-pattern='diagnostic export preserves|task diagnostics retain' tests-js/userscript.test.cjs
npx playwright test tests-browser/diagnostic-export.spec.cjs --browser=chromium --workers=1
npx playwright test tests-browser/diagnostic-export.spec.cjs --browser=firefox --workers=1
npm run test:js
```

## 当前需要的现场验收

更新油猴脚本至 1.0.16、刷新 Gemini 后重现一次，失败后不要刷新，直接下载 JSON 文件提供。检查 `lastTask` 的读取来源、字符数、DOM 判定、回传结果及结束原因后，才能确定下一步修复。XPI 0.8.6 不需重装。
