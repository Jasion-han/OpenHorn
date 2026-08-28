# Research: 零配置（keyless）网页搜索后端方案对比

- **Query**: 为分发给大量终端用户的自托管 AI workspace（OpenHorn）研究「用户无需自配 API key、且效果好」的网页搜索后端方案
- **Scope**: 外部（厂商官方文档/仓库）+ 内部（当前 Tavily 集成现状）
- **Date**: 2026-06-29

---

## 0. 当前实现现状（内部）

| File Path | 说明 |
|---|---|
| `apps/server/src/services/searchService.ts` | 搜索核心。`buildSearchContext()` 调 `https://api.tavily.com/search`，返回 `SearchCitation[]`（title/url/snippet/publishedDate） |
| `apps/server/src/services/searchService.test.ts` | 搜索服务单测 |
| `apps/server/src/services/liveCapabilities.ts` | 路由 `web_search` / `research` 能力 |
| `apps/server/src/routes/settings.ts` | `liveSearch.tavilyApiKey` / `liveSearch.tavilyEnabled` 设置项 |
| `apps/sidecar/src/agent/direct.ts`, `apps/sidecar/src/index.ts`, `apps/sidecar/src/protocol.ts` | Sidecar 侧搜索调用 |

关键现状（`searchService.ts:85-94` `pickApiKey`）：**已经支持「用户 key 优先，缺省回退到 server 端 env key」**：

```ts
const userKey = input.userSettings?.[TAVILY_API_KEY_SETTING]?.trim();
if (userKey) return userKey;
const envKey = input.envKey?.trim();   // ← 运营方共享 key 的回退点已存在
if (envKey) return envKey;
return null;
```

- Provider 类型当前写死为 `"tavily" | "none"`（`searchService.ts:18`）——若要引入多 provider 需扩展该联合类型与 `buildSystemContext` 的 header 文案。
- 返回结构 `SearchCitation` 是 provider 无关的，**任何后端只要能产出 {title,url,snippet,publishedDate} 即可无缝替换**，这是做「provider 抽象 + keyless 兜底」的天然接缝。

---

## 1. 方案对比总表

| 方案 | 真零配置? | 质量 | 可靠性 | 法律/ToS 风险 | 成本随规模 | 运维负担 | 模型无关? |
|---|---|---|---|---|---|---|---|
| **A. 运营方共享 Tavily key** | 对终端用户是（server 配一次） | 高（专为 LLM 优化，带 snippet/日期） | 高 | 低（合规商用 API） | **额度天花板低**：免费 1000 credits/月全体共享；超出 $0.008/credit 线性增长 | 低（一个 env） | 是 |
| **B. 自托管 SearXNG** | 是（部署后无 key） | 中（聚合 Google/Bing/DDG，原始 SERP，无 LLM 摘要） | 中（依赖上游引擎，易被 Google 限流） | 低-中（聚合抓取，灰区但开源自用普遍） | **近零边际成本**（自己服务器） | **高**（需 docker 部署+维护+IP 管理） | 是 |
| **C. DuckDuckGo keyless (ddgs)** | 是（无 key） | 中-低（有 title/snippet，日期常缺失） | **低**（频繁 `202 Ratelimit` 软封） | 中（无官方搜索 API，违反 ToS 灰区，抓取 html/lite 端点） | 零（直连） | 低（一个库） | 是 |
| **D. Brave Search API** | ~是（server 配一次） | 高（独立 30B+ 页索引） | 高 | 低 | **2026-02 起免费档已取消**：仅 $5/月赠金≈1000 次，超出 $5/1000 | 低 | 是 |
| **E. Serper.dev** | ~是（server 配一次） | 高（真 Google SERP） | 高 | 低（合规 API） | 2500 次**一次性**试用额度（非每月），之后 $0.30–$1.00/1000 | 低 | 是 |
| **F. Google CSE (Custom Search JSON)** | ~是 | 中-高（Google，但限 10 结果/页、100/页上限） | 高 | 低 | 免费 100 次/天，付费 $5/1000，**硬顶 10000/天**；**已对新客户关闭** | 中（需建 CSE + GCP 计费） | 是 |
| **G. Bing Web Search API** | — | — | **已死** | — | **2025-08-11 退役**，不可新建 | — | — |

---

## 2. 各方案调用方式要点与核查结论

### A. 运营方共享 key 模型（server 端配一个 Tavily key）
- 调用：现状 `POST https://api.tavily.com/search`，`Authorization: Bearer <key>`（`searchService.ts:213-221`）。回退点已就绪，分发时只需在 server 填 `TAVILY_API_KEY` env，所有用户共享。
- **核查（docs.tavily.com）**：
  - 免费档 **1000 credits/月，无需信用卡**；基础搜索约 1 credit/次、advanced 约 2 credits/次。
  - **Rate Limit**：开发 key 100 RPM，生产 key 1000 RPM，research 端点仅 20 RPM。
  - 超额：Pay-as-you-go $0.008/credit。
- **共享 key 的核心瓶颈**：免费 1000 credits 是**全体用户共享的月度池**，几十个活跃用户即耗尽 → 必须升级付费且**按用户限流**（否则单用户刷爆全体额度）。1000 RPM 在并发高时也可能撞限。滥用风险高（key 在 server，不暴露给客户端是前提）。
- 注：Tavily 2026 已被 Nebius 收购，定价/限额可能继续变动。

### B. 自托管 SearXNG（开源元搜索）
- **核查（docs.searxng.org / litellm docs / 社区）**：
  - JSON API：`GET /search?q=...&format=json`。**默认关闭**，需在 `settings.yml` 设：
    ```yaml
    search:
      formats: [html, json]   # 必须显式加 json，否则 API 返回 403
    ```
  - **真免 key**：是。官方 docker 镜像 `docker.io/searxng/searxng:latest`（DockerHub 现对匿名拉取限流，可用 GHCR 镜像）。
  - **限流器（limiter / botdetection）**：`server.limiter: true` + `public_instance` 会拦截自动化请求；自用 API 场景通常需要调整 limiter 配置才能让程序化 JSON 调用通过。这是「自己防滥用」与「自己程序能用」之间需要平衡的点。
  - **被上游封的风险**：聚合 Google/Bing/DDG 等 70+ 引擎，自托管单 IP 高频会被 **Google 引擎限流/封**（社区高频痛点）；需配代理池或降低频率。
- 适合打包进自托管应用？**适合作为「随产品一起 docker compose 起一个 searxng」的零成本默认**，但运维与稳定性是代价。质量为原始 SERP，**无 LLM 摘要**，需自己做内容抽取（与 Firecrawl/extract 配合）。

### C. DuckDuckGo 免 key（ddgs / html|lite 端点）
- **核查（PyPI / SearXNG DDG engine doc / 社区）**：
  - `duckduckgo_search` **已更名为 `ddgs`**（`pip install ddgs`，旧 pin 已失效）。
  - 端点：`https://html.duckduckgo.com/html`、`https://lite.duckduckgo.com/lite`（HTTP POST、无 JS 表单），可跳过 `vqd` token 握手。
  - **真免 key**：是，但**无官方搜索 API**（DDG 官方只有 Instant Answer API，非网页搜索）。
  - **稳定性差**：极易触发 `202 Ratelimit` 软封，社区报告即便单请求/加 5s 间隔仍被限；需退避+jitter，自有住宅 IP 优于被标记的代理。
  - **ToS/法律**：抓取这些端点属灰区，违反 DDG 使用条款的风险存在；商业分发尤其敏感。
  - **返回质量**：有 title + snippet，**日期常缺失**，质量中-低。
- 结论：适合做**最后兜底**或低频场景，不宜作大规模主力。

### D. Brave Search API
- **核查（brave.com/search/api、api-dashboard.search.brave.com、多方 2026-02 报道）**：
  - **重要变更：2026-02 免费档已被取消**。此前（截至 2025-08）有 2000–5000 次/月免费、无需账单；现改为**信用制**：每月自动赠 **$5 credit ≈ 1000 次**，超出 **$5/1000 requests**（含 web/news/images + LLM context）。
  - 仍需在 dashboard 注册拿 key；据报道即便走赠金也**需绑卡**，超额自动计费。
  - 质量高（独立索引），适合做共享 key，但「免费」窗口已基本等同 Tavily（~1000/月），不再有规模优势。

### E. Serper.dev
- **核查（serper.dev、多方 2026 评测）**：
  - 注册赠 **2500 credits**，但是**一次性试用**（非每月续；额度 6 个月有效），多处标注「无需信用卡」。
  - 之后 $1.00/1000（小量）至 $0.30/1000（规模化），50 QPS。
  - 真 Google SERP，质量高、速度 1-2s。适合做共享 key 的低价主力，但**无持续免费档**。

### F. Google Programmable Search Engine（Custom Search JSON API）
- **核查（developers.google.com/custom-search）**：
  - **官方公告：已对新客户关闭**（"closed to new customers"，推荐 Vertex AI Search）——新项目可能无法再启用。
  - 既有：免费 **100 次/天**，付费 $5/1000，**硬顶 10000 次/天**（绑 GCP 计费也不能超）。
  - 每次最多 10 结果、最多翻 10 页（共 100 结果上限）。
  - 需自建 Programmable Search Engine + 配 GCP 计费，运维偏重。

### G. Bing Web Search API
- **核查（learn.microsoft.com lifecycle）**：**2025-08-11 正式退役**，2025-02 起已禁止在 Azure 新建资源。**不可用，排除**。

### 其他简列
- **SerpApi / Scrapingdog / SearchApi**：合规 SERP 代理，均小额免费（100/月级），付费按量，质量高，可做共享 key 备选。
- **Exa / Firecrawl search**：面向 AI 的搜索，各 1000 credits/月免费档，可做共享 key（与本仓库 Firecrawl MCP 已有集成方向契合）。

---

## 3. 针对「分发给大量终端用户 + 零配置 + 效果好」的推荐排序

> 诉求核心矛盾：终端用户**不配 key**，但要**效果好**且**规模可控成本**。没有任何单一方案能同时满足「永久免费 + 高质量 + 大规模」，因此推荐**分层组合**。

**推荐排序（综合）：**

1. **【首选】内置共享 key（默认）+ keyless 兜底 的双层架构**
   - 默认走运营方在 server 配的商用 key（Tavily 现状，或换 Serper/Brave）——零配置、质量高。
   - 必须叠加**按用户/按 IP 限流 + 配额**，防止单用户刷爆共享额度（这是共享 key 模型的生死线）。
   - 当共享额度耗尽 / 上游报错时，**自动降级到 keyless 兜底**（SearXNG 或 DDG），保证「永远能搜」。
   - 落点：复用 `pickApiKey` 的 env 回退，已具备；新增 provider 抽象 + 降级链。

2. **【自托管友好首选】随产品打包 self-hosted SearXNG 作默认 keyless 后端**
   - 对「完全自托管、不想依赖任何外部商用 key」的分发场景最契合：`docker compose` 里多起一个 searxng，`format=json` 即用，边际成本近零、模型无关。
   - 代价：运维 + Google 引擎被限风险 → 需配 limiter/代理与缓存。质量为原始 SERP，建议配 extract 做正文抽取。

3. **共享 Serper/Brave key**：作为共享 key 的替代/补充。Serper 2500 一次性额度适合「先体验」；Brave/Serper 付费单价低，适合规模化主力，但都**无持续免费档**。

4. **DuckDuckGo (ddgs)**：仅作**最末级兜底**。免 key 但限流严重、ToS 灰区、质量中低，不可作大规模主力。

5. **Google CSE**：已对新客户关闭 + 硬顶 10000/天 + 运维重，**不推荐新接入**。

6. **Bing**：已退役，**排除**。

### 最实际的组合（明确建议）
```
默认：运营方共享商用 key（Tavily 现状 / 或 Serper）   ← 零配置、质量高
  + 强制：按用户限流 + 月度配额（防滥用刷爆共享池）
  ↓ 额度耗尽 / 上游 4xx-5xx / 超时
兜底：self-hosted SearXNG（format=json，随产品 docker 部署）  ← 永远可用、零边际成本
  ↓ SearXNG 不可用
末级兜底：ddgs（DuckDuckGo keyless）                        ← 尽力而为
```
即：**「内置共享 key 默认 + SearXNG/keyless 兜底」**，并把 `searchService` 的 `provider` 联合类型从 `"tavily"|"none"` 扩展为多 provider，复用现有 `SearchCitation` 抽象做降级链。

---

## 4. 风险清单

- **共享 key 额度天花板**：Tavily/Brave 免费均≈1000 次/月**全体共享**；不限流则几十个用户即耗尽。**必须按用户限流 + 监控用量**。
- **共享 key 滥用/泄露**：key 须只存在 server 端，**绝不下发到桌面/客户端**（否则被提取盗刷）。当前 sidecar 在本地，需确认 key 不经由 sidecar 暴露。
- **SearXNG 被上游封**：自托管单 IP 高频会被 Google 限流；需 limiter、缓存、必要时代理池。
- **SearXNG 默认不开 JSON**：`settings.yml` 必须显式 `search.formats: [html, json]`，且 limiter 配置要兼顾「防滥用」与「让本程序 JSON 调用通过」。
- **DDG 不稳定 + ToS 灰区**：`202 Ratelimit` 频发；商业分发抓取灰区端点有合规风险。
- **厂商政策突变**：Brave 已于 2026-02 砍免费档、Bing 2025-08 退役、Google CSE 对新客户关闭、Tavily 被 Nebius 收购——**所有商用免费档都不可长期依赖**，故必须保留 keyless 兜底。
- **质量不一致**：keyless（SearXNG/DDG）无 LLM 摘要、日期常缺失，降级时引用质量会下降，需在 UI/系统提示中体现「降级」状态（现有 `degradedToDirectModel`、label 文案机制可复用）。
- **provider 扩展面**：`buildSystemContext` 的 "Tavily live search results:" header 等文案与 `provider` 联合类型写死，新增后端需同步改动，否则类型不通过。

## Caveats / Not Found
- 各厂商**免费额度/单价为 2026-06 抓取的公开信息**，价格条款变动频繁，落地前请以官方 dashboard 实时为准。
- 未实测 SearXNG 在本项目 docker 环境的实际 QPS/被封概率；未实测 ddgs 在生产并发下的真实可用率——建议各做一次小规模压测再定兜底层。
