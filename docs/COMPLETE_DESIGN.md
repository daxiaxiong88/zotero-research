# Zotero 10 网页 AI 侧栏设计

## 目标

让 Zotero 阅读器右侧出现一个轻量面板，外观接近参考截图：上方是论文标题和快捷命令，中间是当前选文，底部是网页 AI 连续对话框。

## 数据流

```text
Zotero PDF 阅读器
      │ 选文、页码、当前文献
      ▼
Zotero 原生扩展侧栏
      │ 本机 bridge
      ▼
Python 服务：Local API + PDF 检索 + 会话队列
      │ 浏览器网页请求
      ▼
Gemini / DeepSeek / Google AI Studio
      │ 回传回答
      └──────────────► Zotero 侧栏
```

侧栏只保留三类交互：快捷命令、当前选文、连续聊天。篡改猴负责识别网页输入框、点击发送、读取最新回答并回传；会话历史保存在 bridge 进程内，切换文献或点击“清空”就重新开始。

## 侧栏元素

| 区域 | 内容 |
| --- | --- |
| 顶部 | Gemini 标识、论文标题、连接状态、设置按钮 |
| 快捷命令 | 总结本页、翻译本页、截图翻译、部分总结、全文总结、填充笔记、文献鸟瞰、截图本页、上传附件、上传笔记、上传更多 |
| 选文卡片 | 选中文字、物理页码、点击后跳回 PDF |
| 对话区 | 提供方选择、配对/打开网页、清空、上下文消息、回答来源页码 |
| 输入区 | “向 AI 询问任何内容”、回车发送、连续上下文 |

## 组件边界

- `addon/content/panel.js`：侧栏 DOM、快捷命令、会话状态和网页配对。
- `addon/content/panel.css`：右侧栏视觉样式，使用紧凑芯片和对话气泡。
- `addon/bootstrap.js`：注册 Zotero 10 Item Pane、读取阅读器选文、启动本机 bridge。
- `src/zotero_research_mcp/bridge.py`：本机 RPC 和网页中继端点。
- `src/zotero_research_mcp/service.py`：条目读取、PDF 提取、证据检索和网页会话。
- `userscripts/zotero-research-webai.user.js`：浏览器页面适配层。

## 当前 RPC

面板使用：`health`、`relay_info`、`webai_chat`、`webai_chat_status`、`webai_chat_cancel`。

阅读服务还提供：`item_context`、`extract_pdf`、`evidence`、`reading_card`、`analyze`、`locate`。

所有 PDF 证据都带附件编号和物理页码；“填充笔记”只把整理后的文字交给网页 AI，是否保存由你在 Zotero 中自行决定。
