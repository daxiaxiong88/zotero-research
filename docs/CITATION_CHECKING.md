# Crossref 引用核验

`zotero_research_mcp.citations` 提供一个只读、默认拒绝联网的 DOI 元数据核验边界。它不需要 Zotero 授权，也不访问 Zotero 数据库、附件、PDF 或笔记；它不调用 LLM，也不把引用内容发送到模型。

## API

```python
from zotero_research_mcp.citations import CitationAuditor, CitationRequest

auditor = CitationAuditor()
report = auditor.audit(
    [
        CitationRequest(
            doi="https://doi.org/10.1038/nature12373",
            title="Nanometre-scale thermometry in a living cell",
            year=2013,
        )
    ],
    allow_network=True,  # 必须显式开启
)
```

`CitationRequest` 只接受 DOI 名称或严格的 `http(s)://doi.org/<DOI>` URL。输入会去掉 `doi:` 前缀、规范化大小写，并拒绝非 `doi.org` 主机、查询参数、片段、凭据、端口、控制字符、非法 DOI 语法和超过 255 个字符的规范化 DOI。一次最多 20 条。

`allow_network=False`（默认）会在创建任何 HTTP 客户端请求之前抛出 `NetworkAccessDisabledError`。传入 `transport=httpx.MockTransport(...)` 只改变测试传输边界，不改变生产 URL 或联网策略。

## 核验内容与状态

每条结果包含：规范化 DOI、Crossref 返回的 DOI/题目/年份、题目和年份匹配结果、Crossref 更新线索、请求来源 DOI/URL、UTC `checked_at` 和问题列表。`sources` 保留本次使用的 Crossref 工作查询与更新反向查询 URL。

审计会执行两个固定的只读请求：

1. `GET https://api.crossref.org/v1/works/{doi}`，读取单条工作记录中的 DOI、题目、出版日期、`update-to` 和记录 URL（Crossref 单条路由不支持 `select`）。
2. `GET https://api.crossref.org/v1/works?filter=updates:{doi}&rows=20`，查找反向指向该 DOI 的更正、撤稿或其他更新记录。

请求只发往 HTTPS `api.crossref.org`，只使用 GET，并设置 `follow_redirects=False`；因此包括跨域重定向在内的重定向都不会被跟随。连接超时、一般连接错误、HTTP 404、HTTP 429、其他 HTTP 错误、重定向和 JSON 解析/结构错误分别保留为不同状态，不会被转成验证通过。

常见状态包括：

- `no_notice_found`：Crossref 的上述记录和更新查询没有发现撤稿/更正线索；这不是 `clean`，也不代表“未撤稿”。
- `retraction_signal`：发现 `update-to` 类型中包含撤稿/撤回/移除线索。
- `correction_signal`：发现更正、勘误或 erratum 等线索。
- `update_signal`：发现其他有类型或由 `updates:<doi>` 筛选证明的更新线索。
- `title_mismatch`、`year_mismatch`、`metadata_mismatch`：提供的已知书目信息与 Crossref 元数据不匹配。
- `unknown`：元数据更新关系不完整，或反向更新查询失败；结果不能当作验证通过。
- `not_found`、`timeout`、`connection_error`、`rate_limited`、`malformed_json`、`malformed_response`、`redirect_refused`、`http_error`：相应的边界失败。

题目比较使用 Unicode NFKC、大小写折叠、标点/空白归一化后的精确比较，不进行模糊匹配。年份优先读取 Crossref `published`，再读取 `published-print`、`published-online`、`issued` 和 `created` 的年份；这些比较仅在请求提供题目/年份时进行。

## Crossref 依据

实现依据 Crossref 官方资料：

- [REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)：公共 API、`/works/{doi}` 单记录端点和 JSON 元数据。
- [REST API filters](https://www.crossref.org/documentation/retrieve-metadata/rest-api/rest-api-filters/)：`updates`、`has-update`、`is-update` 和 `update-type` 过滤器。
- [Retraction Watch in the REST API](https://www.crossref.org/documentation/retrieve-metadata/retraction-watch/)：撤稿记录会出现在 REST API JSON 的 `update-to` 字段中。
- [Relationships](https://www.crossref.org/documentation/schema-library/markup-guide-metadata-segments/relationships)：Crossmark 用更新关系表示会实质影响工作的更新，例如撤稿；关系是由成员和可信来源沉积/补充的元数据。

Crossref 官方资料同时说明元数据可能来自成员和可信来源，更新信息也可能不完整或延迟。因此本模块保留 Crossref 作为单一来源的限制，不声称独立的多源验证。

## 测试与限制

常规测试使用 `httpx.MockTransport`，覆盖 DOI 边界、默认拒绝联网、题目/年份匹配、更新线索、404、429、超时、连接失败、malformed JSON 和跨域重定向。真实网络烟测是显式选择运行的测试，只使用公开 DOI `10.1038/nature12373`，不访问真实 Zotero 数据；设置 `RUN_CITATION_NETWORK_SMOKE=1` 后运行。

这个核验器只核对 Crossref 所能观察到的元数据和更新关系。没有 Crossref 撤稿线索不能证明论文未撤稿；必要时仍应检查出版商的正式记录、期刊页面或其他独立来源。模块不验证全文内容、作者身份、引用是否真正支持论断，也不保证 DOI 在其他注册机构中的状态。
