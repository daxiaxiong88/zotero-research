# Zotero Research 0.4.7

面向 Zotero 10 的网页 AI 阅读侧栏：在 Zotero 打开论文 PDF 后，用快捷命令或输入框把问题发送到当前浏览器中的 Gemini、DeepSeek、ChatGPT、Kimi、Claude 或 Google AI Studio，回答流式回到侧栏，并保留连续对话上下文。回答中的页码来源可以点击跳转回 PDF。

## 现在有什么

- 快捷命令：总结本页、翻译本页、部分总结、全文总结、填充笔记、上传材料。「总结本页 / 翻译本页」优先取 PDF 阅读器的当前页面作为证据；不在阅读器中时回退为全文检索。
- PDF 选文同步：在阅读器选中文字后，侧栏显示原文和页码，发送时自动带上。
- 网页 AI 自动中继：油猴脚本把侧栏消息填入已打开的网页 AI，并从网页 AI 自己的 API 流中捕获回答（含思考内容与完成信号），流式回传。
- 同一篇论文的连续对话：网页 AI 侧保持上下文，侧栏可继续追问。
- 侧栏只读取当前文献和 PDF；「填充笔记」生成可复制文字，不自动改写文献库。

## 架构（v0.4 起与旧版不同）

    Zotero 插件（本进程）
      ├─ 侧栏面板：快捷命令 / 输入框 / 选文 / 页码证据
      ├─ 中继存储：任务队列 + 会话管理 + 流式回答
      ├─ 证据检索：Zotero.PDFWorker 提取全文 + 内置 BM25
      └─ 本机端点：http://127.0.0.1:23119/zotero-research/relay（Zotero 自带 HTTP 服务）
    浏览器油猴脚本：connect → 长轮询 poll → 自动填入网页并发送 → 捕获回答流 → update 回传

没有 Python bridge 进程、没有 API key、没有配对令牌；网页 AI 通过 Zotero 本机端口直连。
Python 部分只保留只读 MCP 服务器（供 Codex 等客户端检索证据）。

## 快速安装

1. 运行 Zotero 10，并在「设置 → 高级」开启「允许此计算机上的其他应用程序与 Zotero 通信」。
2. 「工具 → 插件 → 齿轮 → 从文件安装插件」，选择 `dist/zotero-research-0.4.7.xpi`。
3. 在浏览器 Tampermonkey 中安装或更新 `userscripts/zotero-research-webai.user.js`，确认脚本版本为 **1.0.2**。更新 XPI 不会自动更新浏览器脚本。
4. 打开 Gemini、DeepSeek 等网页 AI；脚本自动连接 Zotero，右下角显示「已连接，等待 Zotero 消息」。
5. 在 Zotero 打开一篇带 PDF 的文献，点击快捷命令或直接提问。

### 从 0.4.0 / 0.4.1 更新

- 必须同时更新 XPI 和油猴脚本，并刷新 AI 网页。旧脚本缺少 Zotero 10 要求的 `X-Zotero-Connector-API-Version: 3` 请求头，会被 Zotero 在进入插件前断开连接。
- 侧栏“打开网页”会让新打开的页面接管连接；已有对话请在该对话页使用油猴菜单“连接 Zotero”，继续沿用网页上下文。
- 连接切换或主动断开会结束已领取的任务，并显示重试提示，不会自动重复发送问题。
- 本轮审查与验证范围见 [连接修复审查记录](docs/REVIEW_CONNECTION_2026-09-05.md)。

## 安全边界

- 网页 AI 属于云端处理：你发送的问题、选文和证据片段会进入所选网页 AI。把内容发送到哪个网页，就是把内容交给谁；每次发送都是显式出网。
- 端点只接受本机请求（127.0.0.1:23119），拒绝 HTTP(S) 网页 Origin 的直接请求，允许油猴扩展请求；Zotero 的「允许其他应用通信」开关即总闸。
- 侧栏只读：本插件不写文献库、不访问 zotero.sqlite；MCP 工具同样只读。
- 同一浏览器多标签页时只有一个页面持有连接锁，避免重复发送。
- 网页 AI 页面断开或被新页面接管时，旧页面会收到会话过期信号并停止工作。

## MCP（可选，供 Codex）

`zotero-research-mcp` 提供 8 个只读工具：search_items、get_item_context、extract_pdf、retrieve_evidence、generate_reading_card、analyze_paper、locate_quote、health_check。无模型配置时 analyze 返回带页码的证据摘录。安装：`uv pip install -e .`，命令 `zotero-research-mcp`（stdio）。

## 开发

- Python 测试：`uv run python -m pytest -o addopts='' -q`（另跑 mypy strict + ruff）
- 前端/油猴测试：`node --test tests-js/*.test.cjs`
- 打包 XPI：`.venv-zotero10\Scripts\python.exe scripts/build_addon.py`

详细使用说明见 [docs/USAGE_ZOTERO10.md](docs/USAGE_ZOTERO10.md)。
