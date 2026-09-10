# 脚本 1.0.17：跨重载任务追踪，尚未确认现场回传根因

本地诊断候选，未发布、未推送。XPI 保持 0.8.6；没有修改图片投递、回答选择器、回传协议或超时策略。

## 已知事实与未解决的问题

- 用户页面已显示 Gemini 回答，但 Zotero 超时。
- 完整 1.0.16 报告显示已连接且轮询中，`lastTask`、`lastUpload`、最后心跳均为空。用户确认在本轮失败后才打开诊断窗口。
- 最新篡改猴菜单显示「Zotero 网页 AI 中继」启用，「Zotero GPT Connector」关闭；这张截图没有支持两份脚本同时启用的说法，也不能据此证明其他页面或其他扩展中的状态。
- 当前代码完成、失败、断开时不会删除 `lastTask`，但脚本新实例没有旧实例的内存。既不能据此断言用户刷新过，也不能证明网络或 DOM 抓取失败。需要实例与任务领取链路的证据。

## 本轮仅补充诊断

- `runtime` 标识脚本实例、启动时间、页面时间原点、导航类型和源码诊断修订；`collectedAt` 标识报告采样时间。
- `lastTask.id` 对应中继任务编号。记录连接结果、轮询是否收到/接受任务、任务阶段、读取字符数、心跳和更新请求结果。
- 同一标签页的 `sessionStorage` 最多保留 4 个实例、每个最近 20 个事件，总计最多 48000 字符；流式采样节流 5 秒，结束、错误与页面离开立即记录。
- 不存问题正文、回答正文、图片数据或会话密钥。旧实例只用于诊断，绝不自动恢复或重发其请求。存储不可用时退回内存并显示 `traceStorageAvailable: false`，不能阻断任务。
- 复制/下载时重新采样，避免诊断窗口长期开启后继续导出打开时的旧快照。这是独立的导出改善，不是已经确定的现场原因。

## 验证边界

先添加回归测试，确认旧脚本不能保留跨实例证据、导出按钮不能读取最新状态；再实现诊断改动。测试还覆盖历史容量、存储失败、回传被拒绝时保留错误码、不存正文以及不重发旧任务。

Chromium / Firefox 受控页面测试验证真实 document reload、sessionStorage 与实际 JSON 下载；这些测试不登录用户账号，不是对真实 Gemini 故障已修复的证明。

```powershell
npm run test:js
npx playwright test tests-browser/diagnostic-export.spec.cjs --browser=chromium --workers=1
npx playwright test tests-browser/diagnostic-export.spec.cjs --browser=firefox --workers=1
npm run test:webai
npm run test:webai:gecko
```

## 下一次现场记录

将原脚本全文替换为 1.0.17，刷新一次让新代码加载。重现后下载诊断 JSON。检查当前与历史实例：是否出现新实例、是否实际收到任务编号、轮询结果是否被丢弃、是否已提取正文，以及回传返回什么结果。只有捕获这些信息后才决定回传逻辑修复；不得把本版称为已解决现场故障。
