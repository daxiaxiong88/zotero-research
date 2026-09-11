# 网页脚本 1.0.20：减少 Gemini 正文回传等待

本地候选修复，尚未替换 GitHub 发布附件。配合当前 XPI 0.8.10 使用；本次不修改 XPI、文献、解析缓存或会话存档。

## 修复内容

1.0.19 一旦收到第一段有效网络正文，就会忽略随后出现的页面正文。如果页面已经有后续段落，而网络快照还没追上，侧栏会继续停留在旧内容。

1.0.20 允许同一回答中更完整、且与已有内容前缀一致的页面正文先回传，并防止落后的网络片段把它缩回去。网络更快时仍直接回传；网络更正以及最终快照仍具有优先权，不采用简单的“文字越长越正确”规则。比较时兼容空白差异与独立的思考块。

结束帧、传输关闭及完成等待的判断不变，避免为追求速度而再次截断回答。最终公式排版仍在确认回答完成后执行。

## 更新方法

打开仓库中的 `userscripts/zotero-research-webai.user.js`，复制全文，覆盖篡改猴中原有的“Zotero 网页 AI 中继”脚本并保存。确认版本 **1.0.20**，然后刷新 Gemini 网页一次。不要同时启用两个副本，也不必清空原会话。

本地源码：`D:\Research\ChatGPT\userscripts\zotero-research-webai.user.js`。当前 GitHub 发布附件和已有 `dist` 副本不因这次源码修改自动更新。

## 验证

- 修改前，新增单元回归明确失败：页面已有后续解释，采集结果仍只有“第一句。”。
- 修改后，235 项 JavaScript 测试通过，包括来源交替、空白/思考块差异、较短更正和最终答案。
- Chromium 11 项、Firefox 12 项浏览器测试通过，覆盖图片发送、后台停绘制、丢失回调、超时补回和公式排版。
- 新增浏览器延迟测试故意保持网络未结束，只有侧栏提前收到并显示后续段落，才允许网络继续。单独复测中，Chromium / Firefox 的本地中继延迟分别为 3 / 2 毫秒，侧栏显示延迟均为 155 毫秒，均低于测试的 1 秒上限。

上述时间来自受控浏览器夹具，不是用户已登录 Gemini 页面实测，也不包含模型生成时间。本修复解决已复现的来源阻挡；不能保证解决网络、本机请求回调或浏览器完全冻结造成的其他延迟。

复测命令：

```text
npm run test:js
npx playwright test tests-browser/webai-relay.spec.cjs tests-browser/diagnostic-export.spec.cjs --browser=chromium --workers=2
npx playwright test tests-browser/webai-relay.spec.cjs tests-browser/diagnostic-export.spec.cjs tests-browser/sidebar-layout.spec.cjs --browser=firefox --workers=2
npx playwright test tests-browser/webai-relay.spec.cjs --grep network-lag --browser=chromium --workers=1
npx playwright test tests-browser/webai-relay.spec.cjs --grep network-lag --browser=firefox --workers=1
```
