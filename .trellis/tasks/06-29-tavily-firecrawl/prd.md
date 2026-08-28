# 统一搜索源抽象层：优化 Tavily 用法并接入 Firecrawl

## Goal

OpenHorn 的 Agent 联网搜索目前只有 Tavily 一条链路，且用法未优化——普通查询不设 `time_range`、新闻查询也没用 Tavily 的新闻专用接口，导致「推送今天科技新闻」这类实时性查询拿到的是近 1-3 周的旧闻。

目标：(1) 优化 Tavily 用法提升时效；(2) 把搜索抽象成「模型无关」的统一 search provider 层，接入 Firecrawl 作为第二个源；(3) 对所有模型提供商（Claude / GPT / DeepSeek / Gemini…）一视同仁，绝不依赖任一厂商模型自带的 web_search。

## What I already know

- 当前搜索全部走 **Tavily API**，项目自实现，分 Sidecar 与服务端两层：
  - Sidecar 工具：`apps/sidecar/src/agent/direct.ts:254-288`（web_search 直接 fetch Tavily），`buildTools` @ `direct.ts:356-474`（第 448 行条件包含搜索工具）
  - 服务端：`apps/server/src/services/searchService.ts:180-258`（`buildSearchContext` 主函数）
  - 路由：`apps/server/src/services/liveCapabilities.ts:467-551`（`buildLiveContext`）、`liveRouteClassifier.ts:6-48`（LLM 路由分类器）
  - 注入：`apps/server/src/services/messageService.ts:748-758`（调用搜索），第 783 行作为 `liveSystemContext` 注入提示词
- 搜索结果以格式化 systemContext 注入 LLM（带引用编号 + url + published_date + snippet）——**模型无关设计，方向正确**。
- 时效参数现状（`searchService.ts:206-207`）：research→`month`；命中新闻正则（新闻/最新/最近/news/latest）→`week`；普通查询→无限制（**根因之一**）。
- 「允许联网」开关：用户全局 `liveSearch.tavilyEnabled` / `tavilyApiKey`；会话级 `conversations.force_web_search`（默认 true，`packages/db/src/schema/index.ts:55`）；优先级 用户 key > 环境变量 `TAVILY_API_KEY`；禁用时降级离线回答。
- UI：`apps/desktop/src/components/chat/DesktopChatArea.tsx:1460-1476`（toggle）、`apps/desktop/src/components/settings/AgentSettings.tsx:102-133`（key + 启用开关）。

## 根因排序（时效问题）—— 经研究校正

> ⚠️ 校正：原假设「没用 topic:news」**错误**。`searchService.ts:200` 当前已按 `isNewsQuery()` 动态设 `topic:"news"`。真正根因是参数没调精 + 没做新鲜度二次过滤。

1. **新闻查询固定 `time_range:"week"` 偏宽**（最高）——「今天/刚刚/latest」类应收紧到 `"day"` 或显式 `start_date`，否则返回 7 天前旧闻（正是截图里 3 周前新闻的直接原因之一）。
2. **未基于 `published_date` 做新鲜度二次过滤/排序**（高）——已映射到 citation 但没用它筛「近 N 天」，时效完全交给 Tavily。
3. **未用 `include_domains` 指定中文源**（中）——IT之家/36氪等垂直站默认覆盖不稳。
4. 非新闻类（`topic:general`）查询完全不设 `time_range`，弱时效查询无回溯过滤（中）。
5. 新闻检测正则可扩展；路由分类器可能误判不搜索（中）。
6. `days` 参数**已废弃**，统一用 `time_range`/`start_date`（备注）。

> Firecrawl 校正：news 源**不支持 `tbs` 时间过滤**，`date` 是相对字符串（"3 months ago"），新闻硬时效需绕 `web` 源 + `tbs:"sbd:1,qdr:d"` + 域名定向。**故 Firecrawl 在「新闻时效」上并不优于 Tavily 的 `topic:news+time_range:day`；其真正强项是全文 markdown 抓取质量。**

## Requirements (evolving)

- [必做] 优化 Tavily 用法：新闻查询走 `topic:"news"` + `days`，所有查询设合理默认 `time_range`，扩展新闻关键字检测。
- [必做] 抽象统一 search provider 层（接口如 `SearchProvider.search(query, opts) -> normalizedResults`），Tavily 与 Firecrawl 都实现它。
- [必做] 接入 Firecrawl provider（按 news 源 + 全文），与 Tavily 并存。
- [必做] 同时作用于 Sidecar 与服务端两条链路（保持模型无关）。
- [必做] 不引入任何模型厂商自带 web_search。
- [待定] provider 选择 / fallback 策略（见 Open Questions）。
- [待定] Firecrawl 配置位置（API key、启用开关、UI）。

## Decision (ADR-lite) — Provider 策略已定

**Context**: 软件要分发给大量终端用户，要求零配置可用且效果好；高质量搜索 API 都要 key。
**Decision**:
- **默认 provider = DuckDuckGo（免 key、内置）**，所有用户开箱即用，无需任何配置。
- **存在 Tavily key 时（优先级：用户自配 key > server 环境变量 `TAVILY_API_KEY`）→ 切换到 Tavily**，并应用新闻时效优化。
- 选择逻辑：`hasTavilyKey ? Tavily : DuckDuckGo`。Tavily 调用失败可降级回 DuckDuckGo（待定，见下）。
- 砍掉 Firecrawl、Exa。不使用模型自带 web_search。
**Consequences**:
- 终端用户零成本零配置即可搜索（DDG）；进阶用户配 Tavily key 获得更好时效与 `published_date`。
- DDG 无官方 API、靠 html/lite 端点，质量偏弱、通常无发布日期、稳定性有风险——新闻时效优化（time_range/published_date/include_domains）**仅对 Tavily 链路生效**，DDG 链路尽力而为。
- provider 抽象层让两者通过统一接口接入，未来可再加源不改调用方。

## Research References

- [`research/tavily-news-api.md`](research/tavily-news-api.md) — Tavily `topic:news`+`time_range:day` 是新闻时效关键；`days` 已废弃；现状 `time_range:"week"` 偏宽。
- [`research/keyless-search-options.md`](research/keyless-search-options.md) — 七类 keyless 后端对比；DDG 评为最末级兜底（限流/ToS/无日期）；`pickApiKey`@:85 已具备 user→env key 回退接缝；`provider` 联合类型与 `buildSystemContext` 文案对 "tavily" 写死需扩展。
- [`research/firecrawl-search-api.md`](research/firecrawl-search-api.md) — （已弃用 Firecrawl，仅留档）news 源不支持 tbs 时间过滤。
- [`research/curated-sources.md`](research/curated-sources.md) — 5 类国际+中文精选域名表；推荐信任重排(provider无关)+Tavily 类目软定向 include_domains，TS 常量维护。

## Technical Approach（已定）

1. **Provider 抽象层**：定义 `SearchProvider.search(input) -> SearchCitation[]`（复用现有 provider 无关的 `SearchCitation`）。把 `searchService.ts:18` 的 `provider` 联合从 `"tavily"|"none"` 扩展为 `"tavily"|"duckduckgo"|"none"`；`buildSystemContext` 的 header 文案改为按 provider 动态生成（去掉写死的 "Tavily live search results:"）。
2. **Provider 选择**：复用 `pickApiKey`（user key > server env `TAVILY_API_KEY`）。`hasTavilyKey ? TavilyProvider : DuckDuckGoProvider`。
3. **DuckDuckGo provider（默认/兜底，免 key）**：TS/Bun 直接 `fetch` `https://lite.duckduckgo.com/lite/`（POST 表单），解析 HTML 得 title/url/snippet（日期多缺失，留空）。加**退避+jitter 重试**应对 `202`，加**短 TTL 内存缓存**降低重复请求。无外部库依赖。
4. **Tavily provider（有 key 时，质量增强）**：应用时效优化——新闻查询 `time_range` 由 `week` 收紧到 `day`（或显式 `start_date`）、基于 `published_date` 二次过滤近 N 天；移除无效的 `chunks_per_source`（basic 路由下不生效）。
5. **精选信源策略（国际 + 中文）— 已定**：以**信任重排为底座（provider 无关）**+ **Tavily 按类目软定向 include_domains** 组合，**弃用全量硬白名单**。
   - 维护一份分类 TS 常量清单（5 类：通用新闻/科技/财经/科学/开发者AI），国际+中文，每域标注信任度；server 与 sidecar 共用。详见 `research/curated-sources.md`。
   - **信任重排**：搜索后对结果按 `trust(hostname)` + `publishedDate` 新鲜度重排/过滤，低质站降权丢弃。仅用现有 `SearchCitation` 的 `url`+`publishedDate`，**无需新增字段**。对 Tavily 与 DDG 都生效（DDG 常缺 publishedDate，则主要靠 trust 维度）。
   - **不泛滥**：每次查询的 include_domains 只取**当前类目 ~10 个域名**（非全量 300），广度由重排兜底。
   - 注意：`country` 与 `topic:news` 互斥，中文/区域定向只能靠 include_domains 或重排，不能靠 `country`。
6. **降级链**：Tavily 调用失败（4xx/5xx/超时）→ 自动回退 DuckDuckGo，保证「永远能搜」。
7. **两条链路一致**：server `searchService.ts` 与 sidecar `direct.ts` 共用同一选择/降级逻辑（sidecar 改后需 `pnpm --filter sidecar run compile:tauri:host`）。
8. **降级状态可见**：复用现有 `degradedToDirectModel`/label 文案机制，体现当前源（Tavily / DuckDuckGo）。

## Implementation Plan（小 PR 拆分）

- **PR1**：Provider 抽象层 + DuckDuckGo provider（含退避/缓存）+ 选择逻辑（hasTavilyKey 路由）+ provider 联合类型与 system context 文案去硬编码。单测覆盖选择与 DDG 解析。
- **PR2**：Tavily provider 时效优化（time_range:day / published_date 过滤）+ 分类信源 TS 常量 + **信任重排（trust+freshness，provider 无关，作用于 Tavily 与 DDG 结果）** + Tavily 按类目软定向 include_domains + Tavily→DDG 降级链。单测覆盖参数、重排排序、降级。
- **PR3**：sidecar `direct.ts` 对齐同一逻辑 + 重新编译 + 桌面端实测（123@qq.com，验证无 key 走 DDG、配 key 走 Tavily、今天新闻时效）+ 文档/spec 更新。

## Out of Scope (explicit)

- Exa 接入（明确不做）。
- **Firecrawl 接入（用户决定不做——研究证实其新闻时效不优于 Tavily，强项全文抓取非当前痛点）。**
- 搜索增强类 Skill 的集成（skill 模块 ≠ MCP，放到后续单独任务讨论）。
- 改用模型自带 web_search（明确不做）。

## 新增核心需求：零配置开箱即用搜索（分发场景）

软件要分发给更多终端用户。痛点：终端用户若不配自己的搜索 API key，(1) 搜不了 (2) 效果差——这不可接受。
目标：内置一个「任意用户无需配 key 就能用、且效果好」的搜索能力。

待研究/待决策的实现路径（见 research + Open Questions）：
- **运营方共享 key**：分发者在 server 配一个 `TAVILY_API_KEY`（env 已支持 fallback），所有终端用户共享，无需各自配置。终端用户可选自带 key 覆盖。← 改动最小，质量好，但运营方需持有/承担 key。
- **真正 keyless 后端**：内置开源/免 key 搜索（如自托管 SearXNG、DuckDuckGo lite 等），完全不依赖任何人持有 key。← 质量/可靠性/运维有取舍。
- 两者结合：keyless 兜底 + 可选共享/自带 key 增强。

## Acceptance Criteria (evolving)

- [ ] 「推送今天科技新闻」类查询能稳定拿到近 1-2 天内的新闻（带正确 published_date）。
- [ ] Tavily 与 Firecrawl 通过统一接口可切换/降级，新增源不改调用方。
- [ ] Sidecar 与服务端两条链路行为一致。
- [ ] 切换底层模型提供商不影响搜索可用性。
- [ ] 未配置 Firecrawl key 时自动回退 Tavily，不报错。

## Definition of Done

- 单元/集成测试覆盖 provider 抽象与时效参数逻辑（bun test）。
- typecheck / biome check 通过。
- Tavily / Firecrawl 两条链路在桌面端实测验证（123@qq.com）。
- 行为变更同步文档/spec。

## Research References

- （待补）`research/tavily-news-api.md` — Tavily news 接口（topic/days/time_range）确切参数
- （待补）`research/firecrawl-search-api.md` — Firecrawl search 的 news 源与日期过滤能力

## Technical Notes

- 抽象层放置候选：`apps/server/src/services/` 下新增 `search/` 子目录（provider 实现 + registry），`searchService.ts` 改为调用 registry；Sidecar 侧 `direct.ts` 复用同一抽象或镜像实现（注意 sidecar 改后需 `pnpm --filter sidecar run compile:tauri:host`）。
- 配置遵循现有 `liveSearch.*` 用户设置结构，新增 `firecrawl*` 字段；DB 改动需同步 Drizzle schema + bootstrap DDL。
