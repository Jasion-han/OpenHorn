# 设置列表增加 Skill 功能

## Goal

在桌面端"设置"列表中新增一个 **Skill**（Agent Skills，类似 Claude Code 技能）设置项，提供完整的增删改查 + 持久化，并接入 agent runtime 让 skill 在对话中真正生效。整体照现有 **MCP 设置页**的纵向切片模式（DB → server 路由 → shared DTO → desktop 设置 UI → agent runtime 注入）来做，保持一致。

## What I already know（探查结论）

### 设置页结构（参考样板：MCP）
- 设置入口：`apps/desktop/src/components/settings/SettingsView.tsx`，左侧 180px 导航 + 右侧内容区。
- 菜单项定义在 `SettingsView.tsx:15-22` 的 `TABS` 数组（label/icon **硬编码**，不走 i18n）；内容分发在 `SettingsView.tsx:24-39` 的 `TabContent` switch。
- tab 标识枚举：`apps/desktop/src/stores/desktopShellStore.ts:5-11` 的 `DesktopSettingsTab` 联合类型。
- 当前 6 项：通用 / 渠道 / 认证来源 / Agent / MCP / 外观。

### MCP 完整链路（要 1:1 套用的部分 = 第 1–4 层）
1. **DB**：`packages/db/src/schema/index.ts:203-214`（`mcpServers` 表）+ `apps/server/src/db/bootstrap.ts:197-207`（bootstrap DDL）。两处必须同步。
2. **Shared 类型**：`packages/shared/src/types/index.ts:71-79`（`MCPServer` DTO，不含 userId）。
3. **Server**：路由 `apps/server/src/routes/mcp.ts`（6 端点，全程 `requireUser`）+ service `apps/server/src/services/mcpService.ts`（CRUD + `toItem`/`parseConfig`，查询全部 `and(eq(id), eq(userId))` 做用户隔离）+ 测试 `mcpService.test.ts`；注册在 `apps/server/src/index.ts:10,57`。
4. **Desktop UI**：组件 `apps/desktop/src/components/settings/McpSettings.tsx`（本地 useState，无 store）+ API 客户端 `apps/desktop/src/lib/serverApi.ts:136-154,450-470`（`mcp` 命名空间）。

### MCP runtime 注入（第 5 层，**不能照抄**，语义不同）
- 路径 A（主，sidecar）：`useSidecarAgentRun.ts:155-192` 拉取 enabled MCP → reshape → `runAgent({ mcpServers })` → `sidecarClient.ts` 透传 → `sidecar/src/index.ts` → `claude.ts`（SDK 原生 `mcpServers` 选项）/ `direct.ts` + `mcp-tools.ts`（手搓 `connectMcpTools` 把远端 tools 包成 `AgentTool`）。
- 路径 B（server 内置 agent）：`agentService.ts` + `agentSdk.ts` + `mcpLoader.ts`（`loadEnabledMcpServersForUser`）。
- **关键差异**：MCP = 连外部 server 暴露 tools；Agent Skill = 一段带元数据的指令/资源包，注入方式更接近"追加 system prompt"或"SDK 原生 skill 机制 / 渐进式加载"，需重新设计 → 见 `research/skill-injection.md`。

### i18n
- MCP 文案是硬编码中文，未进 `apps/desktop/src/lib/i18n/agent.ts` 字典；该文件注释明确 tool 名标签（Bash/MCP/Skill）保持英文不进字典。→ Skill 文案同样硬编码即可，i18n 层基本不动。

## Decisions（已与用户确认 2026-06-30）
1. **Skill 内容形态** = 完整 SKILL.md（YAML frontmatter `name`/`description` + markdown 正文）+ 可上传 bundled 资源文件。对齐 Anthropic 官方规范（name ≤64、description ≤1024、正文建议 <500 行）。
2. **注入方式** = 渐进式加载（progressive disclosure）。采用「物化到文件系统 + Level-1 元数据注入 system prompt + 模型用现有 Read/Bash 按需读取」的方式实现——这正是 Claude Code 原生机制，且双 runtime 已有文件工具，天然统一（无需各写一套 `load_skill` 工具）。
3. **runtime 范围** = sidecar（路径 A）+ server 内置 agent（路径 B）都接。

## 选定技术方案（核心）
- **存储**：DB 存 skill 元数据 + 文件内容（SKILL.md 正文 + bundled 文件）。文件存储形态（独立 `skill_files` 表 vs JSON blob，文本/二进制 base64）待 workspace 探查后定，倾向 `skill_files` 表（path + content + 可选 base64 标志）。
- **物化**：每次 agent run 前，把该用户 enabled 的 skill 物化到运行时 workspace 的 `<cwd>/.claude/skills/<name>/`（写 SKILL.md + 资源文件），受现有 workspace 路径校验约束。
- **注入**：在两条 runtime 共用的 `finalSystemPrompt` 拼接处（`claude.ts:213` / `direct.ts:657`）插入一段 Level-1 元数据：每个 enabled skill 的 `name + description + SKILL.md 相对路径`，并提示模型"相关时先 Read 对应 SKILL.md"。server 内置 agent 同理。
- **待 `research/sidecar-workspace.md` 确认**：sidecar / server 内置 agent 的 workspace/cwd 生命周期与路径校验，决定物化落点与清理时机；以及 server 内置 agent 是否具备文件工作区（若无，该路径渐进式加载需降级，见 Open Questions）。

## Open Questions
- （已全部解决）

## 待实现确认（Derivable，实现期决定，非用户问题）
- bundled 文件在 DB 的存储形态：倾向新增 `skill_files` 表（`skillId / path / content / isBinary(base64)`），文本直存、二进制 base64。
- 新 Skill UI 文案：按 CLAUDE.md「Chinese UI text 必须走 `i18n/agent.ts` 字典」执行（注意 MCP 现状是硬编码，属既有违规；新代码按规则走字典，不照抄 MCP 的硬编码）。

## Research References
- [`research/skill-injection.md`](research/skill-injection.md) — Agent Skill 结构 / SDK 原生机制 / 三种注入方式对比；渐进式加载依赖文件系统 + 模型 Read。
- [`research/sidecar-workspace.md`](research/sidecar-workspace.md) — sidecar 可行（cwd=workspaceRoot，有 Read/Bash，`extra` 注入位空闲）；server 路径 cwd 为共享仓库根、需改造；SDK 版本 sidecar 0.2.71 / server latest。

## Requirements（evolving）
- 设置列表新增 "Skill" 项（store 枚举 + TABS + switch 三处挂载）。
- Skill CRUD：列表展示、新增、编辑、删除、启用/停用开关。
- Skill 内容：可编辑 SKILL.md（name/description frontmatter + 正文），可上传/管理 bundled 资源文件。
- 数据持久化到 server DB（含文件内容），按用户隔离。
- 运行前把 enabled skill 物化到运行时 workspace 的 `.claude/skills/<name>/`。
- system prompt 注入 enabled skill 的 Level-1 元数据；模型按需读取 SKILL.md/资源 = 渐进式加载。
- sidecar 路径 A + server 内置 agent 路径 B 都生效。

## Acceptance Criteria（evolving）
- [ ] 设置页出现 "Skill" 菜单项，点击进入 Skill 管理页。
- [ ] 可新增/编辑/删除 skill、上传资源文件、切换启用状态，数据刷新后仍在（持久化）。
- [ ] 启用某 skill 后，在桌面端 sidecar 对话中：system prompt 含该 skill 元数据，且相关请求下模型能读到 SKILL.md/资源并按其指令工作（可观测验证）。
- [ ] server 内置 agent 路径同样生效（或在路径 B 无文件系统时按降级方案生效）。
- [ ] server `skillService` 单测通过；DB 两处定义同步；typecheck / biome green；改 sidecar 后已 recompile。

## Definition of Done
- DB 两处定义同步（schema + bootstrap DDL）。
- server skillService 单测（照 mcpService.test.ts）。
- typecheck（web/server/desktop）+ `pnpm check` green。
- 改 sidecar 后 `pnpm --filter sidecar run compile:tauri:host` 重新编译。
- 桌面端实测：增删改 + 对话生效。

## Out of Scope（explicit）
- **server 内置 agent 路径 B**（本期只做 sidecar 路径 A；path B 留作后续子任务，需先补 per-用户工作目录）。
- Skill 市场/分享、版本管理。
- SDK 原生 skill 机制（settingSources/skills 选项）——本期靠自管物化 + Read，不依赖 SDK 加载。

## 追加范围：多平台 skill 导入（用户要求，对标 MCP 发现）
扫描本机各平台已安装的 SKILL.md 技能并导入（research：`research/skill-discovery-locations.md`）。
- **扫描来源**（真实存在、按 canonical realpath 去重、cc-switch 优先）：`~/.cc-switch/skills/`、`~/.claude/skills/` + 插件（`installed_plugins.json` 选活跃版本）、`~/.codex/skills/`（排除 `.system/`）+ `~/.agents/skills/`、`~/.gemini/skills/`。Cursor 无 SKILL.md 概念，不扫（不捏造来源）。codex/gemini 多为软链到 cc-switch → realpath 去重必须。
- **3 个 Tauri 命令**：`skills_discover`（轻量列 name/description/path/clients）、`skill_read_dir(path)`（导入时读完整 content+files，二进制 base64）、`skill_pick_folder`（手动选文件夹）。
- **前端**：`tauriBridge` 加包装；`SkillSettings` 加「导入」按钮 + 对话框（复刻 MCP 导入：扫描→勾选→平台标签→已存在徽章→导入所选）；i18n 补文案。
- Rust 改动需 `cargo check` + 重新构建 Tauri（与 sidecar recompile 无关）。

## Technical Approach（定稿）
**存储**：DB 新增 `skills`（id/userId/name/description/content[SKILL.md 正文]/isEnabled/时间戳）+ `skill_files`（skillId/path/content/isBinary）两表；schema 与 bootstrap DDL 两处同步。
**Server**：`skillService`（CRUD + 文件子资源）+ `routes/skills.ts`（照 mcp.ts）+ `loadEnabledSkillsForUser`（返回 enabled skill 及其文件）+ 单测。
**Desktop UI**：`SkillSettings.tsx`（列表/增删改/启用开关 + SKILL.md 编辑 + 资源文件上传管理）；`serverApi.ts` 加 `skill` 命名空间；设置导航三处挂载（store 枚举 / TABS / switch）；文案走 i18n 字典。
**传参**：`useSidecarAgentRun` 拉 enabled skills(+文件) → `runAgent({ skills })`；`sidecarClient` + `protocol.ts` AgentRunParamsSchema 加 `skills` 字段。
**Sidecar 物化 + 注入**：run 前宿主代码把 enabled skill 写到 `<cwd>/.claude/skills/<name>/SKILL.md` + 资源文件（先清上一轮残留），`ensureGitignore` 忽略；`buildAgentSystemPrompt` 的 `extra` 注入 Level-1 索引（name+description+路径+「相关时先 Read」）；claude.ts + direct.ts 两路共用。模型用现有 Read/Bash 按需读取 = 渐进式加载。

## Decision (ADR-lite)
**Context**：用户要"完整 SKILL.md + 资源文件 + 渐进式加载 + 双 runtime"。research 表明渐进式加载本质依赖文件系统 + 模型 Read；SDK 原生 skill 仅 Claude 且需大改；server 路径 cwd 是共享仓库根无法安全物化。
**Decision**：采用「物化到 workspace `.claude/skills/` + system prompt 注入 Level-1 索引 + 模型 Read 按需加载」复刻 Claude Code 真实机制，双 runtime 统一（都已有 Read/Bash）；本期只覆盖 sidecar 路径 A，server 路径 B 出于隔离/污染风险延后。
**Consequences**：(+) 双 runtime 行为一致、资源文件天然支持、token 省。(−) 写入用户持久 workspace 有侵入性（需 gitignore + 清理）；direct.ts 路径校验较弱；server 路径暂不支持，体验在 server 对话下缺失，需后续补 per-会话工作目录。

## 第一性原理打磨（实现后按对标 Claude Code/Codex skill 复盘）
对照顶级 Agent 的 skill 机制重审注入层，做了以下提升：
1. **跨厂商工具名修正（真 bug）**：渐进式加载靠"模型读 SKILL.md"，但 Claude SDK 的读取工具叫 `Read`，direct(OpenAI/通用) runtime 叫 `read_file`。原先单一注入串硬写 "Read"，导致非 Anthropic 模型被指示调用不存在的工具。改为 `buildSkillsPromptSection(materialized, readTool)` 按 runtime 传真实工具名（claude.ts→`Read`，direct.ts→`read_file`），index.ts 只物化并传 `MaterializedSkill[]`，由各 runtime 自建提示。
2. **提示词对标顶级 Agent**：Level-1 块重写为——description 即触发器、SKILL.md 指令对该任务具权威性（优先于默认做法）、资源/脚本按需读取、多个命中选最具体、**绝不向用户声明在用 skill**。措辞模型无关，OpenAI/Gemini/Claude 都能稳定遵循。
3. **description 单行归一**：description 同时是触发器和 YAML frontmatter 值，折叠换行/多空白为单行，避免破坏 SKILL.md 的 YAML 与 Level-1 块。
4. **UI 引导**：描述框提示改为"模型仅凭这句决定是否启用，写清做什么+何时用"并给范例；正文框给 SKILL.md 结构占位模板（<500 行、超长拆资源文件）。

## 第二轮加固（对抗式独立审查后，只采纳真问题）
派独立 reviewer 对抗式复核注入链路，按"真问题 vs 刻意"筛选，落地 3 项、明确不改 3 项：
1. **并发 run 物化竞态（真 bug，已修）**：cwd 是 sidecar 单例共享，原 `materializeSkills` 把 `.openhorn/skills` 整个 wipe 重建，并发 run 会删掉另一个 run 正在读的 SKILL.md → 渐进式加载 Level-2 静默断裂。改为**按 run 隔离 `.openhorn/skills/<runId>/`**（对齐 checkpoints 的 `snapshots/<runId>` 约定），各 run 只写自己的目录、互不删；停用/删除的 skill 因"新 run 只写当前 enabled 到新目录"天然不出现。`materializeSkills(cwd, skills, runId)` + `MaterializedSkill.skillDir`。
2. **提示词补资源目录（Level-3 健壮性，已修）**：原只给 SKILL.md 路径，模型要反推目录拼资源相对路径，弱模型不稳。每条 skill 增加 `Folder:` 行 + 说明"资源文件与 SKILL.md 同目录"。
3. **路径穿越硬断言（安全，已修）**：原 `normalizeRelPath` 漏 裸`..`/结尾`/..`，靠 writeFile 恰好失败兜底。新增 `assertInsideSkillDir`（`path.resolve` + `startsWith(root+sep)`）做权威防御。
- **明确不改**：(a) direct.ts `read_file` 缺工作区边界——既有、独立于 skill 的安全差异，skill 不扩大攻击面，属另一任务；(b) SDK resume 是否每轮重注入 systemPrompt——低置信度**实测项**（与 MCP 同款传参），上线随 MCP 一起验；(c) 强制 description≤1024/content 非空——边际收益，不做。
- 测试：`skills.test.ts` 重写为验证 per-run 隔离 + Folder 注入 + 穿越拦截，5 pass；sidecar tsc 0；二进制已重编译。

## Implementation Plan（分 PR / 子任务）
- **PR1 数据层**：DB 两表（schema + bootstrap DDL）+ shared `Skill` DTO + server `skillService`/`routes/skills.ts`/注册 + 单测。
- **PR2 设置 UI**：`serverApi.skill` + `SkillSettings.tsx`（CRUD + 文件上传）+ 导航三处挂载 + i18n 文案。可独立验证增删改持久化。
- **PR3 运行时生效**：`loadEnabledSkillsForUser` + 传参管线（useSidecarAgentRun/sidecarClient/protocol）+ sidecar 物化逻辑 + gitignore + `extra` 注入（claude.ts/direct.ts）+ recompile。端到端验证对话生效。

## Technical Notes
- 第 1–4 层（DB→路由→DTO→设置 UI）≈ 1:1 套用 MCP 模板，文件对照清单见探查结论（本文件 What I already know）。
- 第 5 层 runtime 注入需按 Skill 语义重新设计，参考 `research/skill-injection.md`。
- 关键约束（CLAUDE.md）：DB 两处同步、shared 包按 workspace 名导入、sidecar 改完要 recompile、desktop 测试 matcher 受限、`git add` 指定路径。

## Research References
- [`research/skill-injection.md`](research/skill-injection.md) — Agent Skill 注入机制（结构 / SDK 支持 / 注入方式对比 / 推荐）— 生成中。
