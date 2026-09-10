# 用户脚本 1.0.15：Gemini 已回答但侧栏超时

状态：本地修复，未推送或发布。配合现有 0.8.5 XPI；此次不改 XPI、不需要重装 Zotero 插件。

## 现场证据与边界

2026-09-10 用户在未刷新页面时提供 1.0.14 诊断：图片 paste 通道 `accepted: true`、`ready: true`，有两个新增预览节点；最近心跳为 19 秒前，任务已结束。用户确认 Gemini 页面已经完整回答，侧栏却显示“长时间未回传”。两个预览节点不是“两张图片”的计数。

只读检查确认日常 Zotero 已启用 0.8.5。浏览器访问工具仍返回 `nodeRepl.fetch request failed`，无法检查登录页实际 DOM 或网络对象，因此不能把下面任一缺口断言为该现场的唯一根因。

旧诊断的 `lastCaptureSource` 会在 `resetTaskState` 中清空；`lastHeartbeatSecondsAgo` 也可能记录的是服务器告知任务已经结束的那次回复。它们不能单独证明从未抓取正文，或者任务一直在正常保活。

## 已复现并修复的缺口

1. **XHR 抓取环境不一致。** fetch 使用 `unsafeWindow.fetch`，XHR 却修改脚本环境中的 `XMLHttpRequest.prototype`。两者构造器不同时，网页实际请求完全绕过抓取。改为同样使用 `unsafeWindow.XMLHttpRequest`，保留旧环境兼容。
2. **Gemini 用户轮次过窄。** 页面读取只认 `user-query-content`；`user-query` / `.query-text` 结构下，模型正文即使存在也因找不到本轮用户节点而直接返回。现兼容两个语义节点，嵌套时去重；仍限定在本轮用户与下一轮用户之间，不随意拿最后一个旧回答。结构变体可交叉参考 [Gemini 页面适配器](https://github.com/YosefHayim/ai-browser-bridge/blob/main/src/features/providers/gemini/geminiPage.ts)。
3. **任务结束丢失关键诊断。** `lastTask` 在结束后保留发送确认、图片数量、网络抓取次数、正文长度、来源、心跳回复和页面读取状态。报告只含状态、计数和结构，不含问题或答案全文；刷新后仍清空。

没有修改超时时间、图片投递通道或模型提示词。

## 回归

修复前以下命令两项均失败，抓取正文均为空；修复后两项通过：

```powershell
node --test --test-name-pattern='Gemini captures the page|Gemini DOM fallback handles' tests-js/userscript.test.cjs
```

任务诊断保留测试也先失败、再通过。完整检查命令：

```powershell
npm run test:js
npm run test:webai
npm run test:webai:gecko
npx --yes --package eslint@9 eslint --no-config-lookup --report-unused-disable-directives-severity off --rule 'curly: error' --rule 'block-spacing: [error, always]' --max-warnings 0 userscripts/zotero-research-webai.user.js
node --check userscripts/zotero-research-webai.user.js
git diff --check
```

浏览器用例分别隔离两条 Gemini 回传路径：没有网络抓取时通过 `user-query` 结构读取正文；没有可识别 DOM 正文且脚本构造器不同于网页时，通过原生页面 XHR 回传。每条都经过真实侧栏/中继/图片投递并验证公式与结尾，外部请求全部由测试夹具响应，不调用真实 AI。

本次结果：JavaScript **205/205**；Chromium **4/4**、Firefox **4/4**；ESLint 两项规则、语法及 diff 空白检查通过。浏览器包含 ChatGPT 文件/拖放、Gemini DOM/XHR 四种路径。脚本 SHA-256：`606930d116a84e19b56cda30fde2eb2217990bd07e5ab43dead4569f866df4bb`。

没有重跑 MinerU/GPU 或日常库测试：本轮未改 Python、XPI 或存储代码。真实登录网页仍需更新脚本后验收，不把受控测试计为真实服务通过。

## 更新与真实页面验收

在油猴中编辑原脚本，用 `userscripts/zotero-research-webai.user.js` 全文替换并保存，确认 **1.0.15**，刷新 Gemini 后重试。无需修改 0.8.5 插件或重启 Zotero。若仍失败，不刷新页面，复制「联动诊断（复制给开发者）」报告，尤其 `lastTask` 与 `answerStructure`。
