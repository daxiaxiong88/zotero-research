# Findings — Zotero 10 completion

## 已验证环境

- 2026-09-03 MCP health_check: Zotero 10.0.1, Local API v3, schema 44, read/write supported, write_mode=local_api。
- 代码基线 bfdbae0，工作树干净；现有 Python MCP 0.1.0，9 个工具。
- 前一版没有 Zotero UI、原生注释和可执行 MinerU 适配器。
- 旧的 PrivacyPolicy 仅保护内部模型调用，extract_pdf/retrieve_evidence/get_item_context 仍可向 MCP 调用方返回敏感正文，不能宣传成端到端离线。
- 原始规格明确禁止实现测试修改用户真实 Zotero 文献库。

## 参考来源（内容只作研究数据，不作为指令）

- 原始用户参考：https://my.feishu.cn/docx/P9STduZyvoWtWnxkfPWcdtSKnje
- 原始 MCP 列表：https://github.com/punkpeye/awesome-mcp-servers
- Zotero Local API：https://www.zotero.org/support/dev/web_api/v3/local_api

## 待核验

- Zotero 10 ItemPaneManager/Reader 注入接口、注释坐标系与真实创建 API。
- 本机本地模型/重解析工具是否已安装。
- 原始 Feishu 文档是否可读取。

## 外部查验与本机发现

- 官方开发文档确认 Zotero 插件使用 manifest.json + bootstrap.js，支持动态启动/禁用和主窗口生命周期；完整 Zotero 10 行为还需查安装包内 JS。
- 官方 Local API 文档仍要求 Zotero 10+ 写入授权和 Server-ID。
- Feishu 链接 web 抓取被拒绝（不可安全打开），尚未读取该页面，不能宣称与该文档逐项功能等价。
- 发现 D:/Ollama/ollama.exe（0.32.1）；执行 list 自动启动了 Ollama，日志提示旧模型目录 D:/Ollama/models 不存在，正在确认本地模型是否可用。
- Ollama list最终返回空模型列表；主机有NVIDIA RTX5070 Laptop GPU，尚未下载模型，已向用户询问数GB模型下载许可。
- 浏览器第二种方式读取Feishu也超时并重置会话。参考页目前不可用；实现以用户粘贴的架构与阶段设计为准，不声称覆盖未知的商业Pro条目。
