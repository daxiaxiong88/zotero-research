# Zotero AI 科研阅读助手

一个面向 **Zotero 10** 的论文阅读侧边栏。你可以一边阅读 PDF，一边把当前页、选中文字或全文材料交给浏览器中的 Gemini、DeepSeek、ChatGPT、Kimi、Claude、Google AI Studio，也可以直接连接兼容 OpenAI / Anthropic 协议的模型 API。AI 的回答会自动回到 Zotero，并在同一篇论文下保留连续对话。

## 效果演示

<video src="https://github.com/user-attachments/assets/10eed7ee-1096-41f4-a54a-b4f40a553c52" controls preload="metadata" muted></video>

*完整的问答、公式渲染与页码跳转演示；视频无法播放时请直接阅读下方说明。*

## 它能做什么

- **在 Zotero 内直接对话**：无需来回复制问题和回答，网页 AI 的输出会流式显示在右侧栏。
- **连接现有网页 AI**：复用浏览器里已经登录的 AI 页面，无需为网页模式填写 API Key。
- **理解当前论文**：自动带上论文标题、当前页、选中文字或相关页的证据片段。
- **连续追问**：同一篇论文保留独立对话；重新打开文献后可恢复侧栏记录。
- **快捷阅读**：提供“总结本页、翻译本页、部分总结、全文总结、填充笔记、知识沉淀”等命令。
- **页码联动**：选文和证据保留 PDF 物理页码，可从侧栏跳回原文位置。
- **公式与 Markdown 排版**：标题、列表、表格、代码和 LaTeX 公式直接渲染；复杂分式、求和、上下标和矩阵使用本地 KaTeX MathML 显示。
- **API 直连**：可配置 OpenAI 或 Anthropic 兼容接口，也可从 CC Switch 导入当前配置。
- **MinerU 深度解析（可选）**：对公式多、表格复杂或双栏排版的论文重新解析，成功后后续提问自动使用增强文本。

## 工作方式

### 网页 AI 模式（推荐）

```text
Zotero AI 侧边栏 → Zotero 本机端口 → Tampermonkey 脚本
                                     ↓
                   已登录的 Gemini / DeepSeek / ChatGPT 等网页
                                     ↓
                              回答返回 Zotero
```

网页 AI 模式支持 Gemini、DeepSeek、ChatGPT、Kimi、Claude 和 Google AI Studio。对话上下文保留在当前网页会话中；只要继续使用同一个会话页面，就可以连续追问。

### API 直连模式

侧边栏也可以绕过浏览器，直接调用你配置的模型接口。适合已有 API Key、代理网关或 CC Switch 配置的用户。

## 安装

### 1. 安装 Zotero 插件

要求：**Zotero 10.0.x**。

1. 从本仓库 [Releases](https://github.com/daxiaxiong88/zotero-research/releases) 下载最新版 `zotero-research-*.xpi`。
2. 打开 Zotero，进入“工具 → 插件”。
3. 点击右上角齿轮，选择“从文件安装插件”。
4. 选择下载的 XPI，按提示完成安装并重启 Zotero。
5. 在“设置 → 高级”中开启“允许此计算机上的其他应用程序与 Zotero 通信”。

如果你从源码构建，运行：

```powershell
uv run python scripts/build_addon.py
```

生成的安装包位于 `dist/zotero-research-0.8.3.xpi`。当前 XPI 采用手动更新：从 Releases 下载并安装新版即可保留设置和对话，不要等待插件自动升级。

### 2. 安装网页连接脚本

只有使用“网页 AI 模式”时需要这一步。

1. 在 Chrome 或 Edge 中安装并启用 Tampermonkey。
2. <img width="1028" height="425" alt="图片对比_20260909_150702" src="https://github.com/user-attachments/assets/d395c165-9f26-413c-8ebc-7168cab48546" />

3. 打开 [网页 AI 连接脚本](https://github.com/daxiaxiong88/zotero-research/raw/refs/heads/main/userscripts/zotero-research-webai.user.js)，让 Tampermonkey 安装它。
4. 如果以前装过旧版，请更新原脚本，不要同时保留多个副本；当前脚本版本为 **1.0.12**。
5. 打开并登录任一支持的 AI 网站，然后刷新页面。
6. 页面右下角出现“已连接，等待 Zotero 消息”，同时 Zotero 侧栏显示对应模型“已连接”，即安装完成。

## 使用

### 第一次对话

1. 在 Zotero 个人库中打开一篇带本地 PDF 附件的文献（群组库、独立 PDF 条目暂不支持）。
2. 打开右侧的“科研助手”面板。
3. 在提供方下拉框中选择 Gemini、DeepSeek、ChatGPT 等网页 AI。
4. 点击“打开网页”，登录后等待连接状态变为“已连接”。
5. 在输入框提问，按 **Enter** 发送；按 **Shift+Enter** 换行。
6. 回答会自动显示在 Zotero 的“AI 对话”区域，直接继续输入即可追问。

### 快捷命令

| 命令 | 作用 |
| --- | --- |
| 总结本页 | 总结当前正在阅读的 PDF 页面 |
| 翻译本页 | 按顺序翻译当前页，保留术语、数字、单位和公式 |
| 部分总结 | 总结当前选中的原文，并解释它与全文的关系 |
| 全文总结 | 按问题、方法、结果、结论和局限生成结构化概览 |
| 填充笔记 | 生成适合粘贴进 Zotero 笔记的 Markdown |
| 上传材料 | 提醒你在当前网页会话中手动上传 PDF、截图或笔记 |
| 知识沉淀 | 把本篇论文的问答整理成知识点、方法、困惑和待追问问题 |
| 深度解析 | 调用本机 MinerU 重新解析全文、公式和表格 |

### 使用选文

在 Zotero PDF 阅读器中选中文字后，点击选区旁的“发送到科研助手”。侧边栏会显示原文和页码；随后提问或点击“部分总结”，选文会自动成为本轮材料。点击页码可回到对应 PDF 页面。

### 切换或清空对话

- 每篇论文有各自的侧栏记录，切换文献不会混在一起。
- “上次对话”会重新打开该文献最近使用的网页会话。
- “清空”会清除当前文献在 Zotero 侧栏中的记录；如果还要清除网页端上下文，请在网页 AI 中新建对话。

## 配置 API 直连（可选）

1. 打开“Zotero → 设置 → 科研助手”。
2. 在“API 直连”中选择接口协议：自动、OpenAI 兼容或 Anthropic 兼容。
3. 填写 Base URL、模型名称和 API Key；也可以点击“从 CC Switch 导入”。
4. 点击“测试连接”，成功后点击“保存”。
5. 回到侧边栏，在提供方中选择“API 直连”即可使用。

API 模式的「附带全文 PDF」当前仅支持 Anthropic 兼容协议，所选模型也必须支持 PDF；OpenAI 兼容协议可使用提取文本和粘贴的截图。

## 配置 MinerU（可选）

1. 先在本机安装 MinerU、对应模型权重及可用的 PyTorch 环境。
2. 打开“Zotero → 设置 → 科研助手”。
3. 填写 `mineru.exe` 路径和本地模型目录。
4. 打开论文，点击侧边栏“深度解析”。
5. 解析成功后无需重复操作；该文献后续问题会自动读取缓存结果。

缓存位于 Zotero 数据目录下的 `zotero-research-mineru/`。例如 Zotero 数据目录是 `D:\Zotero\paper`，缓存就是 `D:\Zotero\paper\zotero-research-mineru`。

## 常见问题

### 侧边栏没有内容

确认安装的是最新版 XPI，重启 Zotero 后重新打开“科研助手”面板。若仍为空，在“工具 → 插件”中停用再启用本插件。

### 一直显示“等待网页连接”

依次确认：Zotero 正在运行、允许其他应用通信已开启、Tampermonkey 脚本已启用、AI 网页属于支持列表。刷新网页后，也可从 Tampermonkey 菜单手动执行“连接 Zotero”。

### 网页收到问题但没有自动发送

先清空网页输入框并刷新页面。网页结构更新时，脚本可能找不到发送按钮；此时在网页中手动点击发送，回答仍可继续返回 Zotero。

### 公式仍显示为 LaTeX 原文

0.8.0 起插件内置离线 KaTeX，支持 `$...$`、`$$...$$`、`\(...\)` 和 `\[...\]`。请确认已安装 0.8.0 或更高版本；语法不完整的公式会保留原文，避免错误排版。

0.8.1 修复了长块级公式在 Zotero 侧栏中撑宽整段对话的问题；公式本身过宽时可在公式区域内横向滚动，普通正文仍会随侧栏宽度自动换行。

0.8.2 会清理 ChatGPT 回答中的内部 `filecite` 标记，包括实时回传和已经保存在本机的旧对话。

## 开发与测试

```powershell
npm install
npm run test:js
npx playwright install firefox
npm run test:gecko
uv run python -m pytest
uv run ruff check .
uv run --isolated --python 3.11 python -m mypy
uv run python scripts/build_addon.py
```

更完整的操作细节见 [Zotero 10 使用指南](docs/USAGE_ZOTERO10.md)。

本次修复、已执行的测试及尚需真实网页验收的项目见 [0.8.3 发布前检查](docs/RELEASE_AUDIT.md)。
