# Research: Firecrawl Search API（新闻 / 实时搜索能力）

- **Query**: Firecrawl `/search` 端点是否支持 news 源、tbs 时间过滤、scrapeOptions 全文、鉴权/REST 示例、速率限制/计费、中文新闻覆盖；与 Tavily 对比
- **Scope**: external（Firecrawl 官方文档 docs.firecrawl.dev）
- **Date**: 2026-06-29

## 结论速览

- Firecrawl `/search`（v2，`POST https://api.firecrawl.dev/v2/search`）支持 `sources: ["web","news","images"]`，可单次请求多源；`limit` 在多源时为**每源**上限。
- **关键时效性陷阱**：`tbs` 时间过滤（`qdr:d` 等）**只对 `web` 源生效，对 `news` / `images` 不生效**（官方明确说明）。`news` 源本身按新闻引擎的相关性 + 时效返回，并带 `date` 字段，但格式是相对时间字符串（如 `"3 months ago"`），无法用 `tbs` 强制锁定"近 24 小时"。
- 要拿"当天/近几天"硬时效新闻，最可靠组合是 **`web` 源 + `tbs: "sbd:1,qdr:d"`（按日期排序 + 近 24h）+ `site:` 定向到新闻域名**，而不是直接用 `news` 源。
- `scrapeOptions` 可在搜索同一次调用里返回每条结果的全文 `markdown`（以及 html / summary / links 等），news 源同样支持 scrape 字段。
- 鉴权：HTTP Bearer，`Authorization: Bearer fc-YOUR_API_KEY`。无 key 也能用（仅限官方 client/SDK/CLI/MCP，按 IP 限流）。
- 计费：搜索 **2 credits / 每 10 条结果**（向上取整）；加 `scrapeOptions` 时每条结果再按 scrape 计费（basic 1 credit/页）。

---

## Findings

### 1. `/search` 端点参数表（v2 OpenAPI 实测）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string (≤500 chars) | 必填 | 查询词，支持搜索操作符（见下） |
| `limit` | int 1–100 | 10 | 返回结果数；**多源时为每源上限**（`limit:5` + `sources:[web,news]` ⇒ 最多 5+5=10 条） |
| `sources` | array | `["web"]` | 取值 `web` / `news` / `images`。可同时传多个。`web` 源对象内可单独带 `tbs`、`location` |
| `categories` | array | `[]` | `github` / `research` / `pdf`，结果带 `category` 字段 |
| `tbs` | string | — | 时间过滤，**仅作用于 web 源**。`qdr:h/d/w/m/y`、`sbd:1`（按日期排序）、`cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY`（自定义区间）。可组合 `sbd:1,qdr:w` |
| `location` | string | — | 地理定位，如 `"Germany"`、`"San Francisco,California,United States"`。完整列表 `firecrawl.dev/search_locations.json` |
| `country` | string (ISO) | `US` | 国家码 geo-targeting，如 `CN`/`JP`/`DE`。建议与 `location` 一起设 |
| `timeout` | int (ms) | 60000 | 搜索超时 |
| `ignoreInvalidURLs` | bool | false | 过滤对其他 Firecrawl 端点无效的 URL |
| `enterprise` | array | — | ZDR 零数据保留：`["zdr"]`（端到端，10cr/10条）/ `["anon"]`（匿名，2cr/10条），需企业版开通 |
| `scrapeOptions` | object | `{}` | 对每条结果做 scrape，见下表 |

**搜索操作符**（写进 `query` 字符串）：`"..."` 精确、`-` 排除、`site:`、`-site:`、`filetype:`、`inurl:`、`allinurl:`、`intitle:`、`allintitle:`、`related:`、`imagesize:`、`larger:`。

**`tbs` 常用值**：`qdr:h`(近1h) `qdr:d`(近24h) `qdr:w`(近一周) `qdr:m`(近一月) `qdr:y`(近一年) `sbd:1`(按日期排序，最新优先)。

**域名过滤**：`includeDomains` / `excludeDomains`（互斥，二选一；只填 hostname，无协议/路径；内部转为 `site:` / `-site:`）。

### 2. `scrapeOptions` 关键子参数（搜索时一并取全文）

| 参数 | 默认 | 说明 |
|---|---|---|
| `formats` | `["markdown"]` | 可选 `markdown` / `summary`(精简) / `html` / `rawHtml` / `links` / `images` / `screenshot` / `json`(带 schema/prompt) 等 |
| `onlyMainContent` | true | HTML 层去 header/nav/footer（无 LLM） |
| `onlyCleanContent` | false | Beta，额外 LLM 清洗残余样板 |
| `maxAge` | 172800000 (2天) | 命中更年轻的缓存则直接返回，可提速 ~500% |
| `proxy` | auto | `basic`/`enhanced`(最多+5cr)/`auto` |
| `parsers` | `["pdf"]` | 设 `[]` 关闭 PDF 解析省 credits |
| `timeout` | 60000 | scrape 超时，最大 300000 |

> 要在搜索结果里同时拿全文 markdown：`"scrapeOptions": { "formats": ["markdown"] }`。news 源结果同样会带 `markdown` 字段。

### 3. 响应结构（按源分组，注意不是扁平 data 数组）

```jsonc
{
  "success": true,
  "data": {
    "web":   [ { "url", "title", "description", "position",
                 "markdown"?, "links"?, "metadata": {...} } ],
    "news":  [ { "title", "snippet", "url", "date", "imageUrl", "position",
                 "markdown"?, "metadata": {...} } ],
    "images":[ { "title", "imageUrl", "imageWidth", "imageHeight", "url", "position" } ]
  },
  "warning": null,
  "id": "<jobId>",
  "creditsUsed": 2
}
```

- **news 项含 `date` 字段**，但官方示例里是相对时间字符串 `"3 months ago"`，不是 ISO 时间戳 —— 需要在客户端归一化/解析，且不能保证当天精度。
- SDK 返回按源分组（`result.web` / `result.news` / `result.images`），不是通用 `.data` 数组；裸 cURL 返回上面完整 payload。

### 4. 推荐"拿今天科技新闻"的参数组合

因为 `tbs` 对 `news` 源无效，按可靠性从高到低：

**方案 A（硬时效，推荐用于"当天/近几天"）—— web 源 + 时间过滤 + 新闻域名定向：**
```bash
curl -X POST "https://api.firecrawl.dev/v2/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer fc-YOUR_API_KEY" \
  -d '{
    "query": "AI 人工智能 site:36kr.com OR site:techcrunch.com OR site:theverge.com",
    "sources": [ { "type": "web", "tbs": "sbd:1,qdr:d" } ],
    "limit": 15,
    "country": "US",
    "scrapeOptions": { "formats": ["markdown"], "onlyMainContent": true }
  }'
```
- `sbd:1,qdr:d` = 近 24 小时 + 按日期排序最新优先。`qdr:w` 放宽到近一周。
- 用 `includeDomains` 也可（与 site: 等效）：`"includeDomains": ["36kr.com","techcrunch.com","theverge.com"]`。

**方案 B（用 news 源拿新闻版式，时效较软）：**
```bash
curl -X POST "https://api.firecrawl.dev/v2/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer fc-YOUR_API_KEY" \
  -d '{
    "query": "科技 today technology",
    "sources": ["news"],
    "limit": 10
  }'
```
拿到后用返回的 `date` 字段在本地按"近 N 天"过滤/排序（注意相对时间字符串需解析）。

**方案 C（兼顾）**：一次请求 `sources: [{"type":"web","tbs":"sbd:1,qdr:d"}, {"type":"news"}]`，web 部分保证时效、news 部分补新闻版式，再客户端合并去重。

### 5. 鉴权 & 最小 fetch 示例（便于 sidecar/server 实现）

鉴权：`securitySchemes.bearerAuth = http bearer` → header `Authorization: Bearer fc-...`。

```ts
// 适合放在 server 或 sidecar 的 fetch 实现
const res = await fetch("https://api.firecrawl.dev/v2/search", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
  },
  body: JSON.stringify({
    query: "今日科技新闻",
    sources: [{ type: "web", tbs: "sbd:1,qdr:d" }],
    limit: 10,
    country: "US",
    scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
  }),
});
const json = await res.json();
// json.data.web -> [{ url, title, description, markdown, metadata }]
```

错误码：`408`（超时，`{success:false,error}`）、`500`（`{success:false,code,error}`）。限流/并发超限返回 `429`。

### 6. 速率限制 / 免费额度 / 计费

**计费（credits）：**
- 搜索本身：**2 credits / 每 10 条结果**，向上取整（1–10 条=2cr，11–20=4cr…）。
- 开 `scrapeOptions` 时每条结果再叠加 scrape 费：basic scrape **1 credit/页**；PDF 1cr/页；enhanced proxy +4cr/页；JSON 模式 +4cr/页。
- 控成本：`parsers:[]` 关 PDF、`proxy:"basic"` 或 `"auto"`、调小 `limit`。
- 订阅制月度计划（无纯按量），支持 auto-recharge 自动补 credits。免费注册得 **1,000 credits**。

**`/search` 速率限制（requests/min，按团队共享）：**

| 计划 | /search rpm | 并发浏览器 |
|---|---|---|
| Free | 5 | 2 |
| Hobby | 50 | 5 |
| Standard | 250 | 50 |
| Growth | 2500 | 100 |
| Scale | 7500 | 150+ |

**Keyless（无 API key）**：仅官方 client/SDK/CLI/MCP 可用，按 IP 每天限「请求数 + credits」双上限，超限 `429`。注册免费 key 即提额。

### 7. 中文新闻源覆盖

- 文档未单列中文/各国新闻源清单。底层用上游搜索引擎（Google 系语法 `tbs`/`site:` 等），理论上能覆盖中文新闻站，但需靠 `query` 写中文关键词 + `site:36kr.com/site:sina.com.cn` 等定向，以及 `country: "CN"` + `location` 提升中文区相关性。
- `location` 支持列表见 `https://firecrawl.dev/search_locations.json`（含国家/语言）。
- **不确定**：news 源对纯中文媒体的召回质量、`date` 字段对中文站的可解析性，文档无明确保证，建议接入时实测（见 Caveats）。

---

## 与 Tavily 的能力对比

| 维度 | Firecrawl `/search` | Tavily `/search` |
|---|---|---|
| 端点 | `POST api.firecrawl.dev/v2/search` | `POST api.tavily.com/search` |
| 鉴权 | `Authorization: Bearer fc-...` | `Authorization: Bearer tvly-...`（或 body `api_key`） |
| 新闻模式 | `sources:["news"]`（与 web/images 可混） | `topic:"news"`（与 `general` 二选一） |
| 时间过滤 | `tbs`（qdr/sbd/cdr）**仅 web 源** | `time_range`(day/week/month/year) + **`days`（news 专用，回溯 N 天）** |
| 新闻日期字段 | news 项有 `date`，**相对字符串**("3 months ago") | news 结果带 `published_date`（多为可解析日期） |
| 全文内容 | `scrapeOptions.formats:["markdown"]` 取**真·全文 markdown**（Firecrawl scrape 引擎） | `include_raw_content`(true/markdown) 取原文，质量/清洗弱于 Firecrawl |
| 摘要/答案 | scrape `summary` / `json` / `question` 格式 | `include_answer`（LLM 直接给答案） |
| 域名过滤 | `includeDomains`/`excludeDomains`（互斥） | `include_domains`/`exclude_domains`（可共存） |
| 地理定位 | `location` + `country` | `country`（advanced） |
| 计费单位 | credits（搜索 2cr/10条，+scrape） | API credits（basic 1、advanced 2 per request；含 raw content 额外） |
| 免费额度 | 注册得 1000 credits | 每月 1000 free credits |
| 强项 | **抓全文/结构化内容质量高**，搜索+scrape 一体 | **新闻时效控制更直接**（`days` + `published_date`），上手简单 |
| 弱项（时效） | news 不支持 `tbs`，需绕道 web+tbs+site: | 原文清洗/全文质量不如 Firecrawl scrape |

**对 OpenHorn "新闻时效" 诉求的要点**：
- 若目标是"严格当天/近 N 天"，**Tavily 的 `topic:"news" + days:N` 更直接**，且 `published_date` 通常可解析。
- Firecrawl 在"拿到结果后还要全文 markdown 喂模型"上更强；做新闻时效需用 `web` 源 + `tbs:"sbd:1,qdr:d"` + 新闻域名定向来补偿 news 源无 `tbs` 的短板。
- 两者都"模型无关"、都是 Bearer + REST，适合在 sidecar/server 用统一 fetch 适配层并列接入。

---

## Caveats / Not Found

- **`tbs` 对 news/images 无效**是官方明确限制，是本次最关键的时效性约束。
- news 项 `date` 文档示例为相对时间字符串（"3 months ago"），未保证 ISO 格式；接入需做解析/容错，且无法保证"当天"精度。
- 中文新闻源召回质量、`date` 在中文站的可解析性，文档无明确说明 —— 标记为**需接入后实测**。
- Tavily 一侧参数（`days`/`time_range`/`published_date`/`include_raw_content`）来自既有知识 + 文档关键词命中校验；Tavily 官方文档为 JS 渲染未逐字抓全，接入前建议再核对 `https://docs.tavily.com` 最新字段。
- 计费/限流数据来自 `docs.firecrawl.dev/rate-limits` 与 `features/search`（截至 2026-06-29），计划档位可能随官网调整。
