# Zotero 10 验证记录

本版本的验收目标是：Zotero 10 可以加载侧栏，快捷命令能进入网页 AI 连续会话，网页回答能自动回到侧栏，且切换文献后不会串上下文。

## 自动化检查

在仓库根目录执行：

```powershell
\.venv-zotero10\Scripts\python.exe -m pytest -q
npm run test:js
\.venv-zotero10\Scripts\python.exe -m ruff check src tests scripts
\.venv-zotero10\Scripts\python.exe -m mypy
```

前端测试覆盖：

- 11 个截图风格快捷命令是否出现；
- 空文献状态和选文页码；
- 配对后是否显示“已配对，等待消息”；
- 消息是否只走连续网页会话 RPC；
- 自动回答是否回到侧栏；
- XUL/XML 宿主和多个面板实例；
- 纯文本渲染不会执行 HTML。

Python 测试覆盖：

- Zotero Local API 读写边界；
- PyMuPDF 逐页提取和重解析器切换；
- PDF 证据检索、页码定位和阅读卡；
- bridge 的 Origin、Host、令牌和实例匹配；
- 网页 AI 会话排队、回传、上下文和取消；
- XPI 清单、文件白名单和确定性构建。

## 手工验收

1. 重新构建 XPI 并在 Zotero 10 安装。
2. 在 Tampermonkey 安装用户脚本。
3. 浏览器打开 Gemini，Zotero 打开一篇本地 PDF。
4. 点击“配对/打开网页”，确认两端均显示“已配对，等待消息”。
5. 点击“总结本页”，确认网页输入框自动出现问题并发送。
6. 等待网页回答结束，确认回答自动出现在 Zotero 对话区。
7. 在 PDF 中选中一段文字，点击“部分总结”，确认新消息包含选文并显示页码来源。
8. 点击“清空”，确认消息消失；切换到另一篇文献，确认会话重新开始。

## 重建命令

```powershell
\.venv-zotero10\Scripts\python.exe scripts/build_addon.py `
  --bridge-executable 'D:\Research\ChatGPT\.venv-zotero10\Scripts\zotero-research-bridge.exe' `
  --working-directory 'D:\Research\ChatGPT'
```
