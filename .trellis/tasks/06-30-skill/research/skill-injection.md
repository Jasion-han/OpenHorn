# Research: Agent Skills 的定义、存储与注入到 LLM 运行时

- **Query**: 在自建 agent 运行时（同时支持 Anthropic Claude Agent SDK 与 OpenAI direct runtime）里，"Agent Skills"（类似 Claude Code skills）应该如何定义、存储、注入并生效；为 OpenHorn 新增 Skill 管理功能给出 MVP 建议
- **Scope**: mixed（external = Anthropic 官方文档 / Claude Agent SDK；internal = OpenHorn sidecar 现有 MCP + system-prompt 注入模式）
- **Date**: 2026-06-30

## 1. Claude / Anthropic "Agent Skills" 概念

来源：`https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview`、`.../best-practices`。

### Skill 标准结构

- 一个 Skill 就是一个**目录**，目录里至少有一个 `SKILL.md` 文件。目录名 = skill 名 = 在 Claude Code 中可直接 `/skill-name` 触发。
- `SKILL.md` 由两部分组成：
  1. **YAML frontmatter**（`---` 包裹）—— 元数据，告诉模型「这个 skill 是什么、什么时候用」。
  2. **Markdown 正文** —— 真正的过程性指令（workflow、最佳实践、代码片段）。
- 可选 **bundled 资源**：同目录下的其它文件（如 `FORMS.md`、`scripts/*.py`、模板），由正文用相对链接引用（"For advanced form filling, see [FORMS.md](FORMS.md)"）。

### Frontmatter 字段（官方验证规则）

| 字段 | 必填 | 规则 |
|---|---|---|
| `name` | 是 | 最多 64 字符；仅小写字母/数字/连字符；无 XML 标签；无保留字。通常等于目录名 |
| `description` | 是 | 最多 1024 字符；非空；无 XML 标签。**必须同时写清"做什么"和"何时用"**，因为模型靠它决定是否触发 |
| `allowed-tools` | 否 | 仅 Claude Code **CLI** 生效；通过 SDK 使用时**被忽略**（见第 2 节） |

最小示例：

```yaml
---
name: pdf-processing
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
---
```

正文建议 **< 500 行**；超出就拆成多个文件，用渐进式加载引用。

### Progressive disclosure（渐进式加载）—— 三级

这是 Skill 的核心机制，基于"文件系统 + bash 可读"：

- **Level 1 — Metadata（启动即加载，常驻）**：只把每个 skill 的 `name` + `description` 注入 system prompt。因此可以装很多 skill 而几乎不占 context —— 模型只"知道存在 + 何时用"。
- **Level 2 — Instructions（触发时加载）**：当用户请求匹配某 skill 的 description，Claude 才通过 bash/Read **读取整份 `SKILL.md` 正文**进入 context。
- **Level 3 — Resources & code（按需加载）**：正文里引用的 bundled 文件 / 脚本，只在真正需要时才被读取或执行。

关键点：渐进式加载**依赖一个真实文件系统 + 模型能用 bash/Read 工具自行读文件**。这正是 Claude Code 沙箱 VM 的前提。

## 2. Claude Agent SDK 是否原生支持 Skills

来源：`https://code.claude.com/docs/en/agent-sdk/skills`（`@anthropic-ai/claude-agent-sdk`）。

**原生支持，但完全基于文件系统，没有"用代码注册 skill"的编程 API。** 官方原话：
> "Unlike subagents (which can be defined programmatically), Skills must be created as filesystem artifacts. The SDK does not provide a programmatic API for registering Skills."

机制要点（TypeScript 字段名）：

1. **磁盘 artifacts**：skill 必须以 `SKILL.md` 文件存在于约定目录：
   - 项目级：`<cwd>/.claude/skills/<name>/SKILL.md`（以及 `<cwd>` 各父目录直到 repo root 的 `.claude/skills/`）
   - 用户级：`~/.claude/skills/<name>/SKILL.md`
   - 插件级：随已安装 Claude Code 插件捆绑
2. **`settingSources`（TS）/ `setting_sources`（Py）**：决定从哪些来源加载文件系统设置。要让 skill 被发现，必须包含 `'user'` 和/或 `'project'`。默认 `query()` 会加载 user + project，所以上面这些目录默认可用。若显式设置了 `settingSources`，必须保留 `'user'`/`'project'`，否则 skill 不被发现。
3. **`skills` 选项**：发现后默认全部启用。取值：
   - 省略 → 启用所有已发现 skill，并自动把 `Skill` 工具加进 `allowedTools`（与 CLI 行为一致）
   - `"all"` → 启用全部
   - `["pdf", "docx"]` → 只启用指定名（名字匹配 frontmatter `name` 或目录名；插件用 `plugin:skill`）
   - `[]` → 全部禁用
   - 注意：`skills` 是**上下文过滤器，不是沙箱**。未列出的 skill 对模型隐藏、Skill 工具会拒绝，但文件仍在磁盘上、仍可被 Read/Bash 读到。
4. **`plugins` 选项**：可从指定路径加载 skill（替代标准目录约定）。
5. **工具限制**：`SKILL.md` 里的 `allowed-tools` frontmatter **在 SDK 路径下不生效**，必须用 `query()` 顶层的 `allowedTools` 控制。

TS 示例：

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Help me process this PDF document",
  options: {
    cwd: "/path/to/project",          // 含 .claude/skills/
    settingSources: ["user", "project"], // 必须，否则不发现 skill
    skills: "all",                    // 或 ["pdf","docx"]
    allowedTools: ["Read", "Write", "Bash", "Skill"],
  },
})) { /* ... */ }
```

> OpenHorn 现状对照：`apps/sidecar/src/agent/claude.ts` 当前**没有**传 `settingSources`，且 `permissionMode: "bypassPermissions"`、自管 `tools` 白名单（`Read/Grep/Glob/Write/Edit/Bash` + 可选 web）。要走 SDK 原生 skill，需要新增 `settingSources: ["user","project"]`（或 `plugins`）+ `skills` 选项 + 把 `Skill` 加进 tools，并在磁盘上物化 `SKILL.md`。

### "Skills in the API"（Messages API）

官方还有一条"Skills in the API"路径（通过 Messages API 的 container / code-execution 工具加载 skill），但属于 Anthropic 托管容器方案，与 OpenHorn 自建 sidecar/OpenAI 路径不匹配，且 ZDR 不适用。MVP 不建议走这条。（文档页 `skills-in-the-api` 当前 markdown 端点 404，仅在导航中可见，未取到正文。）

## 3. 注入方式对比

| 方案 | 机制 | 模型/Runtime 适用 | 优点 | 缺点 |
|---|---|---|---|---|
| **(A) 全量拼 system prompt** | 把所有 enabled skill 的完整正文始终拼进 system prompt | Claude + OpenAI 都行（模型无关） | 实现最简单；与 OpenHorn 现有 `buildAgentSystemPrompt` 的 `extra`/拼接模式天然契合；无需文件系统；无需新工具 | 占 token（skill 多/长时明显）；无渐进式加载；无"按需触发"语义 |
| **(B) 渐进式加载 / progressive disclosure** | system prompt 只放 `name`+`description` 列表；模型通过一个 `load_skill`/`Skill` 工具按需拉全文 | Claude + OpenAI 都行（需自建工具） | 最接近 Claude Code 真实语义；token 省；可装很多 skill | 实现复杂：要自建工具、把 skill 全文（或文件）放到模型可达的地方、处理多轮加载；OpenAI direct runtime 要新增一个 AgentTool |
| **(C) Claude Agent SDK 原生 skill** | 物化 `SKILL.md` 到 `.claude/skills/`，传 `settingSources`+`skills` | **仅 Claude 路径** | 完全官方语义、SDK 自管发现/加载/触发；零 prompt 工程 | 只覆盖 Anthropic 一条 runtime；必须落盘到 workspace 文件系统；与 OpenAI direct runtime 不通用，导致两条 runtime 行为分叉 |

补充：
- (A) 与 OpenHorn 的注入点高度一致——两条 runtime 都已在 `finalSystemPrompt = [buildAgentSystemPrompt(...), input.systemPrompt, intentResult.context].join("\n\n")` 处拼接（见 `claude.ts:213-222`、`direct.ts:657-663`）。Skill 文本只需作为又一段拼进去。
- (B) 的"工具"在 OpenAI 路径对应 `direct.ts` 的 `buildTools()` 里再加一个 `load_skill` AgentTool；Claude 路径要么自建同名工具，要么直接用方案 (C)。两路要保持一致会变复杂。
- (C) 与现有 MCP 的 per-protocol 思路冲突点在于：MCP 是**两条 runtime 各自注入**（Claude 用 SDK 原生 `mcpServers`，OpenAI 用 `connectMcpTools` 手搓），而 skill 若走 (C) 则 OpenAI 侧没有对等实现。

## 4. 对 OpenHorn 的建议（MVP）

**推荐：方案 (A) 全量拼接 system prompt 作为 MVP；架构上预留 (B) 的升级位。**

理由（结合现有代码事实）：

1. **天然契合现有注入点**：两条 runtime 已经在同一处把多段 prompt `join("\n\n")`（`claude.ts:213` / `direct.ts:657`）。只需在该数组里再插一段 `buildSkillsPrompt(enabledSkills)`，**一处改动覆盖 Claude + OpenAI + Codex 三个 runtime**，与 `buildAgentSystemPrompt` 单一真源的设计理念一致（`system-prompt.ts` 文件头注释明确"a rule added here applies everywhere"）。
2. **模型无关，立刻双路可用**：不依赖文件系统、不依赖 SDK 版本、不需要新工具。OpenAI direct runtime（`pi-agent-core`）和 Claude SDK 都能即时生效。而方案 (C) 只能覆盖 Claude，必然造成两 runtime 行为分叉。
3. **复刻 MCP 的存储与传参管线即可**，改动面可控且与既有模式对称：
   - **DB**：新增 `skills` 表，照搬 `mcp_servers` 形状——`id / userId / name / description / content / isEnabled / createdAt / updatedAt`。**两处都要改**：Drizzle schema `packages/db/src/schema/index.ts`（参照 `mcpServers` 定义，schema/index.ts:203）+ bootstrap DDL `apps/server/src/db/bootstrap.ts`（参照 mcp_servers 建表，bootstrap.ts:197）。
   - **Server**：新增 `apps/server/src/routes/skills.ts`（CRUD，照搬 `routes/mcp.ts` 的 `GET/POST/PUT/DELETE /servers`）+ `services/skillService.ts` + 一个 `loadEnabledSkillsForUser`（照搬 `mcpLoader.ts`）。
   - **Sidecar 协议**：在 `AgentRunParamsSchema`（`apps/sidecar/src/protocol.ts:78`）和 `index.ts` 解构（`index.ts:371-400`）里加 `skills?: Array<{name; description; content}>`，与 `mcpServers` 同级。
   - **Desktop**：照搬 `useSidecarAgentRun.ts:159-176` 拉取 MCP 的逻辑，新增拉取 enabled skills 并随 `runAgent` 传入（`sidecarClient.ts:86,337,357` 同样加字段）；设置页新增 `SkillSettings.tsx`，参照 `McpSettings.tsx`。中文 UI 文案必须走 `apps/desktop/src/lib/i18n/agent.ts` 字典。
   - **Runtime 注入**：在 `claude.ts` 与 `direct.ts` 的 `finalSystemPrompt` 数组里插入 skill 段。
4. **存储 skill 内容**：MVP 直接把 `SKILL.md` 正文存进 DB 的 `content` 字段（用户在设置页编辑 frontmatter + 正文，或拆成 name/description/body 三栏）。无需落盘，避开 sidecar 的 workspace 路径校验与文件系统副作用。
5. **升级路径**：当 skill 数量/长度变大、token 成为问题时，再演进到 (B)：system prompt 只拼 `name+description` 清单，新增一个 `load_skill(name)` 工具（OpenAI 侧加进 `direct.ts:buildTools`，Claude 侧加进 SDK tools 白名单），按需返回 `content`。DB/CRUD/传参管线在 MVP 已就绪，升级只动注入层。
6. **不建议 MVP 用 (C)**：虽然最"原生"，但只覆盖 Claude，且要求把 `SKILL.md` 落到 `<cwd>/.claude/skills/`、改 `settingSources`/`permissionMode`、把 `Skill` 工具加进白名单，OpenAI 侧还得另搞一套——与"双 runtime 对称、复刻 MCP 模式"的目标背离。可作为未来"Claude 专属增强"选项。

### 建议的 frontmatter 字段对齐 Anthropic 规范

即便走方案 (A)，建议让用户填的字段与官方一致，便于未来迁移到 (B)/(C)：
- `name`：≤64 字符，小写字母/数字/连字符
- `description`：≤1024 字符，写清"做什么 + 何时用"
- `content`（正文）：建议 < 500 行

## Files Found（内部，注入与存储管线参照）

| File Path | Description |
|---|---|
| `apps/sidecar/src/agent/system-prompt.ts` | 单一真源 system prompt（`buildAgentSystemPrompt`），三 runtime 共用，含 `extra` 追加位 |
| `apps/sidecar/src/agent/claude.ts:213-222` | Claude SDK 路径 `finalSystemPrompt` 拼接处；`mcpServers` 原生传参（`:242-244`）；tools 白名单（`:225`） |
| `apps/sidecar/src/agent/direct.ts:657-663` | OpenAI direct 路径 `finalSystemPrompt` 拼接处；MCP 手搓桥接（`:623-628`）；`buildTools`（`:433`） |
| `apps/sidecar/src/agent/mcp-tools.ts` | OpenAI 路径把 MCP server 转成 AgentTool 的参照实现（方案 B 的 `load_skill` 工具可仿此） |
| `apps/sidecar/src/protocol.ts:78` | `AgentRunParamsSchema`——新增 `skills` 字段处（`mcpServers` 同级缺失，靠 index.ts 解构透传） |
| `apps/sidecar/src/index.ts:371-400,465-515` | 运行参数解构 + 分发到 `runClaudeAgent`/`runDirectAgent`，`mcpServers` 透传样板 |
| `apps/server/src/routes/mcp.ts` | CRUD 路由样板（`/servers` GET/POST/PUT/DELETE/test） |
| `apps/server/src/services/mcpLoader.ts` | `loadEnabledMcpServersForUser` + 行→config 映射样板 |
| `packages/db/src/schema/index.ts:203` | `mcpServers` Drizzle 表定义（skill 表参照） |
| `apps/server/src/db/bootstrap.ts:197` | `mcp_servers` bootstrap DDL（skill 表 DDL 参照；两处必须同步） |
| `apps/desktop/src/hooks/useSidecarAgentRun.ts:159-192` | Desktop 拉 enabled MCP 并随 run 传入的样板 |
| `apps/desktop/src/lib/sidecarClient.ts:86,337,357` | run 参数里 `mcpServers` 字段透传样板 |
| `apps/desktop/src/components/settings/McpSettings.tsx` | MCP 设置页 UI 样板（SkillSettings 参照） |
| `apps/desktop/src/lib/i18n/agent.ts` | 中文 UI 文案字典（新文案必须走这里） |

## External References

- [Agent Skills overview](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview) — SKILL.md 结构、三级 progressive disclosure、frontmatter `name`/`description`
- [Agent Skills best practices](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices) — frontmatter 校验规则（name ≤64 / description ≤1024）、正文 <500 行、metadata 预加载机制
- [Agent Skills in the SDK](https://code.claude.com/docs/en/agent-sdk/skills) — `@anthropic-ai/claude-agent-sdk` 的 `settingSources` / `skills` / `plugins` 选项；"SDK 不提供编程式注册 API，必须落盘 SKILL.md"；`allowed-tools` frontmatter 在 SDK 下无效
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) — SDK `query()` / `ClaudeAgentOptions` 总览
- [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — 架构博客（未抓取正文，供深读）

## Caveats / Not Found

- "Skills in the API"（Messages API + container/code-execution）官方页 markdown 端点当前 404，仅取到导航标题；如需走托管容器方案需另行查证。该路径与 OpenHorn 自建 runtime 不匹配，MVP 不涉及。
- `@anthropic-ai/claude-agent-sdk` 的**具体版本号与 `skills`/`settingSources` 选项的可用性未在本仓库 `package.json` 中核对**——若要走方案 (C)，需先确认 sidecar 依赖的 SDK 版本是否已包含这些选项。
- 本研究未实测把 skill 文本拼进 system prompt 后的 token 实际占用，仅作定性判断。
