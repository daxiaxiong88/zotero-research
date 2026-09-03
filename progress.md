# Progress

## 2026-09-03 — 完整工作流续建

- 用户已升级 Zotero 10，要求补齐最初设计。
- 读取 implement、tdd、lean-build、planning-with-files、frontend-design 技能及所需测试参考。
- 通过真实 MCP health_check 验证 Zotero 10.0.1 写入能力；未读取文献正文、未写入主库。
- 阅读上一版实现规格；确认 git 工作树干净。
- 建立阶段计划，向用户异步确认新增验收边界。
- 已创建 codex/zotero10-complete 分支。
- 阅读 PDF 处理技能；PDF 验收将使用合成测试材料。
- 读取官方插件开发文档。Feishu 抓取失败，稍后尝试用户浏览器；不影响已明确架构部分的实现。
- 三个 luna_worker 已启动：PDF/重解析与引用核验分别独立 worktree，Zotero10运行时接口研究只读。
- 隐私首个回归：先观察未授权仍解析附件的失败，再加出站保护，测试转绿。
- 本地短期授权绑定论文/附件、Zotero实例和10分钟有效期，交叉论文/实例与过期拒绝测试通过。
- 修改依赖元数据触发 uv 重装，运行中的 Windows MCP exe 被锁定。后续先用 python -m 测试，发布采用新环境。
- 本机桥接已实现随机端口/进程内Bearer令牌、Origin与Host拒绝、请求大小限制、实例一致性检查；真实环回HTTP测试通过。
- Windows拒绝请求时若未消费请求体会RST，已加有界丢弃处理，测试转绿。
- 结构化问答/精读/解释/翻译/模拟审稿已实现共同证据约束，模型未知证据拒绝、敏感资料外部模型拒绝测试通过。
- PDF与引用worker初版已完成；主线程审查发现不对称裁切坐标和引用失败分类等问题，已退回补回归，不将初版直接视为验收通过。
- 新环境 .venv-zotero10 安装成功（0.2.0），避免修改正在运行的旧 MCP 环境。
- 通过本机安装包核实 ItemPaneManager / Reader 选区 / Annotations.saveFromJSON / LocalAPI.getServerID；不以概念API代替实际接口。
- 高亮控制器先观察缺失模块失败，再实现预览只读、并发只写一次、原生坐标防篡改、文件/库变更与过期失效，4项 Node 回归通过。
- UI worker 初版验收发现 XUL命名空间、授权撤销可达性等问题，退回补测；暂未直接合并。

## Verification

| Check | Result |
| --- | --- |
| Zotero Local API 健康检查 | PASS — 10.0.1 / v3 / 本地写入可用 |
| 用户主库修改 | NONE |
