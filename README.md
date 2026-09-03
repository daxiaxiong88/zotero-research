# Zotero Research 0.2

Zotero Research 是面向 Zotero 10 个人库的证据驱动科研阅读助手：右侧原生面板负责敏感全文的本机工作流，Codex 通过 stdio MCP 负责受策略约束的检索和元数据操作。它只调用 Zotero 官方 Local API，不读取或修改 `zotero.sqlite`。

完整的中文安装、设置、隐私说明、面板操作、MCP 契约和排障步骤见：[Zotero 10 中文使用指南](docs/USAGE_ZOTERO10.md)。

## 快速开始

1. 准备 Python 3.11+、`uv`、正在运行的 Zotero 10，以及项目环境 `.venv-zotero10`。不要使用仓库中旧的 `.venv`。
2. 复制 `.env.example` 为后端工作目录中的 `.env`，只填写自己实际配置的本地模型或可选云端模型；不要把密钥提交到 Git。
3. 在 Zotero 中手动安装 `dist/zotero-research-0.2.0.xpi`：工具 → 插件 → 右上角齿轮 → 从文件安装插件，然后由用户确认安装。
4. 在 Zotero“设置 → 高级”启用允许本机其他应用与 Zotero 通信。
5. 打开个人库中的本地 PDF；右侧显示“科研助手”后，在“设置”中填写本地模型和可选 MinerU 路径，保存后重新连接。

这是本地开发版 XPI。manifest 的 `update_url` 是
`https://zotero-research.invalid/updates.json`，`.invalid` 不是更新服务地址；不支持在线自动升级。安装新版时仍须由用户手动选择新的 XPI 文件。

## 安全边界

- 敏感全文从 Zotero 原生面板经本机回环 bridge 处理，不经过 Codex；本机回环服务若被用户部署为主动云转发，本项目无法保证物理离线。
- 所有 MCP 正文内容（PDF、证据片段和 notes）默认拒绝；必须先在 Zotero 本地取得与当前论文/附件匹配的授权，再由调用方显式设置 `allow_cloud=true`。Codex 不能自行铸造授权。书目和附件元数据仍可能进入调用客户端上下文。
- 公开论文不等于问题公开。面板发送“本次问题、选文和检索证据”到云端前，每次都必须单独勾选；Codex 的公开论文授权只绑定当前选中的 `attachment_key`，不连带同一条目的其他附件或私密草稿。已有 notes 另有独立公开确认，默认不放行。
- 高亮和笔记均先预览；高亮要确认精确原文、物理页码和颜色，笔记要经过 Zotero 原生写入授权及“确认内容并写入笔记”。写入结果未知时不会自动重试。
- 同一操作系统用户的其他程序仍可能拥有相同文件/进程权限；本工具的授权是应用边界，不是硬沙箱。

## 当前状态

本轮不下载模型、MinerU 权重或其他 GB 级文件，也不假称本机 AI/MinerU 已跑通。当前说明以“本机 Ollama 无模型、MinerU 无权重”为基线；未配置模型时面板只能显示带页码的证据摘录，不会假称翻译或模拟审稿完成。

Zotero 真实运行、主 profile 安装状态和最终验收以主线程记录为准；本文不宣称已装入主 profile，也不宣称与不可访问的 Feishu Pro 逐项等同。
