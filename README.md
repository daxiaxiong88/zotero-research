# Zotero AI 科研阅读助手

一个面向 **Zotero 10** 的论文阅读侧边栏。你可以一边阅读 PDF，一边把当前页、选中文字或全文材料交给浏览器中的 Gemini、DeepSeek、ChatGPT、Kimi、Claude、Google AI Studio，也可以直接连接兼容 OpenAI / Anthropic 协议的模型 API。AI 的回答会自动回到 Zotero，并在同一篇论文下保留连续对话。

## 效果演示

<video src="https://github.com/user-attachments/assets/10eed7ee-1096-41f4-a54a-b4f40a553c52" controls preload="metadata" muted></video>

*完整的问答、公式渲染与页码跳转演示；视频无法播放时请直接阅读下方说明。*

## 它能做什么

- **在 Zotero 内直接对话**：无需来回复制问题和回答，网页 AI 的输出会流式显示在右侧栏。
- **连接现有网页 AI**：复用浏览器里已经登录的 AI 页面，无需为网页模式填写 API Key。
- **选择启动浏览器**：在 Zotero 设置的“科研助手”页面选择系统默认、Chrome、Edge 或自定义路径，不占用侧栏。
- **轻量提问**：普通聊天只带论文标题、问题及当前选文/截图，不自动追加检索摘录；需要原文时使用本页或全文快捷命令。
- **连续追问**：同一篇论文保留独立对话；重新打开文献后可恢复侧栏记录。
- **对话时间轴**：Zotero 侧栏和全部六个 AI 网页都提供提问导航，支持悬停预览、点击跳转、当前位置高亮和长按标星；星标在本机保存。
- **快捷阅读**：提供“总结本页、翻译本页、部分总结、全文总结、填充笔记、知识沉淀”等命令。
- **页码联动**：选文和证据保留 PDF 物理页码，可从侧栏跳回原文位置。
- **公式与 Markdown 排版**：标题、列表、表格、代码和 LaTeX 公式直接渲染；复杂分式、求和、上下标和矩阵使用本地 KaTeX MathML 显示。
- **API 直连**：可配置 OpenAI 或 Anthropic 兼容接口，也可从 CC Switch 导入当前配置。
- **MinerU 深度解析（可选）**：对公式多、表格复杂或双栏排版的论文重新解析，成功后本页、全文等取材命令优先使用缓存中的增强文本。

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

要求：**Zotero 10.0.x**。当前正式版为 **0.9.3**，配套网页连接脚本为 **1.1.2**。

| 组件 | 下载 | 用途 |
| --- | --- | --- |
| Zotero 插件 0.9.3 | [下载插件 XPI](https://github.com/daxiaxiong88/zotero-research/releases/download/v0.9.3/zotero-research-0.9.3.xpi) | 在 Zotero 中安装 |
| 网页连接脚本 1.1.2 | [下载网页连接脚本](https://github.com/daxiaxiong88/zotero-research/releases/download/v0.9.3/zotero-research-webai.user.js) | 在浏览器的 Tampermonkey 中安装；API 直连模式不需要 |

[最新版发布页面](https://github.com/daxiaxiong88/zotero-research/releases/latest) · [本版更新说明与已知限制](docs/releases/v0.9.3.md)

**已安装带有效更新源的版本，可直接检查更新**；更早缺少更新地址的旧版，仍需手动安装新版 XPI 和油猴脚本一次。安装后重启 Zotero、刷新 AI 网页。无需清空设置、文献或对话；API 直连用户只更新 XPI。不要把源码压缩包、`.meta.js` 或 `previous-stable` 回滚包当作安装文件。

本版新增**设置页中的浏览器选择**，系统默认、Chrome、Edge、自定义路径均可配置。已有脚本 **1.1.2** 的用户本次只需更新 XPI。原有左侧时间轴、更新检查、ChatGPT 长文本附件、图片发送、公式渲染及 Gemini 长回答回传保持原有流程。浏览器完全冻结或丢弃标签页时脚本仍无法执行，不保证突破浏览器休眠策略。

### 以后如何获得更新

- **Zotero**：已接入原生插件更新源，可在“工具 → 插件 → 齿轮 → 检查更新”检查；是否自动安装遵循你的 Zotero 设置。科研助手侧栏也会每天检查一次，发现新版时显示更新提示，顶部“检查更新”可立即重查。
- **Tampermonkey**：脚本已包含固定的更新／下载地址，由篡改猴按其设置检查更新。网页脚本还会每天检查一次，在 AI 网页右上角显示可关闭的新版提示，点击“下载更新”进入安装。油猴菜单“检查脚本更新”可随时重查。
- 提醒不打断聊天，同一版本自动提醒一次；断网不影响阅读，也不会误报“已是最新”。需能够访问 GitHub；关闭自动更新、网页冻结或离线时，不保证即时收到提醒。

详见 [更新机制与发布流程](docs/UPDATES.md)。

### 1. 安装 Zotero 插件

1. 下载上方的 `zotero-research-0.9.3.xpi`。
2. 打开 Zotero，进入“工具 → 插件”。
3. 点击右上角齿轮，选择“从文件安装插件”。
4. 选择下载的 XPI，按提示完成安装并重启 Zotero。
5. 在“设置 → 高级”中开启“允许此计算机上的其他应用程序与 Zotero 通信”。

### 2. 安装网页连接脚本

只有使用“网页 AI 模式”时需要这一步。

1. 在 Chrome 或 Edge 中安装并启用 Tampermonkey。

   <img width="1028" height="425" alt="Tampermonkey 配置示意" src="https://github.com/user-attachments/assets/d395c165-9f26-413c-8ebc-7168cab48546" />

2. 点击上方的“下载网页连接脚本”，在 Tampermonkey 中安装；若浏览器只下载文件，可在 Tampermonkey 编辑器中粘贴文件全文并保存。
3. 如果以前装过，请更新原脚本，不要同时保留多个副本。确认脚本版本为 **1.1.2**。
4. 打开并登录任一支持的 AI 网站；更新脚本后刷新已打开的 AI 页面，不必清空原有网页对话。
5. 页面右下角出现“已连接，等待 Zotero 消息”，同时 Zotero 侧栏显示对应模型“已连接”，即安装完成。

## 使用

### 第一次对话

1. 在 Zotero 个人库中打开一篇带本地 PDF 附件的文献（群组库、独立 PDF 条目暂不支持）。
2. 打开右侧的“科研助手”面板。
3. 在提供方下拉框中选择 Gemini、DeepSeek、ChatGPT 等网页 AI。
4. **点击侧栏的“打开网页”按钮启动浏览器**（推荐做法，见下方说明），登录后等待连接状态变为“已连接”。
5. 在输入框提问，按 **Enter** 发送；按 **Shift+Enter** 换行。
6. 回答会自动显示在 Zotero 的“AI 对话”区域，直接继续输入即可追问。

### 选择和启动浏览器

进入 **Zotero 设置 → 科研助手 → 网页 AI 浏览器**（与 API、MinerU 配置在同一页），选择后点“保存浏览器设置”：

- **系统默认**：严格跟随系统默认浏览器，不再优先找 Chrome，不附加启动参数。
- **Chrome / Edge**：Windows 自动查找常见安装位置，使用现有用户配置；找不到明确选中的浏览器会提示错误，不擅自换成另一个。
- **自定义路径**：填写浏览器可执行文件的绝对路径，不附加参数。Windows 使用 `.exe`；macOS 填写 `.app` 内的可执行文件。保存前检查文件，不使用 shell 拼接命令。Chrome / Edge 自动定位目前仅支持 Windows，其他系统可使用系统默认或自定义路径。

保存后下次“打开网页”或未连接时首次发送即生效，无需重启 Zotero。**不会强制切换已连接的网页**；需要换浏览器时，先在原网页的油猴菜单断开，再打开新浏览器并连接。目标浏览器须安装油猴和配套脚本；能启动某浏览器不等于其网页联动已完整验证。

未配置时保留原行为：Windows 优先 Chrome，找不到才走系统默认；其他系统默认走系统浏览器。插件不修改系统默认浏览器，也不关闭已有窗口。

- Windows 的 Chrome / Edge（含自定义路径中的 `chrome.exe` / `msedge.exe`）会携带 `--disable-backgrounding-occluded-windows`，减少窗口被完全遮挡后的后台暂停。**若该浏览器已在运行**，新参数不会改变旧进程；需先保存工作、正常退出其全部窗口，再从侧栏打开。系统默认模式不附加该参数。
- 网页未连接时首次发送问题也会自动请求启动所选浏览器；已有连接时不另外打开页面。
- 每次从侧栏打开时，若本地记录了同一提供方的上次对话地址，会优先回到那个会话页面以延续上下文。

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

### 对话时间轴

Zotero 时间轴贴在**对话区左侧留白**，在可见回答阅读区垂直居中；圆点紧凑排列，不跨越顶部快捷命令或底部输入框。预览向右展开，侧栏缩放、滚动时保持对齐。AI 网页的时间轴仍位于右侧。每个圆点对应一次提问：悬停看问题，点击跳转，长按约半秒标星；键盘聚焦节点后可按 `S` 标星、上下键移动。顶部的 `⋮` 可收起或展开，网页也可从油猴菜单切换显示。

侧栏星标跟随这篇文献的本机存档，网页星标按网站与会话保存；两边独立，不会互相覆盖。网页导航仅索引当前已加载的消息；网站尚未加载或已虚拟化卸载的历史，需要先在网页滚动加载。详见 [时间轴使用与边界](docs/CONVERSATION_TIMELINE.md)。

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

### ChatGPT 把长文本变成附件后提示输入失败

请确认油猴脚本已更新至 **1.1.2** 并刷新 ChatGPT 页面。当前脚本能识别本轮新增的“已粘贴的文本”附件，等待其就绪后继续发送；普通短文本和截图发送保持原有方式。若上次失败的文本附件仍留在网页输入区，先手动发送或移除它，再重试，避免叠加旧草稿。

### 公式仍显示为 LaTeX 原文

当前插件内置离线 KaTeX，支持 `$...$`、`$$...$$`、`\(...\)` 和 `\[...\]`。请先确认 XPI 和油猴脚本都与上方下载版本一致；语法不完整的公式会保留原文，避免错误排版。

公式本身过宽时可在公式区域内横向滚动，普通正文仍会随侧栏宽度自动换行。ChatGPT 回答优先提取原始 LaTeX，并尝试渲染标记为 `latex`、`tex`、`math` 的纯公式代码块；完整 LaTeX 文档和普通程序代码保持原样。

ChatGPT 的内部 `filecite` 标记会在实时回传和恢复本机对话时自动清理。若旧记录已经缺少正文或公式结构，更新不会凭空补全，需重新提问。

## 开发与测试

```powershell
npm install
npm run build:userscript
npm run check:userscript
npm run test:js
npx playwright install firefox
npm run test:gecko
uv run python -m pytest
uv run ruff check .
uv run --isolated --python 3.11 python -m mypy
uv run python scripts/build_addon.py
uv run python scripts/build_release_metadata.py
uv run python scripts/build_release_metadata.py --check
```

更完整的操作细节见 [Zotero 10 使用指南](docs/USAGE_ZOTERO10.md)。

本版改进、已执行的测试及尚需真实网页验收的项目见 [当前发布说明](docs/releases/v0.9.3.md)。安装文档中的版本和下载链接由 `tests/test_installation_docs.py` 检查，发布新版本时需同步更新。

时间轴交互参考 [Reborn14/chatgpt-conversation-timeline](https://github.com/Reborn14/chatgpt-conversation-timeline)（MIT），本项目针对 Zotero 与六个平台独立实现了共享导航组件；没有照搬其三个站点的完整扩展或 React 内部状态读取逻辑。
