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

## 2026-09-03 — 集成、审查与交付

- PDF/MinerU、Crossref、原生侧边栏、打包和中文指南分支均经主线程检查后集成；全部 worker 已结束。
- 新增 Zotero10 bootstrap、私有子进程、偏好页、阅读器入口、原生高亮和完整 UI。
- 独立 Standards / Spec 双轴审查目标 bfdbae0...9af8d9a；8 项问题均修复，详见 docs/REVIEW_ZOTERO10.md。
- 删除 MCP local-client 披露豁免；授权严格限制当前 PDF，已有 notes 独立勾选；模型/解析异常不回显敏感详情。
- manifest 必填 update_url、jar 资源读取、locale ZIP 目录及停机握手等兼容性问题有回归和本机源码依据。
- 建立仅合成数据的隔离测试 profile；修复库加载顺序与报告中间态误报，测试夹具不进入发布包。
- 最终代码快照 80cd2ec；154 Python + 34 JS 通过，mypy 19 文件及 Ruff 通过；两项符号链接场景因 Windows 权限跳过。
- 默认关闭的真实 Crossref 测试随后单独开启，公开 DOI 核验 1 项通过，不发送全文。
- 发布包在 Zotero10.0.1 隔离 profile 中 active=true；生产 Gecko 子进程/XHR、证据、五模式无模型行为及笔记预览通过。
- 合成 PDF 用原生 API 保存恰好一条高亮并拒绝重放；没有授权 Local API 笔记写入，笔记数仍为 0。
- 主库健康检查仍为 10.0.1/v3/schema44；本次未读取真实论文或试写主库。
- OpenAI Docs 核实 Codex MCP 配置后只修改 zotero_research 的 command 和 tool_timeout_sec，其余 TOML 值摘要一致。
- 按 verify-and-stop 技能冻结功能范围，整理安装与验收证据；真实模型、MinerU 权重、主 profile 安装和完整点击验收留给用户下一步。
- 原始最终机器报告：artifacts/zotero-smoke-4zswtquf/fixture-report.json；安装包 SHA-256：57e344c4e36670412163a653a4dd4b4175409d87e8b47ff5d7a88ba99e7f1208。

## Verification

| Check | Result |
| --- | --- |
| Zotero Local API 健康检查 | PASS — 10.0.1 / v3 / 本地写入可用 |
| Python / JS / mypy / Ruff | PASS — 154 / 34 / 19 files / clean |
| 公网 Crossref（仅公开 DOI） | PASS — 1 test |
| XPI 可重复构建与真实隔离启用 | PASS — 0.2.0 / active=true |
| 合成 PDF 原生高亮 / 笔记预览 | PASS — 1 highlight / 0 notes |
| 完整手动点击 / 真实模型 / MinerU 权重 | NOT RUN — 需现场操作/模型准备 |
| 用户主库修改 | NONE |
