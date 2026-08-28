# Research: 精选信源（域名）白名单 + 应用策略

- **Query**: 为 OpenHorn 搜索功能编一份「精选、分类、有界」的高质量信源清单（国际 + 中文），并给出 `include_domains` / 信任重排的应用策略与维护方式
- **Scope**: mixed（external: 公开信源域名知识；internal: `apps/server/src/services/searchService.ts`）
- **Date**: 2026-06-29
- **关联**:
  - `research/tavily-news-api.md` — `include_domains` 最多 300 域名、支持通配（如 `*.com`）；`published_date` 仅 `topic:news` 返回
  - `research/keyless-search-options.md` — DDG 兜底链路质量弱、通常无日期
  - `prd.md` Technical Approach 第 5 条 — 倾向「信任加权 + 按类目可选 include_domains」而非巨型硬白名单

---

## 0. 设计约束（来自代码）

- 归一化结果类型 `SearchCitation`（`searchService.ts:6-11`）只有 `title / url / snippet? / publishedDate?`。**信任重排只能基于 `url` 的 hostname + `publishedDate`**，无需新增字段即可落地。
- Tavily `include_domains`：数组、**最多 300**、支持通配。`exclude_domains` 最多 150。
- `country` 参数仅 `topic=general` 可用，与 `news` 互斥——所以中文源定向**不能靠 `country`**，只能靠 `include_domains`。
- **DDG 兜底链路无 `include_domains` 能力**（HTML/lite 端点），且常缺 `publishedDate`——见第 4 节。

域名书写规则：填 `include_domains` 用裸 hostname（不带协议/路径）。带子域的官方博客（如 `blog.google`、`research.google`）要按子域精确写；若想覆盖全站用通配（如 `*.nature.com`）。

---

## 1. 分类信源白名单

> 列标注：**语言**（EN/ZH/双语）｜**付费墙**（无/部分/硬）｜**时效**（强=分钟~小时级更新，中=每日，弱=深度/慢）｜**可信度**（很高/高/中）。
> 「部分」付费墙=有免费额度或大量免费稿但核心深度内容收费；「硬」=多数正文需订阅（正文抓取受限，但标题/摘要+发布日期仍可用于重排与引用）。

### 1.1 通用 / 突发新闻

#### 国际
| hostname | 语言 | 付费墙 | 时效 | 可信度 | 备注 |
|---|---|---|---|---|---|
| `reuters.com` | EN | 部分 | 强 | 很高 | 通讯社，突发首选 |
| `apnews.com` | EN | 无 | 强 | 很高 | AP 通讯社，免费 |
| `afp.com` | EN/多语 | 无 | 强 | 很高 | 法新社 |
| `bbc.com` | EN | 无 | 强 | 很高 | 含 `bbc.co.uk` |
| `theguardian.com` | EN | 无 | 强 | 高 | 免费、更新快 |
| `nytimes.com` | EN | 硬 | 强 | 很高 | 标题/摘要可用 |
| `washingtonpost.com` | EN | 硬 | 强 | 高 | |
| `aljazeera.com` | EN | 无 | 强 | 高 | 非西方视角补充 |
| `npr.org` | EN | 无 | 中 | 高 | |
| `economist.com` | EN | 硬 | 中 | 很高 | 偏深度 |
| `axios.com` | EN | 无 | 强 | 高 | 简讯式快讯 |
| `politico.com` | EN | 部分 | 强 | 高 | 政治时政 |

#### 中文
| hostname | 语言 | 付费墙 | 时效 | 可信度 | 备注 |
|---|---|---|---|---|---|
| `thepaper.cn` | ZH | 无 | 强 | 高 | 澎湃新闻 |
| `news.cn` | ZH | 无 | 强 | 高 | 新华社（亦 `xinhuanet.com`） |
| `people.com.cn` | ZH | 无 | 强 | 高 | 人民网 |
| `caixin.com` | ZH | 部分 | 强 | 很高 | 财新，深度+时效俱佳（英文 `caixinglobal.com`） |
| `jiemian.com` | ZH | 无 | 强 | 高 | 界面新闻 |
| `yicai.com` | ZH | 无 | 强 | 高 | 第一财经（财经/通用兼有） |
| `ce.cn` | ZH | 无 | 中 | 中 | 中国经济网 |

### 1.2 科技

#### 国际
| hostname | 语言 | 付费墙 | 时效 | 可信度 | 备注 |
|---|---|---|---|---|---|
| `techcrunch.com` | EN | 无 | 强 | 高 | 创投/产品快讯 |
| `theverge.com` | EN | 无 | 强 | 高 | 消费科技 |
| `arstechnica.com` | EN | 无 | 中 | 很高 | 技术深度 |
| `wired.com` | EN | 部分 | 中 | 高 | |
| `technologyreview.com` | EN | 部分 | 中 | 很高 | MIT Technology Review |
| `news.ycombinator.com` | EN | 无 | 强 | 中 | Hacker News，聚合+讨论（信号强但非一手） |
| `theinformation.com` | EN | 硬 | 强 | 很高 | 科技独家，付费墙硬 |
| `engadget.com` | EN | 无 | 强 | 中 | |
| `restofworld.org` | EN | 无 | 中 | 高 | 非美科技生态 |
| `404media.co` | EN | 部分 | 中 | 高 | 调查报道 |

#### 中文
| hostname | 语言 | 付费墙 | 时效 | 可信度 | 备注 |
|---|---|---|---|---|---|
| `ithome.com` | ZH | 无 | 强 | 高 | IT之家，更新极快 |
| `36kr.com` | ZH | 无 | 强 | 高 | 36氪，创投/科技 |
| `huxiu.com` | ZH | 无 | 中 | 高 | 虎嗅，商业科技评论 |
| `sspai.com` | ZH | 无 | 中 | 高 | 少数派，软件/效率 |
| `geekpark.net` | ZH | 无 | 中 | 中 | 极客公园 |
| `pingwest.com` | ZH | 无 | 中 | 中 | 品玩 |
| `tmtpost.com` | ZH | 无 | 中 | 中 | 钛媒体 |
| `leiphone.com` | ZH | 无 | 中 | 中 | 雷锋网 |

### 1.3 财经 / 市场

#### 国际
| hostname | 语言 | 付费墙 | 时效 | 可信度 | 备注 |
|---|---|---|---|---|---|
| `bloomberg.com` | EN | 硬 | 强 | 很高 | 市场首选 |
| `wsj.com` | EN | 硬 | 强 | 很高 | 华尔街日报 |
| `ft.com` | EN | 硬 | 强 | 很高 | 金融时报 |
| `cnbc.com` | EN | 无 | 强 | 高 | 免费、盘中快 |
| `marketwatch.com` | EN | 部分 | 强 | 中 | 行情/快讯 |
| `barrons.com` | EN | 硬 | 中 | 高 | |
| `fortune.com` | EN | 部分 | 中 | 高 | |

#### 中文
| hostname | 语言 | 付费墙 | 时效 | 可信度 | 备注 |
|---|---|---|---|---|---|
| `caixin.com` | ZH | 部分 | 强 | 很高 | 财新（财经权威） |
| `yicai.com` | ZH | 无 | 强 | 高 | 第一财经 |
| `wallstreetcn.com` | ZH | 部分 | 强 | 高 | 华尔街见闻，盘中快讯 |
| `cls.cn` | ZH | 无 | 强 | 高 | 财联社，电报式快讯 |
| `stcn.com` | ZH | 无 | 中 | 高 | 证券时报 |
| `eastmoney.com` | ZH | 无 | 强 | 中 | 东方财富（行情强，社区噪声多，建议低权重） |

### 1.4 科学 / 研究
| hostname | 语言 | 付费墙 | 时效 | 可信度 | 备注 |
|---|---|---|---|---|---|
| `nature.com` | EN | 部分 | 中 | 很高 | News 栏目免费 |
| `science.org` | EN | 部分 | 中 | 很高 | AAAS |
| `arxiv.org` | EN | 无 | 强 | 高 | 预印本，一手最新（未同行评审，注明） |
| `pnas.org` | EN | 部分 | 中 | 很高 | |
| `cell.com` | EN | 硬 | 中 | 很高 | |
| `thelancet.com` | EN | 部分 | 中 | 很高 | 医学 |
| `nejm.org` | EN | 硬 | 中 | 很高 | 医学 |
| `quantamagazine.org` | EN | 无 | 中 | 很高 | 科学解读，质量极高 |
| `scientificamerican.com` | EN | 部分 | 中 | 高 | |
| `newscientist.com` | EN | 部分 | 中 | 高 | |
| `biorxiv.org` | EN | 无 | 强 | 中 | 生物预印本 |

### 1.5 开发者 / AI（官方博客 + 一手）
| hostname | 语言 | 付费墙 | 时效 | 可信度 | 备注 |
|---|---|---|---|---|---|
| `github.com` | EN | 无 | 强 | 高 | 一手代码/release |
| `github.blog` | EN | 无 | 中 | 高 | GitHub 官方博客 |
| `openai.com` | EN | 无 | 强 | 很高 | 官方公告（含 `/blog`, `/index`） |
| `anthropic.com` | EN | 无 | 强 | 很高 | 官方 news/research |
| `deepmind.google` | EN | 无 | 中 | 很高 | |
| `research.google` | EN | 无 | 中 | 很高 | 含 `ai.googleblog.com`（旧） |
| `blog.google` | EN | 无 | 强 | 高 | Google 官方博客 |
| `ai.meta.com` | EN | 无 | 中 | 高 | Meta AI |
| `huggingface.co` | EN | 无 | 强 | 高 | 模型/blog |
| `developer.mozilla.org` | EN | 无 | 中 | 很高 | MDN，Web 权威 |
| `stackoverflow.com` | EN | 无 | 中 | 中 | 问答（噪声有，但定向有用） |
| `devblogs.microsoft.com` | EN | 无 | 中 | 高 | |
| `aws.amazon.com` | EN | 无 | 中 | 高 | `/blogs`（注意全站很大，建议配路径关键词） |
| **AI 中文** `jiqizhixin.com` | ZH | 无 | 强 | 高 | 机器之心 |
| **AI 中文** `qbitai.com` | ZH | 无 | 强 | 中 | 量子位 |

> ⚠️ 建议**不要**默认加入的「易泛滥/低质」域：内容农场与 SEO 聚合站（如各类 `*.medium.com` 个人号需谨慎、`businessinsider.com`、行情站社区版块、`baijiahao.baidu.com`、`zhihu.com` 回答区）。需要时再按类目临时加入，不进常驻白名单。

---

## 2. 应用策略：三种用法对比与推荐

### (a) 硬白名单 `include_domains`
- **优点**：结果可控、可信度高、能强制把中文垂直源（IT之家/36氪）顶上来——直接解决 PRD 根因 3「中文源覆盖不稳」。
- **缺点**：**会误杀名单外的优质源**（突发事件第一落点常是名单外地方媒体/官方公告）；维护成本高；全量 300 域名一把梭=「太泛滥」，且单查询塞太多域名会稀释相关性。

### (b) 不硬过滤 + 拿到结果后按「信任域名 + published_date」重排/加权
- **优点**：保留广度（Tavily/DDG 默认召回不变），只在排序层加权——**provider 无关**，DDG 也能用（见第 4 节）；不会误杀；零误伤地把可信源往前提。
- **缺点**：低质源仍可能进入召回（只是排名靠后）；对完全无 `publishedDate` 的结果，时效维度退化为只看信任域名。
- **打分建议（仅用现有字段）**：
  `score = w_trust * trust(hostname) + w_fresh * freshness(publishedDate) + w_rank * (1/原始排名)`
  - `trust(hostname)`：命中白名单→按可信度档位给 1.0/0.8/0.5；未命中→0.3 基线（不归零，避免误杀）。
  - `freshness`：news 路由对近 1–2 天给高分，随天数衰减；无日期→中性默认值。

### (c) 按查询类目动态选用子清单做 `include_domains`
- **优点**：**「渠道多但不泛滥」的最佳平衡**——每次只注入当前类目的 N 个（建议 8–15）相关源，而非全量 300；既定向又不稀释。复用现有 `isNewsQuery()` 思路扩展出 `classifyCategory()`（news/tech/finance/science/dev）。
- **缺点**：需要一个查询→类目分类器；分类错会限错域；仍有「子清单外优质源被排除」的残留风险。

### ✅ 推荐：(b) 为底座，(c) 为增强，弃用纯 (a)

1. **默认对所有 provider 跑 (b) 信任重排**——这是 provider 无关层，Tavily / DDG 结果归一化为 `SearchCitation[]` 后统一重排。保证「永不误杀 + 可信源靠前」。
2. **仅当 Tavily + 命中明确类目（尤其 news/finance）时，叠加 (c) 软定向**：把该类目子清单（8–15 域）作为 `include_domains`。**关键防泛滥**：用子清单而非全量、且只在高置信类目时启用；通用/模糊查询不传 `include_domains`，退回纯 (b)。
3. **绝不把 300 全量域名作为唯一硬过滤** —— 既避免误杀，又避免「太过泛滥去搜」。

「保证渠道多但不泛滥」落地公式：**每次查询 include_domains ≤ 该类目 N 个相关源（N≈10），其余靠信任重排兜底**，而非把所有类目所有域名一次性塞进去。

---

## 3. 维护方式

**推荐：代码常量（TS 模块），而非外部配置文件**——MVP 阶段信源变动低频，常量改动走 PR review 即可，且能被 server 与 sidecar 两端 `import` 复用（provider 无关）。

建议结构（新增文件，本研究不落地代码）：
```
apps/server/src/services/search/curatedSources.ts
  export type SourceCategory = "news" | "tech" | "finance" | "science" | "dev";
  export const CURATED_SOURCES: Record<SourceCategory, { domain: string; trust: number; lang: "en" | "zh" }[]>
  export const TRUST_BY_HOST: Map<string, number>   // 扁平索引，供重排 O(1) 查询
  export function domainsForCategory(cat, { max = 12, lang? }): string[]   // 供 include_domains
  export function trustScore(url: string): number     // 供 (b) 重排，hostname 容错（去 www.、取主域）
```
- **增删**：改这一个文件的数组即可；`TRUST_BY_HOST` 可由 `CURATED_SOURCES` 派生（避免两处同步）。
- **两端复用**：sidecar 侧 `direct.ts` `import` 同一模块（或镜像）；改后需 `pnpm --filter sidecar run compile:tauri:host`。
- **演进**：若后续要让运营方/用户在 UI 里增删，再迁到 `liveSearch.*` 设置或 DB（遵循 Drizzle schema + bootstrap DDL 双写规则）。MVP 不必。
- **hostname 容错**：重排时对 `url` 做 `new URL(url).hostname` → 去 `www.` → 主域归并（`m.bbc.com`/`bbc.co.uk` → `bbc`），避免子域漏匹配。

---

## 4. DuckDuckGo 兜底链路（provider 无关性确认）

- DDG lite/html 端点**无 `include_domains` 能力**，故策略 (a)/(c) 的「请求侧定向」**对 DDG 不适用**。
- 但策略 (b) 信任重排是**后置、纯基于归一化 `SearchCitation`**（`url` + 可选 `publishedDate`）的排序层——**与 provider 完全无关，对 DDG 同样生效**。这正是推荐以 (b) 为底座的核心理由：无论 Tavily 还是 DDG，召回回来后都过同一个 `trustScore + freshness` 重排器。
- **DDG 退化点**：DDG 结果常缺 `publishedDate`（见 `keyless-search-options.md`），故对 DDG 而言 (b) 的 `freshness` 维度大多落到中性默认值，**实际主要靠 `trust(hostname)` 维度**把可信域名顶上来。这对「准确/渠道质量」仍有效，对「时效」帮助有限——与 PRD「DDG 链路尽力而为」一致。
- 可选增强（不强制）：DDG 无 `include_domains`，若想软定向中文源，可在 query 里拼 `site:` 运算符（DDG 支持），但会牺牲广度，建议仅在明确类目时用，且优先靠重排而非改 query。

---

## 5. 一句话结论

以**信任重排 (b) 为 provider 无关底座**（Tavily/DDG 皆适用），**Tavily 命中明确类目时叠加按类目子清单的软 `include_domains` (c)**，**弃用全量硬白名单 (a)**；信源清单以**分类 TS 常量**维护、server/sidecar 共用，每次查询定向域名数限到单类目 ~10 个以实现「渠道多而不泛滥」。
