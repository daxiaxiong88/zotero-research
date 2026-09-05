# 设计结论

## 交互

- 参考图只作为视觉和操作参考，面板采用紧凑白色卡片、快捷命令芯片、消息气泡和底部输入框。
- “总结本页”等命令都转成普通聊天消息，因此快捷命令和手动提问共享同一上下文。
- “截图翻译”“上传附件”“上传笔记”“上传更多”负责提示网页 AI 下一步，文件仍由用户在网页页面选择。
- 选文内容以纯文本发送，回答也以纯文本显示；回答中的证据页码可点击跳回 PDF。

## 数据流

```text
Zotero PDF 阅读器
  -> Zotero 侧栏
  -> 本机 bridge
  -> Tampermonkey 网页适配层
  -> 当前已打开的网页 AI
  -> bridge
  -> Zotero 侧栏
```

- bridge 使用随机本机端口和短期配对令牌。
- 页面只可通过用户主动配对的 URL 片段接入。
- 会话保存在 bridge 进程内；清空、切换论文或进程退出都会结束会话。
- PDF 证据保留附件编号、物理页码和可定位原文，供网页 AI 组织回答。

## 配置

- 只使用网页 AI：不需要填写模型 API。
- 需要本机生成阅读卡时，可在 `.env` 配置 OpenAI 兼容模型；这是可选的后台能力，不影响网页 AI 侧栏。
- 普通 PDF 使用 PyMuPDF；复杂排版才启用可选重解析器。

## 代码入口

- `addon/content/panel.js`：侧栏交互和消息状态。
- `addon/content/panel.css`：侧栏视觉样式。
- `addon/bootstrap.js`：Zotero 10 生命周期、选文和 bridge 启动。
- `src/zotero_research_mcp/bridge.py`：本机消息桥。
- `src/zotero_research_mcp/service.py`：条目读取、PDF 证据和会话队列。
- `userscripts/zotero-research-webai.user.js`：网页输入、发送和回答回传。
