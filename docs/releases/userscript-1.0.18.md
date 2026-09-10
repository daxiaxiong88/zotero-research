# 脚本 1.0.18：请求独立期限与 Gemini 完成信号

配合 XPI 0.8.8 使用，详见 [完整修复与验证记录](v0.8.8.md)。本地候选，未推送或发布。

本版不再只依赖油猴匿名 fetch 请求的原生超时；正文回传的超时重试、Gemini 网络结束信号和侧栏迟到补回共同工作，不重复发送问题。更新原脚本后刷新 AI 页面，保留原网页会话，不要同时启用多个脚本副本。

诊断继续支持完整 JSON 下载和跨重载证据；`lastTask.lastUpdate` 增加 `durationMs`、`recovered`，`networkDone` 与 `dom.transportDone` 可用于核对网络结束信号是否到达。诊断不保存对话正文或图片。
