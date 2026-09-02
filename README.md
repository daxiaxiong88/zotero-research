# Zotero Research MCP

一个面向科研阅读、证据检索和结构化笔记的安全优先 MCP 服务。它只通过 Zotero 官方
Local API 访问文献库，永远不会读取或修改 `zotero.sqlite`。

## 当前能力

| MCP 工具 | 作用 | 外部状态变化 |
| --- | --- | --- |
| `health_check` | 检查 Zotero 版本、Local API 和写入能力 | 无 |
| `search_items` | 检索 Zotero 顶层文献 | 无 |
| `get_item_context` | 获取条目、PDF 附件和已有子笔记 | 无 |
| `extract_pdf` | 通过附件 key 提取逐页文本并评估质量 | 无 |
| `retrieve_evidence` | 返回带页码和稳定 evidence ID 的相关段落 | 无 |
| `generate_reading_card` | 生成研究问题、方法、结论、局限四段式阅读卡 | 可选模型处理 |
| `preview_child_note` | 生成转义后的精确笔记预览、摘要哈希和一次性令牌 | 仅进程内预览 |
| `request_write_authorization` | 请求 Zotero 10+ 显示官方写入授权对话框 | 用户授权 |
| `write_child_note` | 写入已确认且哈希完全匹配的子笔记 | 创建一条笔记 |

没有删除、批量修改、直接数据库访问或任意文件路径读取工具。

## 架构与安全边界

```text
Codex / MCP 客户端
        │ stdio
        ▼
Zotero Research MCP
  ├─ 隐私策略：敏感全文只能送本地模型
  ├─ 证据层：PDF 页码 + 稳定 evidence ID
  ├─ 解析路由：PyMuPDF 快路径 → 本地重解析接口
  └─ 写入闸门：预览 → SHA-256 → 人工确认 → 一次性提交
        │ http://127.0.0.1:23119/api/
        ▼
Zotero 官方 Local API
```

关键约束：

- Local API 地址被硬限制为 HTTP loopback、端口 `23119` 和 `/api/` 路径，不能改指向远程主机。
- PDF 只能通过 Zotero attachment key 定位，MCP 参数不接受任意磁盘路径。
- 默认把文档标为 `sensitive`。敏感全文即使设置 `allow_cloud=true` 也不会发送给外部模型。
- 公开全文只有在单次调用明确设置 `allow_cloud=true` 后，才允许发送给外部模型。
- 写入 payload 会安全转义并绑定 SHA-256；确认缺失、摘要不匹配、过期或令牌复用都会在 HTTP 写请求前失败。
- Zotero 9 及更早版本自动保持 `preview_only`。官方 Local API 写入只在 Zotero 10+ 放行。

Zotero Local API 与写入能力说明见
[Zotero 官方文档](https://www.zotero.org/support/dev/web_api/v3/local_api)。

## 本机安装与验证

要求：Python 3.11+、[`uv`](https://docs.astral.sh/uv/) 和正在运行的 Zotero。在 Zotero 的
“设置 → 高级”中启用“允许此计算机上的其他应用程序与 Zotero 通信”。

```powershell
cd D:\Research\ChatGPT
uv sync --dev
uv run zotero-research-doctor
uv run mypy
uv run pytest
```

本机已经注册了以下 Codex MCP：

```toml
[mcp_servers.zotero_research]
command = 'D:\Research\ChatGPT\.venv\Scripts\zotero-research-mcp.exe'
cwd = 'D:\Research\ChatGPT'
startup_timeout_sec = 15
tool_timeout_sec = 180
default_tools_approval_mode = "writes"
```

这符合 [Codex 官方 MCP 配置说明](https://developers.openai.com/codex/mcp)。注册后需要在
Codex 桌面端的 MCP 设置中重启/刷新服务器；新的任务也会自动读取同一份配置。

## 推荐使用流程

在 Codex 中可以直接这样说：

1. “在 Zotero 中检索 protein folding，列出最相关的 5 篇。”
2. “读取条目 `XXXXXXXX` 的 PDF，找出支持某个结论的证据，必须给出页码。”
3. “为条目 `XXXXXXXX` 生成阅读卡；这是未发表材料，只能本地处理。”
4. “把阅读卡做成子笔记预览，但先不要写入。”
5. 检查 `note_html` 和 `digest` 后，再明确要求授权并写入。

当前 Zotero 9.0.6 可以完整使用步骤 1–4；步骤 5 会被服务主动拒绝，升级到 Zotero 10+
后才会启用官方本地写入。

## 模型配置（可选）

不配置第二个模型时，`generate_reading_card` 会返回确定性的证据摘录卡；Codex 本身仍可基于
这些带页码证据进行分析。若希望 MCP 内部直接调用本地 Ollama/vLLM，可复制 `.env.example`
为 `.env`：

```dotenv
ZRM_MODEL_BASE_URL=http://127.0.0.1:11434/v1
ZRM_MODEL_NAME=your-local-model
ZRM_MODEL_TRUST=local
```

对于局域网内的本地推理服务器，必须显式设置 `ZRM_MODEL_TRUST=local`。外部 API 应设置为
`external`；API key 只放在 `.env` 或进程环境中，不能提交到 Git。

## PDF 重解析策略

PyMuPDF 是默认快路径。服务会根据可选文本量、空白页比例和乱码比例给出质量评分：

- 质量正常：`route=fast`。
- 疑似扫描件/乱码：`route=heavy_recommended`，不会自动上传或执行重型 OCR。
- 显式允许且配置了声明为本地的 `HeavyPdfParser`：`route=heavy_fallback`。

本机目前没有安装 MinerU，因此项目只启用了经过测试的本地回退接口，没有擅自下载模型或
大型依赖。后续接入 MinerU 时无需改 MCP 工具契约。

## 当前边界

- 尚未实现 Zotero 阅读器侧边栏和原生 PDF 高亮；这需要 Zotero 插件在其 JavaScript
  runtime 内调用注释 API，而不是由外部进程写数据库。
- 当前写入目标是个人库 `users/0` 的子笔记；组库写入尚未开放。
- 预览令牌只保存在内存中，默认 10 分钟有效；服务重启后自动失效。
- 结构化阅读卡是证据驱动的工作流，不替代人工核对原文、统计方法和引文状态。
