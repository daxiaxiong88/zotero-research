# 2026-09-05：网页连接审查与 0.4.2 修复

范围：用户重构后的原生 Zotero 10 中继、侧栏、油猴脚本、当前安装包。没有回退或覆盖用户的架构修改。

## 已复现并修复

1. **P1：浏览器请求在到达插件之前就被 Zotero 断开。** 油猴 1.0.0 的 `gmRequest()` 缺少 `X-Zotero-Connector-API-Version: 3`。本机 Zotero 10.0.1 的 `server/server.js` 检测浏览器 User-Agent / Origin 后直接取消无协议头请求，所以放行插件内部的 chrome-extension Origin 无法解决。相同 JSON 请求，普通 curl 成功，Mozilla User-Agent 的请求得到 `curl: (52) Empty reply from server`；加协议头后返回 HTTP 200。油猴 1.0.1 已补齐请求头，没有放宽 Zotero 的总闸或启用 unsafe-web-content。
2. **P1：旧页面未释放的 poll 可能领走新任务，同一任务还会广播给所有等待者。** 新会话令旧长轮询过期；每个任务仅交给一个等待者。脚本增加失锁监听、旧回包身份检查和带到期时间的标签页锁；侧栏打开新页面时显式接管，使用后移除 URL 片段。
3. **P1：主动断开后，已领取任务一直 pending；迟到的 connect 又会造成假连接。** 服务端对已领取任务发出终态错误；客户端使用连接代次、握手合并以及迟到成功后的同会话断开补偿。关闭插件时释放长轮询和任务。
4. **P1：连接之后仍无法读取 PDF。** `Zotero.PDFWorker.getPages()` 不在本机 Zotero 10.0.1 的 manager API 中。改用 `getFullText(itemID, maxPages, isPriority)`，以 `\f` 分页。核对了内置 worker 实现；遇到首尾空白页被 trim 导致分页数量不符时，按显式 page index 重读，防止引用页码偏移。
5. **P2：取证期间可重复发送，切换论文后旧请求仍然入队。** 在取证前置 busy，捕获文献快照与会话代次；切换文献、清空或面板销毁后取消未完成的入队动作。

## 验证与部署

- `npm run test:js`：47/47 通过，包含先失败再修复的请求头、长轮询接管、任务断开、迟到握手、异步文献切换及 PDF API 回归测试。
- `uv run python -m pytest -o addopts='' -q`：78 通过、2 跳过。
- `uv run python -m ruff check src scripts tests`：通过。
- `uv run python -m mypy`：15 个源文件无错误。
- `uv run python scripts/build_addon.py`：生成 0.4.2 XPI、SHA-256 和清单。
- 当前主力 Zotero 中已安装并启用 0.4.2，插件管理器的 Version 也显示 0.4.2；安装文件与构建文件 SHA-256 一致。
- 运行中的端点可以处理包含浏览器 User-Agent 和协议头的请求。只读 poll 使用无效诊断会话返回 HTTP 200 + SESSION_EXPIRED，表示传输与路由正常，不代表网页已经连接。
- 浏览器扩展管理页被工具策略禁止访问，未尝试通过其他渠道绕过。油猴脚本仍需要用户更新至 1.0.1 并刷新 AI 页面。**真实网页发送、流式回传和上下文延续未在本轮完成端到端验收。**

## Review 留下的功能限制（本轮不扩展实现）

- 中文问题对英文 PDF 的 BM25 关键词检索可能为空：当前没有跨语言检索或开篇/结尾上下文兜底，不能将“未命中”理解为“文献没有相关内容”。见 `addon/content/relay.js:rankEvidence`、`addon/bootstrap.js:retrieveEvidence`。
- “总结本页”并未将当前阅读页码作为检索范围，“全文总结”也只发送少量命中片段，而非全文；快捷命令名称强于实际上下文范围。见 `addon/content/panel.js:QUICK_ACTIONS`、`sendMessage`。
- “截图”“上传附件”目前是提示用户随后在网页手动提供材料，没有实现自动截图或文件上传；使用指南已说明。不能将它们算作原截图示例中完整的自动化功能。
- 同一网页对话保留上下文，但侧栏“清空”或切换论文不会新建网页会话；用户若要完全隔离两篇论文，应在网页开新对话后连接。
- 本轮验证了同一浏览器内的标签页接管；不同浏览器 profile 的脚本存储锁不共享，多 profile 同时运行未验证。

结论：架构已经简化为 Zotero 原生 relay + 油猴，连接根因和临近阻断项已修复并部署 Zotero 端。浏览器脚本更新后的真实会话验收仍是交付剩余项；不应将当前状态描述成完整 Pro 功能已完成。
