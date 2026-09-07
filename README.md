# Zotero Research 0.6.3

面向 Zotero 10 的网页 AI 阅读侧栏：在 Zotero 打开论文 PDF 后，用快捷命令或输入框把问题发送到当前浏览器中的 Gemini、DeepSeek、ChatGPT、Kimi、Claude 或 Google AI Studio，回答流式回到侧栏，并保留连续对话上下文。回答中的页码来源可以点击跳转回 PDF。

## 现在有什么

- 快捷命令：总结本页、翻译本页、部分总结、全文总结、填充笔记、上传材料、知识沉淀。「总结本页 / 翻译本页」优先取 PDF 阅读器的当前页面作为证据；不在阅读器中时回退为全文检索。
- 每篇文献的问答记录会保存在本机，重开该文献时自动恢复对话（可继续追问，网页模式可用「上次对话」回到原网页对话页）。
- 「知识沉淀」按主题整理知识点、方法、理解纠正、困惑与解答、尚未解决的问题，可复制或在条目下创建子笔记；不会仅因 AI 回答过就默认问题已解决。
- PDF 选文同步：在阅读器选中文字后，侧栏显示原文和页码，发送时自动带上。
- 网页 AI 自动中继：油猴脚本把侧栏消息填入已打开的网页 AI，并从网页 AI 自己的 API 流中捕获回答（含思考内容与完成信号），流式回传。
- 同一篇论文的连续对话：网页 AI 侧保持上下文，侧栏可继续追问。
- 侧栏只读取当前文献和 PDF；「填充笔记」生成可复制文字，不自动改写文献库。
- 分任务阅读提示词：翻译逐段保留原文，问答先回答再解释，公式解释变量、单位与假设。全文概览优先取完整提取文本，超过材料预算时改用标明范围的跨页摘录。
- API 直连的后续问答会携带此前提供的原文和完整问答对；不会重复发送本轮问题。材料截断和历史裁剪均在提示词中标明。

## 架构（v0.4 起与旧版不同）

    Zotero 插件（本进程）
      ├─ 侧栏面板：快捷命令 / 输入框 / 选文 / 页码证据
      ├─ 中继存储：任务队列 + 会话管理 + 流式回答
      ├─ 证据检索：Zotero.PDFWorker 提取全文 + 内置 BM25
      └─ 本机端点：http://127.0.0.1:23119/zotero-research/relay（Zotero 自带 HTTP 服务）
    浏览器油猴脚本：connect → 长轮询 poll → 自动填入网页并发送 → 捕获回答流 → update 回传

网页模式没有 Python bridge 进程、无需 API key 或配对令牌；网页 AI 通过 Zotero 本机端口直连。API 直连模式则使用你在插件设置中填写的模型配置。
Python 部分只保留只读 MCP 服务器（供 Codex 等客户端检索证据）。

## 快速安装

1. 运行 Zotero 10，并在「设置 → 高级」开启「允许此计算机上的其他应用程序与 Zotero 通信」。
2. 「工具 → 插件 → 齿轮 → 从文件安装插件」，选择 `dist/zotero-research-0.6.3.xpi`。
3. 在浏览器 Tampermonkey 中安装或更新 `userscripts/zotero-research-webai.user.js`，确认脚本版本为 **1.0.8**。更新 XPI 不会自动更新浏览器脚本。
4. 打开 Gemini、DeepSeek 等网页 AI；脚本自动连接 Zotero，右下角显示「已连接，等待 Zotero 消息」。
5. 在 Zotero 打开一篇带 PDF 的文献，点击快捷命令或直接提问。

从 0.6.2 更新到 0.6.3 只需更新 XPI；本次没有修改油猴脚本、API 配置或新增设置项；构建脚本会把上一个发布包自动留作 `dist/zotero-research-previous-stable.xpi` 用于回滚。更早版本的油猴脚本仍请更新到 1.0.8：1.0.5 之前的版本在后台标签页存在发送延迟（需切回页面才发出），1.0.3 之前的版本缺少图片投递。提示词结构、材料范围与验收边界见 [提示词设计说明](docs/PROMPT_DESIGN.md)。

0.6.3 优先压缩历史参考材料，再按完整问答裁剪。若单轮本身过长、没有任何完整问答能纳入蒸馏，则明确提示分段，不再发送空历史请求；实际覆盖范围会随结果显示。网页蒸馏继续携带本地记录，不要求旧网页对话仍然存在。

存档改为只保留一份追问原文，证据副本精简为页码和短摘要；旧档首次重新保存前留迁移备份，每篇文献的读取、保存和清空按顺序执行。完整规则与回滚注意事项见 [存档与预算说明](docs/STORAGE_AND_BUDGET.md)。

### 从 0.4.0 / 0.4.1 更新

- 必须同时更新 XPI 和油猴脚本，并刷新 AI 网页。旧脚本缺少 Zotero 10 要求的 `X-Zotero-Connector-API-Version: 3` 请求头，会被 Zotero 在进入插件前断开连接。
- 侧栏“打开网页”会让新打开的页面接管连接；已有对话请在该对话页使用油猴菜单“连接 Zotero”，继续沿用网页上下文。
- 连接切换或主动断开会结束已领取的任务，并显示重试提示，不会自动重复发送问题。
- 本轮审查与验证范围见 [连接修复审查记录](docs/REVIEW_CONNECTION_2026-09-05.md)。

## 安全边界

- 网页 AI 属于云端处理：你发送的问题、选文和证据片段会进入所选网页 AI。把内容发送到哪个网页，就是把内容交给谁；每次发送都是显式出网。
- 端点只接受本机请求（127.0.0.1:23119），拒绝 HTTP(S) 网页 Origin 的直接请求，允许油猴扩展请求；Zotero 的「允许其他应用通信」开关即总闸。
- 对话存档：每篇文献的问答会以**明文 JSON** 存在 Zotero 配置目录的 `zotero-research-sessions/` 下（每篇最多 500 条），用于重开文献时恢复；点侧栏「清空」会删除该文献的存档。这些文件和你的网页 AI 内容一样，属于本机本地数据。
- 写库是显式动作：侧栏默认不写文献库、不访问 zotero.sqlite；只有在「知识沉淀」结果上点「写入子笔记」时，才会在当前条目下创建一条子笔记。MCP 工具同样只读。
- 同一浏览器多标签页时只有一个页面持有连接锁，避免重复发送。
- 网页 AI 页面断开或被新页面接管时，旧页面会收到会话过期信号并停止工作。

## MCP（可选，供 Codex）

`zotero-research-mcp` 提供 8 个只读工具：search_items、get_item_context、extract_pdf、retrieve_evidence、generate_reading_card、analyze_paper、locate_quote、health_check。无模型配置时 analyze 返回带页码的证据摘录。安装：`uv pip install -e .`，命令 `zotero-research-mcp`（stdio）。

## 开发

- Python 测试：`uv run python -m pytest -o addopts='' -q`（另跑 mypy strict + ruff）
- 前端/油猴测试：`node --test tests-js/*.test.cjs`
- 打包 XPI：`.venv-zotero10\Scripts\python.exe scripts/build_addon.py`

详细使用说明见 [docs/USAGE_ZOTERO10.md](docs/USAGE_ZOTERO10.md)。
