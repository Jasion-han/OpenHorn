# Research: How Claude Code / Codex load Skills (disk vs. message transport) — and how OpenHorn should align

- **Query**: 顶级 AI 编码工具（Claude Code、Codex CLI）内部到底怎么把 Agent Skills 加载给模型运行？它们是不是"只靠磁盘、绝不把 skill 文件内容序列化进一条消息/请求发给另一个进程"？OpenHorn 把 60KB skill 内容塞进 WebSocket agent.run 消息发给 sidecar，差异和风险在哪，该怎么对齐？
- **Scope**: mixed（external = Claude Agent SDK / Codex / Anthropic Managed Agents 架构文档；internal = OpenHorn server→desktop→sidecar skill 管线）
- **Date**: 2026-06-30
- **Builds on**: `.trellis/tasks/06-30-skill/research/skill-injection.md`、`skill-discovery-locations.md`（不重复其中的 frontmatter 规则、三级 progressive disclosure、磁盘路径清单）

---

## TL;DR（直接回答核心问题）

**成立。** 所有顶级工具都遵循同一条架构铁律：**skill 文件内容始终待在"运行 agent 的那个进程能直接访问的磁盘"上，模型用 Read/Bash 工具按需从磁盘读；任何跨进程/网络通道里只流动"路径 + 元数据（name/description）"，从不把 skill 正文 + bundled 文件序列化进一条消息一次性发过去。**

- **Claude Code / Claude Agent SDK**：纯文件系统发现（`~/.claude/skills/`、`<cwd>/.claude/skills/`、插件目录）。SDK 官方明确"不提供编程式注册 API，skill 必须作为磁盘 artifact 存在"。它从磁盘读，启动只把 name+description 注入 context，正文触发时才 Read。**没有"把 skill 内容塞进 query 参数"这种 API。**
- **Codex CLI / Gemini CLI**：同样纯文件系统（`~/.agents/skills`、`~/.codex/skills`、`~/.gemini/skills`），磁盘读取，不传内容。
- **连 Anthropic 自己的托管 Managed Agents（self-hosted sandbox）也这么做**：agent loop 在 Anthropic 侧跑，但 skill 不是通过消息塞给它——**worker 在执行工具前把 skill"下载物化"到本地 `{workdir}/skills/<name>/`，agent 再从那个磁盘目录读**（见下文证据）。这正是"本地进程能直接访问磁盘 → 只传引用、内容落盘"的范式。

**OpenHorn 现状**：sidecar 端其实**已经是对的一半**——它把 skill 物化到磁盘 `.openhorn/skills/<runId>/`，再用 Level-1 system prompt 注入路径让模型按需 Read（`apps/sidecar/src/agent/skills.ts`，完全复刻 Claude Code 语义）。**问题只在"内容怎么到达 sidecar"这一段**：内容先从 server DB → 桌面 HTTP 拉全量（正文+所有 bundled 文件，可达 60KB+）→ 再整包塞进 WebSocket `agent.run` 消息发给 sidecar。这一段是**所有顶级工具都没有的环节**——它们的 skill 文件本来就在磁盘上，根本不存在"把内容搬运到运行进程"这一步。

**对齐方向（最小改动）**：让桌面端用 Tauri 文件接口先把启用的 skill 物化到一个**固定的本地目录**（如 `~/.openhorn/skills/` 或每用户缓存目录），sidecar 直接从磁盘读，`agent.run` 消息里**只传 skill 根目录路径 + 启用清单（name/description/dir）**，不传文件内容——彻底消除大消息。这把 OpenHorn 从"DB-backed 内容搬运"拉回到顶级工具的"disk-backed 引用"范式。

---

## 1. 证据：Claude Code / Claude Agent SDK 是纯磁盘、零内容传输

来源：`skill-injection.md` §2（已抓取 `code.claude.com/docs/en/agent-sdk/skills`），加上本次 `claude-api` skill 文档交叉印证。

关键事实链：

1. **官方原话**（SDK 文档）：
   > "Unlike subagents (which can be defined programmatically), Skills **must be created as filesystem artifacts**. The SDK **does not provide a programmatic API for registering Skills**."

   → 没有"把 skill 内容当参数传进 `query()`"的入口。能传的只有 `settingSources`（从哪些磁盘来源发现）、`skills`（启用哪些已发现的名字）、`plugins`（额外的磁盘路径）。**全是"指针/过滤器"，没有一个是"内容载荷"。**

2. **发现机制全是磁盘路径**（`skill-discovery-locations.md` §1）：`~/.claude/skills/<name>/SKILL.md`、`<cwd>/.claude/skills/`、插件 cache 目录。SDK 进程的 `cwd` 下放着 `.claude/skills/`，它直接 stat/read 这些文件。

3. **加载是"读磁盘"，不是"收消息"**（三级 progressive disclosure，`skill-injection.md` §1）：
   - Level 1 启动即载入——只把每个 skill 的 name+description 进 system prompt（这是**唯一常驻 context** 的部分，几百字节）。
   - Level 2 触发时——模型用 **Read/Bash 工具自己读磁盘**上的整份 SKILL.md。
   - Level 3 按需——正文引用的 bundled 文件，模型需要时才读/执行。

   整套机制的前提就是"一个真实文件系统 + 模型能用工具读它"。**模型获取 skill 正文的途径是工具调用读磁盘，不是 prompt 里塞好的内容。**

4. **交叉印证（本次 `claude-api` skill / `shared/agent-design.md`）**：
   > "**Skills** — Each skill is a folder with a `SKILL.md`. The skill's description sits in context by default; Claude reads the full file when the task calls for it."

   再次确认：默认进 context 的只有 description；正文是"当任务需要时才读文件"。

**结论**：Claude Code/SDK 从架构上就**不存在**"把 skill 文件内容序列化后通过一条消息/请求传给另一个进程"这种做法。它依赖的是"skill 文件本来就在 agent 运行进程能直接访问的磁盘上"。

---

## 2. 证据：连 Anthropic 托管 Managed Agents 也是"下载到磁盘再读"，而不是"消息塞内容"

来源：本次 `claude-api` skill，`shared/managed-agents-self-hosted-sandboxes.md` + `shared/managed-agents-tools.md`。这是**对 OpenHorn 最贴切的对照**，因为 OpenHorn sidecar ≈ 一个本地 worker。

- Managed Agents 里，skill 挂在 **agent 定义**上，引用方式是 `skill_id`（`{type:"anthropic", skill_id:"xlsx"}` 或 `{type:"custom", skill_id:"skill_abc123", version}`）——**传的是 ID/引用，不是内容**。
- 在 `cloud` 环境，Anthropic 把 skill 准备进容器文件系统；agent 在容器里按需读。
- 在 **self-hosted sandbox**（agent loop 在 Anthropic 侧，工具执行在你自己的 worker 进程——**这正是 OpenHorn sidecar 的拓扑**）官方原话：
  > "Skills attached to the agent are **downloaded into `{workdir}/skills/<name>/` before tool calls begin** (`AgentToolContext` handles this when given `client` and `session_id`). Downloaded skill files are marked executable automatically…"

  → 即便是 Anthropic 自己的远程编排，skill 内容也不是通过"一条 agent 消息"塞给 worker 的；而是 worker **先把它们物化到本地 workdir 的磁盘目录**，工具开始前就位，然后 agent 从磁盘读。**和 OpenHorn sidecar 物化到 `.openhorn/skills/` 是同一个动作**——区别只在"内容从哪来、谁来落盘"。

- Messages API 的 "Agent Skills" 路径（`container={"skills":[...]}` + code-execution，`shared/tool-use-concepts.md`）同样：skill 在**执行容器的文件系统**里，用 skill_id 选择，**不进 messages 数组**。

**结论**：Anthropic 全线产品（CLI、SDK、托管 Agents、Messages API）无一例外——**skill 内容落在 agent 进程可达的磁盘上，通道里只传引用/ID/路径**。把内容序列化进运行消息，是它们刻意避免的反模式。

---

## 3. 证据：Codex / Gemini 同样是纯文件系统

来源：`skill-discovery-locations.md` §2-3（已抓取 `developers.openai.com/codex/skills`、`geminicli.com/docs/cli/skills`）。

- **Codex CLI**：REPO/USER 分层全是磁盘路径——`$CWD/.agents/skills`、`~/.agents/skills/`、（历史/实验）`~/.codex/skills/**/SKILL.md`。`~/.codex/config.toml` 里 `[[skills.config]]` 用 `path = ".../SKILL.md"` 来 disable——**连"禁用"都是按磁盘路径操作的**。bundled 默认 skill 在 `~/.codex/skills/.system/`。
- **Gemini CLI**：`~/.gemini/skills/`、`~/.agents/skills/` 别名、workspace `.gemini/skills/`。同 SKILL.md 格式，磁盘发现。
- 三家共享 `~/.agents/skills/` 这个"跨工具互通磁盘路径"——进一步说明整个生态把 skill 当**磁盘上的开放标准文件**，而不是"某个 API 的内容载荷"。

**结论**：Codex/Gemini 同样不传内容，纯磁盘读取。

---

## 4. OpenHorn 现状 vs. 顶级工具：差异精确定位

### OpenHorn 当前管线（代码事实）

| 阶段 | 文件:行 | 做了什么 |
|---|---|---|
| 存储 | `apps/server/src/services/skillLoader.ts:25-48` | `loadEnabledSkillsForUser` 从 DB 读出每个 enabled skill 的 `content`(正文) + 所有 `skillFiles`(bundled 文件 content，文本/base64) |
| 桌面拉取 | `apps/desktop/src/hooks/useSidecarAgentRun.ts:235-272` | run 前 `api.skill.listEnabled()` HTTP 拉全量，reshape 成 `skills` 数组 |
| WS 传输 | `apps/desktop/src/lib/sidecarClient.ts:90-91,347,368` | 把 `skills`(含正文+所有文件内容) 放进 run 参数 |
| 协议 | `apps/sidecar/src/protocol.ts:79-89,107` | `SkillPartSchema { name, description, content, files:[{path,content,isBinary}] }`，`AgentRunParamsSchema.skills` |
| sidecar 落盘 | `apps/sidecar/src/index.ts:386,447-454` + `apps/sidecar/src/agent/skills.ts:120-180` | `materializeSkills(cwd, skills, runId)` 把内容写到 `<cwd>/.openhorn/skills/<runId>/<name>/SKILL.md`(+bundled) |
| 注入 | `apps/sidecar/src/agent/skills.ts:198-223` | `buildSkillsPromptSection` 只注入 name+description+SKILL.md 路径+Folder 路径，模型按需 Read |

### 与顶级工具对照

| 维度 | Claude Code / SDK / Codex / Managed-Agents worker | OpenHorn 现状 |
|---|---|---|
| skill 内容的"真源位置" | **磁盘**（`~/.claude/skills` 等，本来就在那） | **server DB**（`skills`/`skillFiles` 表） |
| 内容如何到达 agent 运行进程 | **不需要搬运**——进程直接 stat/read 磁盘 | **每次 run** 全量 HTTP 拉 → 整包塞进 WS 消息搬给 sidecar |
| 跨进程通道里传什么 | 仅引用/路径/ID/启用名单（≤ 几 KB） | **整份正文 + 所有 bundled 文件内容**（可达 60KB+） |
| Level-1 注入 | name+description 进 context | name+description 进 context（**一致 ✓**） |
| Level-2/3 加载 | 模型 Read 磁盘（**一致 ✓**） | 模型 Read 磁盘（**一致 ✓**） |
| 物化到磁盘 | worker 落盘到 workdir（self-hosted 同款动作） | sidecar 落盘到 `.openhorn/skills/<runId>`（**一致 ✓**） |

**一句话**：OpenHorn 的"sidecar 落盘 + system prompt 只注入元数据 + 模型按需读"这套**完全对齐 Claude Code**（甚至比很多自建实现更正确）。唯一偏离顶级工具的，是**多了一段"把 DB 里的内容通过 HTTP + WebSocket 搬运到 sidecar"**——而顶级工具因为内容本就在磁盘，根本没有这一段。

---

## 5. 现状这段"大消息搬运"的具体风险

1. **大消息 / 单条 WS 帧膨胀**：每次 `agent.run` 都把所有 enabled skill 的全文 + 所有 bundled 文件（文本原样、二进制 base64 ≈ +33%）塞进一条 JSON 消息。60KB+ 只是当前；skill 越多/越大、bundled 资源越多，单帧越大，逼近 WS/Zod 解析的实际上限。
2. **每次 run 重复传输**：内容在 DB↔桌面↔sidecar 之间**每跑一次 agent 就重传一遍**，即使 skill 没变。顶级工具是"磁盘上放一次，读 N 次"。
3. **双重序列化开销**：DB 行 → JSON(HTTP) → reshape → JSON(WS) → Zod 解析 → 再写回磁盘文件。内容被序列化/反序列化多趟，纯属为"搬运"付的税。
4. **二进制走 base64 进 JSON**：`SkillFilePart.isBinary` 用 base64 塞进文本 JSON（`skills.ts:164-165` 再解回），体积 +33% 且全程占内存。
5. **per-run 目录放大磁盘写**：`materializeSkills` 每个 runId 一个新目录（`skills-${Date.now()}-...`），并发安全是对的，但叠加"每次都重写全量内容"=每次 run 都做一遍全量磁盘写，而内容其实没变。
6. **真源在 DB 而非磁盘**：与生态"skill = 磁盘上的 SKILL.md 文件夹"开放标准（agentskills.io）背离，未来想 import/复用本机已装 skill（见 `skill-discovery-locations.md` 的 scan 设想）时，两套真源（DB vs 磁盘）需要额外同步。

---

## 6. 建议的对齐方向（对照 Claude Code 的最小架构调整）

> 本节是研究结论性的"方向"，不是要求；具体落地由主 agent 决定。核心原则：**让 sidecar 像 Claude Code 一样"从磁盘读 skill"，通道里只传引用。**

**目标范式**：内容物化由"靠近磁盘的一侧"做一次，`agent.run` 只传"skill 根目录 + 启用清单"。

可行的两种切法（按贴近顶级工具程度排序）：

- **方案 A（最贴近 Claude Code / self-hosted worker）：桌面端用 Tauri 文件接口预物化到固定本地目录。**
  - 桌面端拉到 enabled skills 后，用 Tauri 的文件写入接口把它们物化到一个**稳定的本地目录**（如 `~/.openhorn/skills/<name>/SKILL.md`(+bundled)，或每用户缓存目录）——只在"skill 变更"时重写，不必每 run。
  - `agent.run` 消息里把 `skills:[{name,description,content,files}]` 换成 `skillsDir: string`(根目录) + `skills:[{name,description,dir}]`(仅元数据 + 相对目录名)，**不含文件内容**。
  - sidecar 不再 `materializeSkills` 写内容，而是直接把这个磁盘目录当 Level-3 资源；`buildSkillsPromptSection` 注入的 SKILL.md/Folder 路径指向该目录。等价于 Claude Code 的 `<cwd>/.claude/skills/` 被 SDK 直接读。
  - 收益：彻底消除大消息；内容"物化一次读多次"；与"skill = 磁盘文件夹"开放标准一致。
  - 注意：sidecar 的 workspace 路径校验/symlink 防护（见 `sidecar-security.md`、`sidecar-workspace.md`）要允许这个固定 skill 目录被读取（只读即可）。

- **方案 B（折中，改动更小）：内容真源仍在 server，但桌面"按需物化、按引用传"。**
  - 维持 DB 存储，但桌面端把内容写到固定本地目录后，agent.run 只传目录路径 + 元数据；sidecar 读磁盘。和 A 的差别只是"谁是内容真源"（B 仍是 DB，磁盘是缓存）。
  - 适合不想动 DB 真源、只想干掉大消息的场景。

**两种方案共同点（这才是关键对齐）**：`agent.run` 消息从此**只传引用，不传内容**——和 Claude Code（settingSources/skills 名单）、Codex（config 里的 path）、Managed Agents（skill_id + worker 落盘）完全同构。

**保持不变的（已经对的，别动）**：`buildSkillsPromptSection` 的 Level-1 元数据注入 + 模型按需 Read 的 progressive disclosure（`skills.ts:198-223`）。这部分本来就是 Claude Code 语义的正确复刻，model-agnostic（按 runtime 传入真实 read 工具名 `Read`/`read_file`），不需要改。

---

## Files Found（内部，本研究新增引用）

| File Path | Description |
|---|---|
| `apps/sidecar/src/agent/skills.ts:120-223` | `materializeSkills`(落盘) + `buildSkillsPromptSection`(Level-1 注入)；已对齐 Claude Code progressive disclosure，是"对的一半" |
| `apps/sidecar/src/protocol.ts:79-107` | `SkillFilePartSchema`/`SkillPartSchema`/`AgentRunParamsSchema.skills`——当前把 `content`+`files[].content` 塞进 run 参数的协议处 |
| `apps/sidecar/src/index.ts:386,447-454,492,530` | run 参数解构 + `materializeSkills(cwd, skills, runId)` 调用 + 透传给 claude/direct runtime |
| `apps/server/src/services/skillLoader.ts:25-48` | `loadEnabledSkillsForUser`——内容真源（DB `skills`+`skillFiles` 表）读取处 |
| `apps/desktop/src/hooks/useSidecarAgentRun.ts:235-272` | 桌面端 run 前拉 enabled skills 并随 run 传入 |
| `apps/desktop/src/lib/sidecarClient.ts:90-91,347,368` | run 参数里 `skills`(含全量内容) 透传处——大消息源头 |

## External References（架构事实来源）

- [Agent Skills in the SDK](https://code.claude.com/docs/en/agent-sdk/skills) — "Skills must be created as filesystem artifacts. The SDK does not provide a programmatic API for registering Skills."；`settingSources`/`skills`/`plugins` 全是磁盘指针，非内容载荷
- [Codex Skills](https://developers.openai.com/codex/skills) — REPO/USER 磁盘分层；`[[skills.config]]` 按 `path` disable
- [Gemini CLI Skills](https://geminicli.com/docs/cli/skills/) — `~/.gemini/skills`、`~/.agents/skills` 磁盘发现
- Anthropic Managed Agents — Self-Hosted Sandboxes（来自本仓库可用的 `claude-api` skill，`shared/managed-agents-self-hosted-sandboxes.md`）：**"Skills attached to the agent are downloaded into `{workdir}/skills/<name>/` before tool calls begin"** —— 托管编排也"落盘后读"，不走消息塞内容；对照 OpenHorn sidecar 拓扑最贴切
- Anthropic Agent Design（`claude-api` skill `shared/agent-design.md`）— "Each skill is a folder with a SKILL.md. The skill's description sits in context by default; Claude reads the full file when the task calls for it."

## Caveats / Not Found

- 本环境**未能联网**（exa/firecrawl/web_search 工具在本会话不可用）。上述 Claude Code/Codex/Gemini 的磁盘机制结论，依据是本仓库既有研究（`skill-injection.md`/`skill-discovery-locations.md`，其中已抓取过官方文档原文）+ 本次 `claude-api` skill 内嵌的 Anthropic 官方架构文档交叉印证，未做新的实时抓取。若要逐字复核 SDK 最新选项，建议联网后重抓 `code.claude.com/docs/en/agent-sdk/skills`。
- "60KB+" 来自任务描述给定的现状量级，未在本仓库实测某具体 skill 集合的实际消息字节数；风险结论为定性。
- 方案 A 涉及 sidecar workspace 安全校验对固定 skill 目录的放行细节，未在本研究展开——落地时需对照 `.trellis/tasks/06-30-skill/research/sidecar-workspace.md` 与 `skills/openhorn/rules/sidecar-security.md` 确认只读放行不破坏 8 层防护。
- Claude Agent SDK 的具体版本是否已支持 `settingSources`/`skills` 选项，未在本仓库 `package.json` 核对（沿用 `skill-injection.md` 的同一 caveat）。若改走 SDK 原生 skill 路线需先确认版本。
