# Research: Tavily Search API 新闻 / 时效参数

- **Query**: Tavily `/search` 端点的 topic/time_range/days/published_date/include_domains 等新闻时效参数，推荐组合，以及与 OpenHorn 现状的差距
- **Scope**: mixed（external: docs.tavily.com 官方文档；internal: `apps/server/src/services/searchService.ts`）
- **Date**: 2026-06-29
- **Sources**:
  - `https://docs.tavily.com/documentation/api-reference/endpoint/search`（Search 端点参考）
  - `https://docs.tavily.com/documentation/best-practices/best-practices-search.md`（Search 最佳实践）
  - `https://docs.tavily.com/sdk/python/reference.md`（Python SDK 参考）
  - `https://docs.tavily.com/documentation/rate-limits.md`（速率限制）
  - `https://docs.tavily.com/documentation/api-credits.md`（额度与价格）

---

## Findings

### 1. `/search` (POST `https://api.tavily.com/search`) 关键参数表

| 参数 | 类型 | 取值 / 范围 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | string (required) | — | — | 查询语句 |
| `topic` | enum | `general` / `news` / `finance` | `general` | 搜索类别。`news` 用于检索实时更新（政治、体育、重大时事，主流媒体源）。`general` 为通用搜索，覆盖更广来源。 |
| `time_range` | enum | `day` / `week` / `month` / `year`（简写 `d` / `w` / `m` / `y`） | 无（不限） | 从当前日期回溯，按**发布日期或最后更新日期**过滤结果。 |
| `start_date` | string | `YYYY-MM-DD` | 无 | 返回该日期**之后**发布/更新的结果。 |
| `end_date` | string | `YYYY-MM-DD` | 无 | 返回该日期**之前**发布/更新的结果。 |
| `search_depth` | enum | `basic` / `advanced` / `fast` / `ultra-fast` | `basic` | 延迟 vs 相关性权衡。`advanced` 相关性最高、延迟更大、可返回每源多个 chunk；`basic` 平衡，每源一条 NLP 摘要。 |
| `chunks_per_source` | int | 1–3 | 3 | 每源返回的 chunk 数。**仅在 `search_depth=advanced` 时生效**。 |
| `max_results` | int | 0–20 | 5 | 返回结果上限。 |
| `include_answer` | bool/enum | `false` / `true`(=basic) / `advanced` | `false` | 是否附带 LLM 生成的答案。 |
| `include_raw_content` | bool/enum | `false` / `true`(=markdown) / `text` | `false` | 是否返回清洗后的页面正文。 |
| `include_domains` | string[] | 最多 300 个域名（支持通配如 `*.com`） | — | 仅包含指定域名。 |
| `exclude_domains` | string[] | 最多 150 个域名 | — | 排除指定域名。 |
| `country` | enum | 国家名（如 `china`, `united states`） | — | 提升某国来源权重。**仅在 `topic=general` 时可用**（与 `news` 互斥）。 |
| `include_favicon` / `include_images` / `include_image_descriptions` | bool | — | `false` | 附加 favicon / 图片。 |

**关于 `days` 参数（重要更正）**：当前 Tavily REST API 参考与 Python SDK 参考中**均已不存在 `days` 参数**（在 `search.md` 与 `reference.md` 中 grep `days` 命中数为 0）。早期 Tavily 版本曾有 `days`（默认 3，仅 `topic=news` 时生效），现已被 `time_range` + `start_date`/`end_date` 取代。**结论：不要再依赖 `days`，改用 `time_range`/`start_date`。**

### 2. `topic="news"` 与 `published_date`、时效性

- 官方明确：`published_date`（结果对象内字段）**只有当 `topic="news"` 时才会返回**（Python SDK 响应字段表：“This is only available if the search `topic` is set to `"news"`”）。
- `topic="news"` 走专门的新闻 agent，面向主流媒体的实时报道，时效性明显优于 `general`。`general` 不保证返回 `published_date`，来源更杂（含静态/百科类页面，如 Britannica）。
- 响应里还有 `auto_parameters`（如未显式传参时 Tavily 自动选择的 topic/search_depth）与 `usage.credits`（本次消耗额度）。

OpenHorn 现有的 `TavilyResult` 类型（`apps/server/src/services/searchService.ts:36`）已包含可选 `published_date`，并在 `normalizeCitations`（:126–:132）映射到 `publishedDate`，在 system context 里输出（:151）。即消费侧已就绪，关键在请求侧是否设了 `topic:news`。

### 3. 拿「今天 / 近 1–2 天」新闻的推荐参数组合

最佳实践文档给出的范式：`{ "query": "What happened today in NY?", "topic": "news" }`，以及按时间过滤 `time_range` / `start_date+end_date`。推荐：

```jsonc
// A. 近 1 天（最强时效，今天/昨天）
{
  "query": "<去噪后的查询>",
  "topic": "news",
  "time_range": "day",      // 仅回溯 1 天
  "search_depth": "basic",  // 或 advanced（=2 credits）做深度研究
  "max_results": 5,         // research 路由可调到 8–10
  "include_answer": false
}

// B. 近 1–2 天的精确窗口（用显式日期更可控）
{
  "query": "<查询>",
  "topic": "news",
  "start_date": "2026-06-28",   // = 今天往前 1 天
  "end_date":   "2026-06-29"
}
```

要点：
- `topic:"news"` 是拿 `published_date` 与高时效的前提，单独 `time_range` 不够。
- 「今天/近 1-2 天」用 `time_range:"day"`（约 24h）或显式 `start_date`（今天-1）；`"week"` 对“最新/刚刚”类查询过宽。
- `time_range`/`start_date` 过滤的是**发布或更新日期**，对真实新闻有效。

### 4. 中文新闻源覆盖 与 `include_domains`

- 官方未单列“中文媒体覆盖率”指标。`topic:news` 抓主流媒体，中文站点覆盖参差，IT之家 / 36氪等垂直站不保证默认进结果。
- 可用 `include_domains`（≤300 个，支持通配）显式指定中文源，例如 `["ithome.com", "36kr.com", "sina.com.cn", "thepaper.cn", "huxiu.com"]` 以提高命中。
- `country` 可提升某国来源权重，但**仅 `topic=general` 可用，和 `news` 互斥**，故新闻场景下指定中文源应走 `include_domains` 而非 `country`。
- `exclude_domains`（≤150）可排除低质/无关站点。

### 5. 速率限制 / 免费额度（截至 2026-06）

**速率限制（按 API key 所属环境）：**

| 端点 | Development RPM | Production RPM |
|---|---|---|
| 默认（含 /search、/extract） | 100 | 1,000 |
| Crawl | 100 | 100 |
| Research（创建任务） | 20 | 20 |
| Usage | 10 / 10min | 10 / 10min |

超限返回 `429`，带 `retry-after`（秒）头，应据其重试。Production key 需 Paid Plan 或开启 PAYGO。

**额度 / 价格：**
- 免费（Researcher）：**1,000 credits/月，无需信用卡**。
- 单次搜索成本：`basic`/`fast`/`ultra-fast` = **1 credit**；`advanced` = **2 credits**。
- 付费档：Project 4,000/$30、Bootstrap 15,000/$100、Growth 100,000/$500；PAYGO $0.008/credit。

---

## 对 OpenHorn 现状的差距说明

读取 `apps/server/src/services/searchService.ts:198-208` 的实际请求体：

```ts
const payload = {
  query: normalizeSearchQuery(input.prompt),
  topic: isNewsQuery(input.prompt) ? "news" : "general",
  search_depth: input.route === "research" ? "advanced" : "basic",
  max_results: input.route === "research" ? 8 : 5,
  chunks_per_source: 3,
  include_answer: false,
  include_raw_content: false,
  time_range:
    input.route === "research" ? "month" : isNewsQuery(input.prompt) ? "week" : undefined,
};
```

**更正任务描述的前提**：当前代码**已经**会按查询动态设 `topic:"news"`（不是“没用 topic:news”）。`isNewsQuery`（:96-98）用正则 `新闻|最新|最近|刚刚|today|latest|news|recent|发生了什么` 判定。任务里“只设 time_range:week、没用 topic:news”的描述与当前 main 分支不符——现状是二者联动。

仍存在的差距 / 可优化点（仅陈述，不改代码）：

1. **时效窗口偏宽**：新闻查询固定 `time_range:"week"`，对“今天/刚刚/latest”类问题应收紧到 `"day"` 或显式 `start_date`，否则可能返回 7 天前的旧闻。
2. **time_range 命中条件耦合 isNewsQuery**：非新闻类查询（`topic:general`）完全不设 `time_range`，对“某产品最新版本”等弱时效查询无回溯过滤。
3. **`chunks_per_source:3` 在 basic 路由下无效**：该参数仅 `search_depth=advanced` 生效；非 research 路由是 `basic`，此字段被忽略（无害，但冗余）。
4. **未使用 `include_domains`**：中文新闻场景没有指定 IT之家/36氪等源，命中依赖 Tavily 默认抓取，国内垂直站覆盖不稳定。
5. **未读取 `published_date` 做新鲜度排序/过滤**：已映射到 citation，但未基于它二次过滤“近 N 天”，时效完全交给 Tavily 的 `time_range`。
6. **`days` 概念已废弃**：若历史代码/文档里提到 `days`，应改为 `time_range`/`start_date`。

---

## Caveats / Not Found

- Tavily 官方未公开“中文媒体覆盖率”的量化数据；IT之家/36氪等站点覆盖只能通过 `include_domains` 主动指定来保证，实际命中需联调验证（本研究未发起真实 API 调用）。
- “近 1-2 天”是否用 `time_range:"day"` 还是 `start_date` 更稳，文档两者皆推荐；`time_range:"day"` 语义约等于 24 小时，需要精确到自然日窗口时用 `start_date`/`end_date`。
- 价格/额度为 2026-06 文档快照，可能随官方调整变化。
