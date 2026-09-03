# Zotero Research 0.2 — 本机科研助手

## 可观察的目标

- Zotero 10 个人库/阅读器右侧出现“科研助手”原生面板，支持选文送入、精读、问答、翻译/解释、模拟审稿。
- 证据展示 PDF 物理页码与原文，点击可定位；原生高亮只使用已核实坐标并经用户确认。
- 笔记在 Zotero 中预览、授权和保存，摘要/令牌保护不变，不直接操作数据库。
- 敏感内容只在本机界面和回环模型之间流转；MCP 返回正文须本地公开论文授权与调用方显式同意。
- 本地 MinerU 真正执行按需重解析；未装依赖/模型时明确报错，不隐式上传或下载。
- DOI核验使用公开元数据，外网查询必须由用户允许，未知撤稿状态不能被表述为无撤稿。

## 两个入口，共用应用服务

1. Codex → stdio MCP：默认只返回书目信息；正文/已有笔记有独立内容授权。
2. Zotero 原生扩展 → 私有本机 HTTP bridge → ResearchService：正文不经过 Codex。

扩展启动 bridge 子进程，bridge 绑定 127.0.0.1 随机端口，并只在 stdout 首行返回
`{"protocol":1,"url":"http://127.0.0.1:PORT","token":"随机令牌"}`。
令牌只存于扩展进程内，不放 URL、日志或 MCP 返回值。每个 HTTP 请求带 Bearer token。
拒绝非本机 Host、任何浏览器 Origin、未授权请求、超大请求和未知方法。stdin 关闭即结束 bridge。

所有数据来自当前 Zotero 的官方 Local API，URL固定回环23119。桥接请求额外校验
`expected_server_id`，防止扩展和后端误接到不同文献库。原生注释只在扩展 runtime 中创建。

## 本机 RPC 契约

请求：`POST /rpc`，`Content-Type: application/json`，`Authorization: Bearer TOKEN`。
JSON：`{"method":"方法","params":{...},"expected_server_id":"当前Zotero实例ID"}`。
响应：成功 `{"ok":true,"result":{...}}`；失败 `{"ok":false,"error":{"code":"...","message":"..."}}`。
错误不得回显正文、token、API key或完整本地路径。

| method | params | result |
| --- | --- | --- |
| health | {}；可不传expected_server_id | HealthReport + models(local/external名称和可用配置) |
| item_context | item_key | ItemContext（本地界面可读已有笔记） |
| analyze | item_key, attachment_key?, mode(reading/question/review/explain/translate), question?, selected_text?, selection_page?, sensitivity(sensitive/public), allow_cloud=false, allow_heavy_fallback=false, force_heavy=false | PaperAnalysis |
| reading_card | item_key, attachment_key?, sensitivity, allow_cloud, allow_heavy_fallback | ReadingCard |
| evidence | attachment_key, query, top_k=5, allow_heavy_fallback=false | EvidenceResults |
| locate | attachment_key, page(1-based), quote | QuoteLocation(status,text,rects,page,page_label,sort_index,reason) |
| preview_note | parent_item_key, title, content, tags? | NotePreview |
| authorize_write | {} | WriteAuthorization（不含key） |
| write_note | preview_token, expected_digest, confirmed_by_user=true | NoteWriteResult |
| grant_cloud_access | item_key, confirmed_public=true, include_notes=false | PublicContentGrant（10分钟，到期失效） |
| revoke_cloud_access | item_key | {revoked:true} |
| audit_citations | requests:[{doi,title?,year?}], allow_network=false | CitationAuditReport |
| shutdown | {} | {stopping:true} |

`PaperAnalysis`: item_key, attachment_key, title, task, mode(evidence_only/model), generated_by,
sensitivity, sections:[{title,content,evidence_ids:[]}], evidence:[EvidenceSpan], warnings:[]。
EvidenceSpan与现有MCP契约相同：evidence_id、page、chunk_index、text、score、source。

## 前端设计方向

主体是科研阅读，不是通用聊天门户；保持 Zotero 原生面板的紧凑密度。页码证据边栏是唯一视觉重点。

- 色彩：ink #25354A；page #F9FAFC；source-blue #2C5CC5；local-green #237765；attention #A56318；line #D8DFEA。
- 字体：文献标题 Georgia/宋体衬线（克制使用）；正文 Segoe UI/微软雅黑；页码/摘要标识 Consolas。
- 布局：文献标题与隐私状态 → 已选原文 → 模式/问题 → 分析结果 → 带页码证据 → 笔记/高亮预览。
- 签名细节：原文旁固定页码按钮，阅读结论能随时回到 PDF；不加宣传标语或无意义装饰。
- 键盘焦点可见、暗色主题、窄面板不横向溢出；异步请求禁用重复提交，有明确错误/取消/无模型提示。
- 所有模型和论文内容均用 textContent 渲染；不执行论文/模型给出的 HTML、链接或指令。

## 需要诚实说明的边界

- 没有本地模型时只能给证据摘录，不伪装成已经完成翻译或审稿。
- “本地”只能约束本项目向回环端点发送；用户部署的回环端点若主动转发云端，本项目无法证明其物理离线。
- 本工具权限策略不隔离拥有同一用户文件权限的其他程序，也不能限制 Codex 另行使用shell；不允许主动绕过内容授权。
- 参考 Feishu 页面尚未读取，不宣称商业插件逐项功能等价。
