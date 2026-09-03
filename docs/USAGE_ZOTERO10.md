# Zotero Research 0.2：Zotero 10 中文使用指南

本文面向安装和使用 Zotero Research 的用户，涵盖原生侧边栏、本机服务、模型配置和 Codex MCP。当前这台机器的后端环境与 XPI 已准备好，可从“安装”开始；重建环境和重新打包仅供维护时使用。

## 先了解四个边界

1. **原生面板和 Codex 是两条入口。** Zotero 右侧“科研助手”面板通过本机 127.0.0.1 bridge 调用服务，敏感全文留在这条本地路径内，不经过 Codex。Codex 通过 stdio MCP 调用 12 个工具，MCP 响应会进入调用客户端上下文。
2. **MCP 正文默认拒绝。** PDF 正文、证据片段和 notes 等 MCP 内容，必须先由 Zotero 本地面板发出与当前论文/当前附件匹配的授权，然后调用方再显式设置 allow_cloud=true。MCP 不提供自授工具，禁止绕过本地确认。书目和附件元数据仍可能进入调用客户端上下文。
3. **“本地”不是物理离线承诺。** 本项目只把请求发往回环地址；如果用户自行运行的回环模型服务主动转发到云端，项目无法保证物理离线。同一操作系统用户的其他程序也可能拥有相同文件/进程权限，授权不是硬沙箱。
4. **公开论文不等于问题公开。** 面板发送“本次问题、选文和检索证据”到云端前，每次都必须明确勾选。论文公开不会自动公开用户问题；Codex 的论文授权只覆盖当前选中的 PDF，不包含同条目下未选中的附件。已有 notes 另有独立公开确认，默认不选。

已用合成文献在 Zotero 10.0.1 隔离配置中验收原生桥接、证据、笔记预览及原生高亮。主 profile 未安装；真实模型和完整手动点击仍待验收。完整范围见 [验收记录](VALIDATION_ZOTERO10.md)，不宣称与不可访问的 Feishu Pro 逐项等同。

## 1. 安装前准备

### 需要什么

- Zotero 10（扩展 manifest 的范围是 10.0 至 10.0.*）。
- Windows 上可运行的 Python 3.11+ 和 uv。
- 本仓库目录 D:\Research\ChatGPT，并使用专用环境 .venv-zotero10。不要切换到或修改旧的 .venv。
- Zotero 个人库中的已下载本地 PDF。当前原生扩展只接受个人库、可编辑且本机文件系统中的 PDF；组库、网络共享路径或未下载附件会被拒绝。

在 Zotero“设置 → 高级”打开“允许此计算机上的其他应用程序与 Zotero 通信”。后端检索和笔记使用官方 Local API，扩展高亮使用原生 JavaScript API；不扫描数据目录，不使用 zotero.sqlite。

### 准备专用 Python 环境

在仓库根目录运行下面的 PowerShell 命令。UV_PROJECT_ENVIRONMENT 只影响当前 PowerShell 会话，让 uv 使用 .venv-zotero10：

~~~powershell
Set-Location 'D:\Research\ChatGPT'
$env:UV_PROJECT_ENVIRONMENT = 'D:\Research\ChatGPT\.venv-zotero10'
uv sync --dev
~~~

复制配置模板并编辑副本：

~~~powershell
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
notepad '.env'
~~~

.env 必须位于 MCP/bridge 使用的工作目录中。绝不要把真实 API key 写入 .env.example、XPI、config.json 或 Git。配置名称和取值范围以 src/zotero_research_mcp/config.py 为准，见“配置与模型”。

### 安装 dist/zotero-research-0.2.0.xpi

这是本地开发版安装包。安装动作必须由用户在 Zotero UI 中手动确认：

1. 启动 Zotero，打开“工具 → 插件”（英文界面为 Tools → Add-ons）。
2. 点击插件管理器右上角齿轮菜单。
3. 选择“从文件安装插件”（Install Add-on From File…）。
4. 选择仓库中的 dist/zotero-research-0.2.0.xpi。
5. 阅读 Zotero 的安装确认并点击确认；若 Zotero 要求重启，按提示重启。

不要把 PowerShell 命令当成“自动安装 XPI”的替代品；本项目不提供静默安装，也不替用户点击确认。

manifest 的 update_url 为：

~~~text
https://zotero-research.invalid/updates.json
~~~

.invalid 是保留域名，不是真实更新服务。因此该包不支持在线自动升级。要安装新版，仍须在 Zotero 的齿轮菜单中再次手动选择新的 XPI；不要把页面上可能出现的更新地址当成可用下载站点。

### （维护者）如何生成安装包

普通用户只需要拿到 dist/zotero-research-0.2.0.xpi。如果主线程或维护者需要重新打包，必须使用已经存在的绝对本机 bridge .exe 和工作目录：

~~~powershell
Set-Location 'D:\Research\ChatGPT'
$env:UV_PROJECT_ENVIRONMENT = 'D:\Research\ChatGPT\.venv-zotero10'
& '.\.venv-zotero10\Scripts\python.exe' 'scripts\build_addon.py' `
  --bridge-executable 'D:\Research\ChatGPT\.venv-zotero10\Scripts\zotero-research-bridge.exe' `
  --working-directory 'D:\Research\ChatGPT'
~~~

默认产物是 dist/zotero-research-0.2.0.xpi，旁边会有 .sha256 和 .manifest.json。打包器不会安装 XPI，也不会启动或修改 Zotero；config.json 会把 bridge 可执行文件和工作目录绑定为打包时传入的绝对路径。若包来自另一台机器或路径已经移动，面板可能显示连接失败，需要维护者用当前机器路径重新打包。

## 2. 首次启动和连接

安装后，扩展会在启动时注册 Zotero 原生右侧“科研助手”面板和 PDF 阅读器选文入口。打开个人库中的一篇有本地 PDF 的文献，点击右侧导航中的“科研助手”。

面板顶部显示当前标题、item key、library/attachment 信息以及隐私状态。没有当前文献时，“开始分析”会禁用；切换文献或 PDF 附件会清空旧的选文、分析、云端勾选、Codex 授权选择、笔记预览和高亮预览。

“连接与模型”区域的“设置”按钮可打开扩展设置。bridge 由扩展自动启动，不需要用户另开一个 bridge 窗口；Codex 的 MCP 进程是另一条 stdio 入口，详见“在 Codex 中注册 MCP”。

如果连接失败，先检查：Zotero 正在运行、Local API 已启用、XPI 是用当前机器上的绝对 bridge 路径生成的，且 .env 在该工作目录中。不要手工粘贴 bridge token，也不要把 bridge URL 暴露给浏览器。

## 3. 设置面板

### 本地模型

在“科研助手”的设置页填写以下字段：

| 控件 | 作用 |
| --- | --- |
| 本地模型名称 | 留空时沿用后端 .env 的 ZRM_LOCAL_MODEL_NAME。只填写实际已经安装并运行的名称。 |
| 本地 OpenAI 兼容地址 | 必须是没有用户名、密码、查询参数或片段的回环 HTTP(S) 地址，例如 http://127.0.0.1:11434/v1。即使暂时没有模型，保存设置时也要填写一个合法地址。 |
| 已下载的完整 pipeline 模型目录 | 完整 MinerU pipeline 模型目录；空白时沿用 .env，两处均未配置时不启用重解析。 |
| MinerU 可执行文件 | 留空时沿用 .env 或 PATH 中的 mineru。 |
| 保存设置 | 写入 Zotero 偏好项；名称分别是 researchAssistant.localModelName、localModelBaseURL、mineruModelPath、mineruExecutable。 |
| 重新连接 | 保存后在没有正在处理的任务时重新启动 bridge。重新连接会清除尚未保存的预览；任务进行中不会被中断，忙碌时稍后重试。 |

云端模型名称和 API key 不在 XPI 设置页中填写，它们只配置在后端工作目录 .env。扩展不会自动下载模型。

### 当前本机基线

本轮验收明确没有下载 GB 级文件，也没有获得下载授权：本机 Ollama 没有可用模型，MinerU 没有权重。以下名称是占位符，不是推荐型号，也不代表实际 AI 或 MinerU 已运行：

~~~dotenv
# .env 中按需填写；不填写就保持证据摘录
ZRM_LOCAL_MODEL_BASE_URL=http://127.0.0.1:11434/v1
ZRM_LOCAL_MODEL_NAME=your-installed-local-model
~~~

面板 health.models 返回的 models.local/models.external 只是配置状态（模型名称字符串或 null），不是联网可用性或模型调用成功率。真正的分析结果还会在 PaperAnalysis.processing_location 中标记 local、external 或 none。

## 4. 配置与隐私策略

.env.example 已列出当前代码允许的配置名。最小安全配置如下：

~~~dotenv
ZRM_ZOTERO_BASE_URL=http://127.0.0.1:23119/api/
ZRM_MODEL_TIMEOUT_SECONDS=120
ZRM_NOTE_PREVIEW_TTL_SECONDS=600
ZRM_MINERU_EXECUTABLE=mineru
ZRM_MINERU_TIMEOUT_SECONDS=600
~~~

可选模型配置：

~~~dotenv
# 本地模型；两项按需一起填写
ZRM_LOCAL_MODEL_BASE_URL=http://127.0.0.1:11434/v1
ZRM_LOCAL_MODEL_NAME=your-installed-local-model

# 另一套 OpenAI 兼容模型；BASE_URL/NAME 必须成对出现
ZRM_MODEL_BASE_URL=填写实际 OpenAI 兼容地址
ZRM_MODEL_NAME=your-configured-model
ZRM_MODEL_TRUST=external
ZRM_MODEL_API_KEY=只填本机密钥，不要提交
~~~

上面的云端示例只是字段占位，不能直接运行，也没有给出推荐厂商或型号。ZRM_MODEL_TRUST=auto 会按地址判定，external 显式指定外部处理；不能把远程地址伪装为 local。ZRM_MODEL_API_KEY 只出现在本机 .env 或进程环境中。

MCP 的正文/证据/notes 披露没有可供 Codex 自行打开的“local 免授权”配置。无论调用方如何运行，云端 MCP 内容都必须同时满足：

- Zotero 本地面板已经针对当前论文的当前选中 PDF 发出有效的短期授权；
- 该次工具调用显式设置 allow_cloud=true；
- 敏感材料仍通过原生面板在本机处理，不转交云端 MCP。

Zotero Local API 的 ZRM_ZOTERO_BASE_URL 必须是 HTTP loopback、明确端口并以 /api/ 结尾；默认值是 http://127.0.0.1:23119/api/。ZRM_STATE_DIRECTORY 可选，留空时使用代码根据 Windows LOCALAPPDATA 计算的状态目录。

### 面板中的两种处理范围

面板“隐私与解析”默认选择：

- **敏感：仅本地处理（默认）**：云端复选框禁用；敏感全文留在本机原生面板路径。
- **公开：仍需逐次明确决定是否使用云端**：切换为公开并不自动上传。只有勾选下面的原文文案才允许本次云端处理：

  > 我明确允许将本次问题、选文和检索证据发送到云端（论文公开不代表问题公开）

这次勾选涵盖当前问题、选文和检索证据，不包含 notes。分析请求结束后云端勾选会清除；切换文献也会清除。若服务返回 processing_location=external 却没有本次同意，面板会显示“隐私异常（拒绝显示模型结论）”，不会把已经发生的外部处理说成“已降级”或伪装成本地处理；应停止使用并检查 bridge/后端配置。

没有本地或外部可用模型时，面板仍可生成页码证据摘录；review（模拟审稿）和 translate（翻译）不会假称完成。question 模式仍须输入问题；translate 需要先在 PDF 中选中原文。

## 5. Zotero 阅读器、快捷键和选文

### 快捷键

在 Zotero 阅读器标签页中按 Ctrl+Alt+R：

1. 扩展确认当前确实有阅读器；
2. 展开/切换右侧上下文面板；
3. 打开“科研助手”并把焦点放到问题输入框。

没有阅读器标签页时快捷键不会伪造文献上下文。

### 选文

1. 打开个人库中的本地 PDF，在阅读器里用鼠标选中原文。
2. 在选文弹出菜单点击“发送到科研助手”。选文必须是可核实的 PDF 原文，长度不超过 12000 字。
3. 扩展会捕获 attachment_key、原文、物理页码，以及可用的坐标/排序信息；选文仅在本机面板内保存一段短期快照。
4. 回到右侧面板。“已选原文”会显示纯文本快照和页码按钮；点击页码可以回到 PDF 对应的物理页。

若选文不可用，请确认是在个人库 PDF 中操作、附件已下载且没有切换文献库；重新选择后再发送。切换文献会丢弃旧选文，避免旧附件的异步结果污染新文献。

## 6. 面板工作流

### 分析模式

面板“研究动作”提供以下固定模式：

| 面板名称 | 代码值 | 作用与限制 |
| --- | --- | --- |
| 精读 | reading | 依据页码证据整理研究问题/假设、方法、主要发现和局限。 |
| 问答 | question | 回答输入的问题；必须填写问题，并区分原文、推断和证据不足。 |
| 模拟审稿 | review | 明确标注为模拟的投稿前审阅，不代表期刊决定；没有模型时不会假称完成。 |
| 解释 | explain | 解释选文或公式；提取损坏时提示核对，不补造符号或推导。 |
| 翻译 | translate | 忠实翻译已选原文；必须先有 PDF 选文，并保持数值、单位和公式。 |

点击“开始分析”后，面板会禁用重复提交并显示状态。结果包含 sections 和 evidence：每个 section 有 title、content、evidence_ids；每条 evidence 有稳定 ID、物理页码、原文、相关度和 source。论文/模型提供的内容都按纯文本显示，不执行其中的 HTML、链接、脚本或指令。

结果顶部会标记处理位置：

- local：本地模型处理；
- external：本次已明确允许且服务报告外部处理；
- none：仅证据摘录，没有模型；
- 隐私异常（拒绝显示模型结论）：服务报告了未经本次同意的外部处理，模型结论被隐藏。

### 页码证据和导航

“页码证据”逐条显示 evidence_id、原文、物理页码和 source。点击证据旁的页码按钮调用原生导航适配器并打开对应 PDF 页面；页面编号从 1 开始。PDF 印刷页码标签与物理页码可能不同，优先以面板标明的物理页码核对。

### 高亮：先预览，再原生保存

1. 在某条证据上点击“准备高亮”。
2. 面板调用本机 prepareHighlight，核对精确原文和 PDF 位置；选文坐标可用时优先使用选文坐标，否则要求附件上的文字能够唯一定位。
3. “高亮预览”会显示精确原文、物理页码、颜色和有效期。当前默认颜色由原生适配器提供（通常显示为 #ffd400）。
4. 用户核对无误后，点击“确认并写入高亮”。这一步才调用原生 Zotero 注释保存；没有确认不会写入。

扫描件、重复文字或无法唯一定位时会拒绝准备，不会猜坐标。写入结果未知时，面板显示“写入结果未知，未自动重试”；请先检查 Zotero 中是否已有高亮，不能重复点击提交。

### 笔记：纯文本优先，原生授权后保存

1. 分析完成后填写“笔记标题”，或使用默认的“论文标题 — 阅读笔记”。
2. 点击“生成笔记预览”。这只生成内存中的短期预览，不写 Zotero。
3. 预览优先显示 NotePreview.note_text（完整标题和正文纯文本）；若没有 note_text 才显示 note_html，并且仍按纯文本显示，不执行 HTML。需要核对底层格式时可展开“查看实际写入的 HTML 源码”；该源码同样以 textContent 安全展示，不会执行。digest 在界面称为“校验码”，同时显示有效期；随机 preview token 不要求用户核对。
4. 生成内容保留回溯链：每个分析 section 的标题、正文和 evidence_ids 会保留；证据列表逐条保留 evidence ID、物理页码、source 和原文。
5. 点击“请求 Zotero 写入授权”，接受 Zotero 原生本地授权对话框。未授权时不会调用 write_note。
6. 再次核对标题、正文、证据链、可选的 HTML 源码和“校验码”，点击“确认内容并写入笔记”。只有这次明确确认才提交一次性预览。

预览默认 10 分钟有效，服务重启后内存预览会失效；过期或内容改变时必须重新生成。Zotero 不支持本地写入时会保持预览模式。写入结果未知时先在 Zotero 中检查，不自动重试。

## 7. 公共文献授权、撤销和 DOI 核验

### Codex 读取当前公开 PDF 的 10 分钟授权

这是一项给 Codex 读取正文的本地控制，不是面板每次分析的云端勾选，也不是对整个 Zotero 条目的泛化授权：

1. 在当前文献面板中确认要公开处理的具体 PDF。已发表且公开的 PDF 可以作为候选；同一条目下的私密草稿、补充附件或其他未选文件不会因为这次操作顺带获得授权。
2. 在“Codex 临时读取授权”勾选：

   > 我确认当前 PDF 已公开，允许 Codex 读取 10 分钟（不包含其他附件）

3. 如需同时允许读取当前条目的已有 notes，另行勾选（默认不选）：

   > 另外允许读取本条目的已有笔记；我确认其中内容也已公开（默认不选）

4. 确认当前选中的 attachment_key 后点击“授权 10 分钟”。bridge 的 grant_cloud_access 请求包含 item_key、该 attachment_key、confirmed_public=true 和 include_notes；未勾选 notes 时 include_notes=false。PDF 授权只覆盖这一份当前 PDF，不覆盖其他附件；notes 是独立选择。
5. 在授权有效期内，Codex 仍需在具体 MCP 调用中显式设置 allow_cloud=true；没有有效本地回执时，MCP 正文默认拒绝。
6. 该授权最多 10 分钟。PDF 授权不自动包含 notes；只有用户另行勾选并确认 notes 公开时，才会将本条目已有 notes 纳入授权。切换文献或 PDF 附件、以及每次申请完成后，两个公开确认框都会清空。
7. “撤销当前文献读取授权”按钮在有当前文献时始终可用，与本面板是否保留本地 grant 回执无关。切换文献或重新打开面板后，UI 不会恢复旧回执为“已授权”；这只是当前面板不持有状态，不应据此把底层状态说成“未授权”。需要停止当前文献的读取时，直接点击撤销并等待服务结果。
8. 回执到期后面板会清除 UI 中的授权状态；撤销结果未知时面板不擅自改写授权状态，也不自动重试。

这个授权不会公开用户问题，不会授权同一条目下的私密草稿或其他附件。notes 只有在独立复选框明确确认公开时才可能进入允许范围；Codex 不能通过 shell、任意文件读取或 MCP 参数给自己铸造回执。

### DOI 公网元数据核验

DOI 核验是另一条、与云端模型和论文读取授权分离的公网操作：

1. 在“DOI 核验”文本框中每行输入一个 DOI（也接受逗号或分号分隔；服务最多接受 20 条）。
2. 勾选：

   > 我明确允许本次使用公网公开元数据核验 DOI（不发送全文）

3. 点击“核验 DOI”。本次请求只访问公开 Crossref 元数据，不发送 PDF 全文；请求结束后该勾选会清除。
4. 面板按 CitationAuditReport.results 逐条显示 DOI、简明中文状态、issues 问题、来源和时间；若返回 details，仅作为诊断 JSON 保留，不作为主要结果。

常见状态包括：

| 状态 | 面板含义 |
| --- | --- |
| no_notice_found | 本次未检出更新公告，**不等于无撤稿**。 |
| retraction_signal / correction_signal / update_signal | 发现撤稿/撤回、勘误/更正或更新线索，应核对出版方公告。 |
| title_mismatch / year_mismatch / metadata_mismatch | 输入的书目信息与返回元数据不匹配。 |
| identity_mismatch | 返回 DOI 身份不一致，目标未核实。 |
| timeout、connection_error、rate_limited、unknown 等 | 状态未知或核验失败；不能据此确认“没有撤稿”。 |

未勾选时不会发送 DOI；公网核验不会读取或上传全文。

## 8. 在 Codex 中注册 MCP

本机 C:\Users\xzh21\.codex\config.toml 中的 Zotero 服务已切换到新环境。其他机器可加入下面的配置，但不要重复创建同名区块；已有配置只改相应字段。路径和超时字段依据 [OpenAI 官方 MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

~~~toml
[mcp_servers.zotero_research]
command = 'D:\Research\ChatGPT\.venv-zotero10\Scripts\zotero-research-mcp.exe'
cwd = 'D:\Research\ChatGPT'
startup_timeout_sec = 15
tool_timeout_sec = 2460
default_tools_approval_mode = "writes"
~~~

注册或修改后，在 Codex MCP 设置中刷新/重启服务器。该配置启动的是 stdio MCP，不是 Zotero 原生 bridge；XPI 启动的 bridge 由扩展管理，不需要把随机端口写进 Codex 配置。

2460 秒是等待上限，不是固定耗时：它容纳代码允许的 MinerU 最长 1800 秒、模型最长 600 秒及通信余量。普通请求完成后立即返回。已有任务可能仍缓存旧工具列表；刷新服务或重新打开任务后，应看到 12 个工具。请勿为了重装依赖强行覆盖仍在运行的旧 .venv 程序。

### 实际注册的 12 个 MCP 工具

以下是 src/zotero_research_mcp/server.py 注册的完整 12 项。grant_cloud_access、revoke_cloud_access 和 shutdown 是本机 bridge 的控制方法，不计入 MCP 工具数。

| MCP 工具 | 主要参数 | 结果/边界 |
| --- | --- | --- |
| health_check | 无 | HealthReport：Zotero 连接、API/写入能力和 sqlite_access=forbidden。bridge health 另有 models.local/external 配置状态。 |
| search_items | query、limit | 顶层文献检索 SearchResults；只返回书目元数据。 |
| get_item_context | item_key、include_notes=false、allow_cloud=false | 条目、附件和可选 notes；默认 notes 为空。读取 notes 需要独立内容授权。 |
| extract_pdf | attachment_key、allow_heavy_fallback=false、allow_cloud=false、force_heavy=false | 逐页文本、解析器、质量和路由；重解析只允许本地配置。 |
| retrieve_evidence | attachment_key、query、top_k=5、重解析/云端参数 | 带稳定 evidence ID、物理页码和 source 的证据片段。 |
| generate_reading_card | item_key、可选附件、sensitivity、allow_cloud、重解析参数 | 四段式阅读卡；有 sections、evidence、warnings 和 mode。 |
| analyze_paper | item_key、附件、mode、问题/选文、sensitivity、allow_cloud、重解析参数 | PaperAnalysis；processing_location 为 local/external/none。云端调用须有本地公开论文/当前附件授权和显式允许。 |
| locate_quote | attachment_key、1-based page、quote、allow_cloud=false | 只定位唯一文字和坐标，不写注释；模糊或扫描文本会拒绝。 |
| audit_citations | requests（最多 20 个 DOI/题目/年份）、allow_network=false | CitationAuditReport.results 和 warnings；只查公开 Crossref 元数据，不发送 PDF。 |
| preview_child_note | parent_item_key、title、content、可选 tags | NotePreview：note_html、note_text、digest/校验码和有效期；不写 Zotero。 |
| request_write_authorization | 无 | 请求 Zotero 10+ 原生本地写入授权，不返回 API key。 |
| write_child_note | preview_token、expected_digest、confirmed_by_user | 只写入一份完全匹配且用户确认的子笔记；一次性、不可安全重放。 |

MCP 工具没有删除、批量修改、任意磁盘路径读取或直接 SQLite 访问能力。expected_server_id、bridge token 和请求封装由原生 bridge/客户端处理；用户不需要手工填写，也不应尝试绕过。

### MCP 正文披露规则

对于云端 MCP 调用方（默认边界）：

- 搜索结果、条目标题/作者/DOI 等元数据仍可能交给调用客户端；这不等于已经允许正文。
- PDF 正文、证据和 notes 默认拒绝。公开论文必须先在 Zotero 面板本地取得当前选中 attachment_key 的短期回执，并在本次工具调用显式 allow_cloud=true。
- 已发表公开 PDF 的回执只覆盖用户当时选中的那一份附件；同一条目下的私密草稿、补充附件或其他 PDF 不会被顺带授权。
- 禁止 Codex 通过 shell、任意文件读取或工具参数伪造回执；这是一项操作规则，不是同一用户文件权限下不可绕过的系统沙箱。敏感材料请在 Zotero 原生面板处理。
- notes 默认不包含在 grant_cloud_access 的授权中；若用户明确确认 notes 也已公开，可在原生面板独立勾选后将 include_notes 设为 true。

## 9. 可用能力矩阵

| 入口/场景 | 允许的数据 | 用户同意 | 模型/网络 | 写入 | 不能做什么 |
| --- | --- | --- | --- | --- | --- |
| Zotero 原生面板 · 敏感 | 当前个人库 PDF 的选文、页码证据和分析所需片段 | 默认本地；云端复选框禁用 | 本地模型若已配置；无模型时仅证据摘录 | 高亮需预览确认；笔记另需原生写入授权 | 不经过 Codex；不保证用户回环服务不会自行转发云端 |
| Zotero 原生面板 · 公开 | 当前问题、选文、检索证据可按本次选择发送 | 每次分析明确勾选，切换文献/请求结束清除 | 外部模型仅在服务报告 external 且本次同意时显示 | 同上 | 论文公开不会公开问题或 notes |
| Codex MCP · 默认 | 书目、附件元数据、搜索结果 | 正文/证据/notes 默认拒绝；无免授权模式 | 只能看到策略允许的内容 | preview_child_note 只是预览 | 不能自授正文、不能读任意路径 |
| Codex MCP · 当前公开 PDF | 当前 attachment_key 的 PDF/证据 | Zotero 面板本地 10 分钟回执 + 每次 allow_cloud=true | 进入 Codex 调用上下文 | 不因读取授权获得写权限 | 不覆盖同条目其他附件；notes 需独立确认 |
| Codex MCP · 当前公开 PDF + notes | 当前 attachment_key 的 PDF/证据，以及本条目已有 notes | PDF 回执之外，另勾选 notes 已公开 + 每次 allow_cloud=true | 进入 Codex 调用上下文 | 不因读取授权获得写权限 | 不覆盖同条目其他附件；默认不含 notes |
| DOI 核验 | DOI、题目/年份和公开 Crossref 元数据 | 每次单独允许公网；不发送全文 | 公网元数据；不是论文模型分析 | 无 | no_notice_found 不等于未撤稿 |
| 高亮 | 证据原文、物理页、精确定位和颜色预览 | 用户点击“确认并写入高亮” | 不需要模型生成坐标；原生 API 保存 | 创建单条 Zotero 高亮 | 无法唯一定位时拒绝，不猜坐标、不自动重试 |
| 子笔记 | note_text 优先的完整标题/正文、section evidence_ids、证据 ID/页码/source | Zotero 原生写入授权 + “确认内容并写入笔记” | 本机预览 TTL 默认 10 分钟 | 创建一条个人库子笔记 | 不显示 token 供用户核对；未知结果不重试 |
| 本地重解析 | 本机 PDF 和本机 MinerU pipeline | 面板勾选允许重解析，可再强制本次使用 | 仅本地、不会自动云端或下载 | 无 | 允许 fallback 但没有权重/可执行文件时明确失败 |

## 10. MinerU 按需重解析

默认使用 PyMuPDF 快速解析；allow_heavy_fallback=false 是默认值。质量判断可以提示 route=heavy_recommended，但提示本身不会自动执行重解析、上传或下载。

对扫描件、公式或复杂版面，可在面板勾选：

- **允许本地重解析兜底**：允许当前任务在实际需要时走本地重解析；
- **强制本次使用重解析**：只有先允许本地重解析后才可选。

后端对应的环境变量是：

~~~dotenv
ZRM_MINERU_MODEL_PATH=C:\absolute\path\to\your\downloaded\full-pipeline-model
ZRM_MINERU_EXECUTABLE=mineru
ZRM_MINERU_TIMEOUT_SECONDS=600
~~~

ZRM_MINERU_MODEL_PATH 必须指向完整、已由用户准备好的 pipeline 模型目录；本项目不会下载权重或大型依赖。当前本机没有 MinerU 权重。

如果用户勾选允许本地重解析、任务实际需要重解析，但可执行文件或完整模型目录没有配置，服务会明确报告 PDF 解析失败；不会静默改回快速摘录，也不会把“仅证据摘录”伪装成重解析成功。失败提示应检查 MinerU 可执行文件、完整本地模型目录和超时配置；没有自动上传或下载。

## 11. 排障

### 面板不出现或没有当前文献

- 确认安装的是 Zotero 10 范围内的 XPI，并在“工具 → 插件”中确认扩展已启用。
- 选择个人库中的顶层文献，并确保至少有一个已下载的 PDF 附件；组库、删除条目、网络共享附件和非 PDF 文件不支持。
- 在阅读器标签页按 Ctrl+Alt+R，或先选中文本并点击“发送到科研助手”。
- 如果只是更换了文献，等待异步上下文刷新；旧结果按设计会被丢弃。

### 显示“连接失败”或 bridge 启动失败

1. Zotero“设置 → 高级”重新确认已允许本机应用通信。
2. 检查 XPI 是在当前机器上用存在的绝对 zotero-research-bridge.exe 打包，且 config.json 中的工作目录仍存在。
3. 检查 .env 位于打包时工作目录；使用 .venv-zotero10 中的程序，不要启动旧 .venv 的脚本。
4. 运行只读诊断：

   ~~~powershell
   Set-Location 'D:\Research\ChatGPT'
   $env:UV_PROJECT_ENVIRONMENT = 'D:\Research\ChatGPT\.venv-zotero10'
   & '.\.venv-zotero10\Scripts\zotero-research-doctor.exe'
   ~~~

5. 在设置页保存合法回环模型地址后点击“重新连接”；有任务进行时先等待。不要复制或手工修改 bridge token。

若提示“文献库不一致”或 instance mismatch，说明扩展和后端看到的 Zotero 实例/expected_server_id 不一致。回到当前 Zotero 实例重新连接；bridge 负责校验，不应手工绕过。

### health 显示有模型但分析仍失败

health.models.local/external 只表示配置中是否有模型名称，不代表端点可联网、模型已加载或请求成功。检查：

- 本地模型名称是否确实存在，地址是否为无凭据的回环 HTTP(S) 地址；
- 云端模型的 ZRM_MODEL_BASE_URL 与 ZRM_MODEL_NAME 是否成对设置，ZRM_MODEL_TRUST 是否符合实际；
- 当前是否选择敏感模式、公开但未勾选本次云端同意，或服务报告了 processing_location=external 的隐私异常；
- 没有模型时请接受“仅证据摘录”，不要把它描述为翻译或模拟审稿结果。

### 解析失败或需要公式/扫描件

- 默认先使用快速解析；route=heavy_recommended 只是提示。
- 仅在用户确认后勾选本地重解析；如果实际需要而未配置完整模型目录/可执行文件，应显示明确失败，而不是静默回退为摘录。
- 检查 ZRM_MINERU_MODEL_PATH 是完整 pipeline 目录，而不是空目录或单个文件；检查 ZRM_MINERU_EXECUTABLE 能在指定工作目录/PATH 运行。
- 当前没有 MinerU 权重；未授权下载前不要自行下载 GB 级文件。
- 失败不会自动上传或下载。保留错误信息并在准备好本地依赖后重试；不要把失败当成成功的证据结果。

### 云端正文被拒绝或授权状态看起来不一致

- 分析：选“公开”，再勾选明确写着“本次问题、选文和检索证据”的复选框；请求结束后它会清除。
- Codex 读取：确认在当前论文面板选中了正确的 PDF，勾选“我确认当前 PDF 已公开，允许 Codex 读取 10 分钟（不包含其他附件）”；已有 notes 若要读取，还必须单独勾选“另外允许读取本条目的已有笔记；我确认其中内容也已公开（默认不选）”。PDF 授权只覆盖该 attachment_key，不覆盖私密草稿/其他附件。
- 每次申请完成后、切换文献或切换 PDF 附件，两个公开确认框都会清空；重新选择后再申请。
- 切换文献或重新打开面板后，UI 不恢复旧 grant 回执为已授权。这不是“底层未授权”的证明；当前文献的撤销按钮仍应可用，点击后以服务返回为准。
- 回执到期时 UI 会清除 grant。撤销结果未知时不要假设已经撤销，也不要连续重试。

### 高亮或笔记没有写入

- 高亮：必须先看到精确原文、物理页码、颜色和有效期，再点击“确认并写入高亮”。无法唯一定位时先在 PDF 中重新选文。
- 笔记：必须先“生成笔记预览”，接受 Zotero 原生写入授权，再点击“确认内容并写入笔记”。查看“校验码”和证据链，不需要核对随机 token。
- Zotero health.write_mode 为 preview_only 时只能预览；个人库和 Zotero 10+ 官方写入能力缺一不可。
- 任何 write_note/高亮写入结果未知，都先检查 Zotero 再决定后续处理；本项目不会自动重试，避免重复创建。

### DOI 结果不符合预期

- 没有勾选公网许可时，面板不会发送 DOI。
- 结果字段是 CitationAuditReport.results，不是 items；面板会显示中文状态和 issues，可选 details 仅用于诊断。
- “本次未检出更新公告”不等于“没有撤稿”；网络超时、限流、连接失败和未知状态也不能当作安全通过。

## 12. 当前不提供的能力

- 不读取或修改 zotero.sqlite，不扫描任意磁盘路径，不接受网络共享 PDF。
- 不提供删除、批量修改或任意路径写入；笔记只通过预览、摘要校验、Zotero 原生授权和明确确认创建。
- 当前原生扩展只面向 Zotero 个人库中的可编辑 PDF；组库写入未开放。
- 未配置本地模型时不提供真实翻译、问答模型结论或模拟审稿结论，只显示证据摘录。
- 本轮没有下载 Ollama 模型、MinerU 权重或 GB 级文件；文档中的模型名称均为可替换占位符。
- 参考的 Feishu Pro 页面未在本轮读取，因此不宣称商业插件逐项等价。
