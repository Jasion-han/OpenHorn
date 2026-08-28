# Research: Sidecar / Server agent 的 workspace 模型与 skill 物化可行性

- **Query**: 把 Agent Skills 物化到运行时 `<cwd>/.claude/skills/<name>/` 让模型 Read 按需读取（渐进式加载），在 sidecar 与 server 内置 agent 两条路径是否可行
- **Date**: 2026-06-30
- **Scope**: internal（OpenHorn 代码）

## A. Sidecar（apps/sidecar）— 可行，主战场

- `agent.run` 入参 **无** workspace/cwd 字段（`protocol.ts:79-94`）。cwd 来自连接级状态 `state.workspaceRoot`，由独立的 `workspace.setCurrent`（`protocol.ts:42-44`）设置，经 `canonicalizeWorkspaceRoot`（`workspace.ts:74-85`，realpath + deny-list）。
- 解构：`index.ts:370` `const cwd = state.workspaceRoot || os.homedir()`；透传三条路径 `index.ts:454,471,508`。
- **Claude 路径**（`claude.ts`）：传了 `cwd: input.cwd`（`:232`）；**未传 `settingSources`**（`:230-280`）；tools 白名单含 `Read/Grep/Glob/Write/Edit/Bash`（`:225-228`），渐进式所需工具齐全。文件边界由 `canUseTool → checkSdkFsToolPath(.., input.cwd)`（`:268`）强制——skill 目录必须在 cwd 内（`.claude/skills` 满足）。
- **OpenAI direct 路径**（`direct.ts`）：文件工具根 = `cwd`（`buildTools(input.cwd,..)` `:614`，`makeAgentTool(..,cwd,..)` `:433-518`）；路径校验更弱，直接 `path.resolve(cwd, filePath)`（read `:138` / write `:170` / edit `:186` / bash `:118`），可被 `..` 逃逸，但读 cwd 内 skill 无碍。
- **workspace 生命周期**：持久、用户选定目录，**非每次 run 临时目录**。桌面端 localStorage `openhorn.sidecar.workspaceRoot`（`sidecarStore.ts:65`），默认回退 `/tmp`（`:180-183`）。run 结束**不清理**。唯一运行时产物是 checkpoints `<root>/.openhorn/snapshots/<runId>`（`checkpoints.ts:38-40`，含 `ensureGitignore`）。
- **system prompt 注入位**：`buildAgentSystemPrompt` 有空闲 `extra?` 参数（`system-prompt.ts:26`，末尾追加 `:87-89`），claude.ts/direct.ts 调用时**都没传**，可直接用。finalSystemPrompt 拼接数组：`claude.ts:213-222`、`direct.ts:657-663`。

### Sidecar 落地方案
1. run 前由**宿主代码**（index.ts agent.run 分支或 claude/direct 入口）把该用户 enabled skill 写到 `<cwd>/.claude/skills/<name>/SKILL.md` + 资源文件（**不是让模型写**）。
2. `ensureGitignore` 把 `.claude/skills`（或整个 `.claude`）加进忽略，避免污染用户仓库（仿 checkpoints）。
3. `buildAgentSystemPrompt({ cwd, permissionMode, extra })` 的 `extra` 注入 Level-1 索引：每个 skill 的 name + description + SKILL.md 相对路径 + "相关时先 Read"。
4. 模型用 Read/Bash 按需读 = 渐进式加载。
5. 更新/清理：物化前清掉上一轮写入的 skill 目录（按 name diff），避免残留已删除/停用的 skill。

### Sidecar 风险
- 写进用户**持久项目目录**有侵入性（默认 `/tmp`）；需 gitignore + 写入/更新/清理策略；run 结束不自动清。
- SDK 未传 settingSources → 不触发原生 skill 加载，frontmatter 不被 SDK 自动用，全靠 prompt 约定（符合预期）。

## B. Server 内置 agent（apps/server）— 当前不可直接落地

- 有 cwd：`agentService.ts:360` `resolveAgentWorkingDirectory()`，透传 SDK（`:426` claude_sdk / `:457` generic）。
- 但该 cwd = `resolveAgentWorkingDirectory()`（`agentWorkspace.ts:17-40`）从 `process.cwd()` 上溯按 `.git/package.json/README` 打分选出的 **server 自身仓库根**——全局共享、**无 per-user/会话隔离**、**无请求级注入口**。
- SDK 用 preset 工具 `{ type:"preset", preset:"claude_code" }`（`agentSdk.ts:73`），有 Read/Bash，技术上能读文件；**未传 settingSources**（`:66-86`）。
- server system prompt 来自 `mergeSystemPromptParts(globalSystemPrompt, RESPONSE_STYLE_GUARDRAILS, liveSystemContext)`（`agentService.ts:354-359`），**不经过** `buildAgentSystemPrompt`，无 `extra` 位（但可往 merge 里加一段 skill 文本）。

### Server 落地选项
- **(a) 真渐进式**：给 agentService 新增 per-user/会话持久工作目录并作 cwd，物化 `.claude/skills` —— 需要新 plumbing + 存储/清理设计。
- **(b) 降级（非渐进式）**：把 enabled skill 的 SKILL.md 正文直接并入 `mergeSystemPromptParts`（`agentService.ts:354`）一次性塞进 system prompt —— 简单，失去渐进式 + 占 token + bundled 文件无法生效。

### Server 风险
- 往共享部署目录写 skill → 跨用户污染、可能命中只读目录。
- server 的 SDK 版本 `"latest"` 未锁（`server/package.json:18`），行为可能漂移。

## C. SDK 版本
- sidecar：`@anthropic-ai/claude-agent-sdk` `0.2.71`（钉死，`apps/sidecar/package.json:20`）。
- server：`@anthropic-ai/claude-agent-sdk` `latest`（浮动，`apps/server/package.json:18`）。

## 结论
- 优先在 **sidecar 两条路径**实现物化 + `extra` 索引注入 + 模型 Read 的真渐进式加载。
- **server 路径**要么补 per-会话工作目录（plumbing 较大），要么走 system-prompt 全量注入的非渐进式降级；建议作为单独子任务或降级实现。

## Files（落地点参照）
| File | 用途 |
|---|---|
| `apps/sidecar/src/index.ts:370,454,471,508` | cwd 解构 + 透传；物化时机插入点 |
| `apps/sidecar/src/agent/claude.ts:213-222,225-228,232,268` | finalSystemPrompt 拼接 / tools / cwd / 边界校验 |
| `apps/sidecar/src/agent/direct.ts:138-186,433-518,614,657-663` | direct 文件工具 / buildTools / finalSystemPrompt |
| `apps/sidecar/src/agent/system-prompt.ts:26,87-89` | `extra` 注入位 |
| `apps/sidecar/src/checkpoints.ts:38-40` | ensureGitignore 样板 |
| `apps/sidecar/src/workspace.ts:74-85` | canonicalize/边界 |
| `apps/server/src/services/agentService.ts:354-360,426,457` | server cwd + system prompt merge |
| `apps/server/src/services/agentWorkspace.ts:17-40` | resolveAgentWorkingDirectory（共享仓库根） |
| `apps/server/src/services/agentSdk.ts:66-86` | preset 工具 / cwd |
