# Zotero Research 0.2 — 验收记录

日期：2026-09-03。系统：Windows；Zotero 10.0.1；Python 3.12.13；Node 24.14.0。
代码快照：`80cd2ec4ae2a46ca43a1566117ef759de458bd94`，分支 `codex/zotero10-complete`。
后续提交只补充说明和验收记录，不改变本次受测产品代码。

## 结论与范围

工程实现和自动化验收完成，交付可手动安装的本机开发版 XPI。真实 Zotero 中验证了
扩展启用、私有桥接、页码证据、五种分析入口的无模型行为、笔记安全预览和单条原生高亮。
主 profile 未由本次实施安装扩展，未读取真实论文、未创建主库笔记或注释。

这不是“所有模型和界面操作已验收”的声明：本机没有 Ollama 模型与 MinerU 权重，
完整鼠标/键盘工作流、模型推理和经用户批准后的 Local API 笔记写入仍待验收。

## 自动化结果

所有命令在 `D:\Research\ChatGPT` 运行，使用 `.venv-zotero10`，不覆盖仍可能运行的旧 `.venv`。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 完整 Python 回归 | `.venv-zotero10\Scripts\python.exe -m pytest -o addopts='' -q -ra` | **154 passed，3 skipped**，7.26 秒 |
| 严格类型 | `.venv-zotero10\Scripts\python.exe -m mypy` | **PASS**，19 个源文件 |
| 代码规范 | `.venv-zotero10\Scripts\python.exe -m ruff check src tests scripts` | **PASS** |
| 前端/生命周期/设置/测试夹具 | `node --test tests-js/*.test.cjs` | **34 passed** |
| stdio MCP | 已包含在 Python 回归中 | Python 模块与实际 `zotero-research-mcp.exe` 均完成 initialize/list-tools；恰好 **12 个工具** |
| 真实 Crossref | 见下方单独的 opt-in 命令 | **1 passed**，1.71 秒；只发送公开 DOI/题目/年份 |
| 安装包确定性 | 相同参数连续构建两次并比较 SHA-256 | **PASS** |
| 主 Zotero 健康检查 | `.venv-zotero10\Scripts\zotero-research-doctor.exe` | **ok**，0.2.0 / Zotero 10.0.1 / API v3 / schema 44 / `sqlite_access=forbidden` |

默认套件的 3 个跳过项：2 个需要 Windows 创建符号链接权限（WinError 1314）；1 个是默认关闭的公网测试。
公网测试随后单独开启并通过，所以唯一仍未执行的测试种类是本机无法创建符号链接的两个场景。
打包器的符号链接拒绝逻辑已存在，但不把这两个跳过项计为通过。

~~~powershell
$env:RUN_CITATION_NETWORK_SMOKE = '1'
& '.\.venv-zotero10\Scripts\python.exe' -m pytest `
  tests/test_citations.py::test_crossref_real_network_smoke_uses_public_doi_only `
  -o addopts='' -q
~~~

该检查使用公开文献 DOI `10.1038/nature12373`，核对 DOI 存在、标题与年份；
不访问 Zotero 论文，也不把“没有检出更新公告”解释成没有撤稿。

## 真实 Zotero 隔离验收

运行命令：

~~~powershell
& '.\.venv-zotero10\Scripts\python.exe' scripts/prepare_zotero_smoke.py `
  --xpi dist/zotero-research-0.2.0.xpi `
  --bridge-executable 'D:\Research\ChatGPT\.venv-zotero10\Scripts\zotero-research-bridge.exe' `
  --launch --native-checks
~~~

每次运行创建新的 `artifacts/zotero-smoke-*` 目录，不复用主 profile；关闭同步和 Office 插件自动安装。
测试扩展必须核实 `ZRM_SMOKE_ROOT` 与 Zotero 实际 DataDirectory 完全匹配，否则拒绝创建任何条目。
等待文献库数据加载后，仅通过 Zotero 自身 API 创建一条虚构文献及两页生成 PDF。
测试扩展不进入发布 XPI。

最终记录：

- 目录：`D:\Research\ChatGPT\artifacts\zotero-smoke-4zswtquf`
- [原始机器报告](../artifacts/zotero-smoke-4zswtquf/fixture-report.json)
- [完全虚构的测试 PDF](../artifacts/zotero-smoke-4zswtquf/synthetic.pdf)
- 测试 Local API：`127.0.0.1:1434`；server ID：`Ur0RPD6W8Fnk`，与主实例不同。
- 扩展管理元数据：`zotero-research@local.invalid`，0.2.0，`active=true`，未被用户或应用禁用。
- 测试父条目：`9ETL5M56`；PDF：`KW38BGPE`；新建测试高亮：`C99E7E9G`。
- `fixture_ready`、`nativeChecks.status=passed`、`pluginErrors=[]`。

实际经过的路径：

1. 在 Zotero Gecko sandbox 中加载发布 XPI 的生产代码，验证原生 SHA-256、Subprocess、生产 XHR 和随机令牌桥接。
2. `health` 验证版本/文献库身份；`item_context` 仅获取合成条目。
3. `evidence` 找到物理第 1 页的虚构结果，并返回可追溯原文。
4. reading/question/review/explain/translate 全部进入真实服务；未配置模型时均明确为 `evidence_only`。
   解释/翻译传入真实存在于合成 PDF 上的选文和页码。这不等于实际模型翻译或审稿通过。
5. `preview_note` 返回绑定实例的摘要和转义 HTML；未确认的写入被拒绝，**最终笔记数为 0**。
6. `locate` 唯一定位原文；原生高亮预览不写入，未确认提交被拒绝。
7. 测试控制器仅对生成 PDF 确认一次保存，实际调用 `Zotero.Annotations.saveFromJSON` 和 Notifier 队列，
   再由 Reader 接收注释。核对注释原文、父附件、物理页及坐标；重复提交被拒绝，**最终恰好 1 条高亮**。
8. 关闭测试 bridge 的 stdin，结束私有子进程。未调用写入授权对话框、未铸造云端许可、未连接真实模型。

最终高亮使用 PDF 原生坐标 `pageIndex=0`，矩形为
`[106.67999267578125, 665.3381958007812, 458.1719055175781, 681.8262329101562]`。
坐标来自该合成 PDF 的唯一文本定位，不是模型推断。

## 安装包与配置

- 包：`D:\Research\ChatGPT\dist\zotero-research-0.2.0.xpi`，114485 字节。
- SHA-256：`57e344c4e36670412163a653a4dd4b4175409d87e8b47ff5d7a88ba99e7f1208`。
- 清单：`dist/zotero-research-0.2.0.xpi.manifest.json`，13 个允许的运行时文件及必要目录项。
- 不含 `.env`、API 密钥、论文、Python 环境或测试扩展。只包含本机后端路径，不适合直接搬到另一台机器。
- 兼容范围：Zotero `10.0` 至 `10.0.*`。必填 `update_url` 使用保留的 `.invalid` 域名，**没有在线自动升级服务**。
- `C:\Users\xzh21\.codex\config.toml` 中只更改 `zotero_research.command` 和 `tool_timeout_sec`；
  通过解析 TOML 并比较其余字段摘要，确认其他配置值未变。`writes` 审批设置保留。
- 新命令指向 `.venv-zotero10\Scripts\zotero-research-mcp.exe`，总等待上限为 2460 秒，涵盖配置允许的解析与模型超时。
  该上限不增加正常请求耗时。当前已打开的 Codex 任务可能仍需刷新 MCP 或重新打开才能加载新工具列表。
  字段依据：[OpenAI 官方 MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## 未完成的现场验收与下一步

| 项目 | 当前状态 | 所需动作 |
| --- | --- | --- |
| 主 profile 安装 | 本次未安装 | 用户在 Zotero“工具 → 插件 → 从文件安装插件”中选择 XPI 并确认 |
| 完整界面点击、快捷键和视觉布局 | JS/XHTML 功能测试通过；本机窗口自动化不可用，未完成全套现场点击 | 安装后按 [中文指南](USAGE_ZOTERO10.md) 操作一篇允许测试的论文 |
| 用户授权后的 Local API 笔记创建 | 协议/预览/重复提交等模拟测试通过；真实实例只测试了预览与拒绝未确认写入 | 用户核对具体笔记，在 Zotero 授权后明确点击保存 |
| 本地模型推理 | 接口/隐私/证据校验测试通过；Ollama 未安装模型 | 用户批准模型选择与数 GB 下载，或提供现成的本地模型名称/端点 |
| MinerU 真实权重解析 | CLI/离线环境/输出解析/失败处理测试通过；没有依赖/权重实跑 | 用户准备完整 pipeline 环境和模型目录 |
| 商业 Pro 等价 | 不作承诺 | 原 Feishu 页面未能读取；需功能清单才能逐项核对 |

窗口自动化的准确错误为 `foreground window did not report a process id`。
未据此猜测屏幕内容，也未改用未授权的界面控制手段；原生 API 集成测试与鼠标点击验收明确分开。

安装和模型下载需要用户下一步操作，不能据代码测试通过宣称这些事项已经完成。
所有测试文件保留在 `artifacts` 下，未清理或删除主库数据。
