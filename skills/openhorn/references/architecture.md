# Architecture

> 每条断言都对着代码核过（2026-07-28）。改动结构后请同步本文件，并按 `workflows/maintain-docs.md` 检查引用完整性。

## 仓库结构

OpenHorn 是基于 Turborepo + pnpm workspace 的 monorepo。**三个应用**：

- `apps/server` — Bun + Hono API 服务器（端口见 `.env` 的 `PORT`，本机为 **3002**）
- `apps/desktop` — Tauri 2 + Vite + React 桌面端（`src-tauri/` 是 Rust 宿主，dev 端口 5173）
- `apps/sidecar` — 本机 Bun WebSocket 服务，由 Tauri 宿主 spawn

**四个共享包**：

- `packages/db` — Drizzle ORM schema（`@libsql/client` + SQLite）
- `packages/shared` — 跨应用共享类型、常量与工具函数
- `packages/ui` — 共享 React UI 组件（Radix）
- `packages/adapters` — OpenAI / Anthropic / Google 协议转换，provider 适配器模式的核心；`ToolCallingAdapter.runToolCallingTurn` 在此

> 历史上曾有 `apps/web`（Next.js）和 `packages/agent`，**均已删除**。文档里若再出现它们即为过期。

## 数据流

Agent 任务有**两条独立的执行路径**：

```
 ┌────────── 默认（远端）──────────┐
 desktop  ──HTTP/SSE──>  apps/server (Hono)  ──>  Drizzle/SQLite
                                 │
                                 ├─> provider 适配器 (packages/adapters)
                                 └─> agent runtime (Claude Agent SDK 或 通用 tool-calling)

 ┌────────── sidecar（本机，仅桌面端）──────────┐
 desktop  ──Tauri IPC──>  Rust 宿主 spawn sidecar binary
          ──WebSocket──>  apps/sidecar (127.0.0.1:随机端口 + handshake token)
                                 │
                                 └─> runClaudeAgent / runCodexAgent / runDirectAgent
```

两条路径用 `message.runtimeKind: "server" | "sidecar"` 区分。

## Agent Runtime 选择

`channelAgentCheckService.resolveAgentRuntime()` 按 channel 协议 + 端点探测结果返回 `claude_sdk` 或 `generic_tool_calling`（探测不可用时按协议兜底：`openai` → `generic_tool_calling`，否则 `claude_sdk`）。

sidecar 侧有**三个** runtime 入口，共用 `agent/system-prompt.ts` 这一份系统提示：

| 入口 | 文件 | 用途 |
|---|---|---|
| `runClaudeAgent` | `agent/claude.ts` | Claude Agent SDK（anthropic 协议）|
| `runCodexAgent` | `agent/codex.ts` | Codex CLI |
| `runDirectAgent` | `agent/direct.ts` | 通用 tool-calling（openai 协议）|

## Server (apps/server)

入口 `src/index.ts`，Hono 挂载的路由：`/auth`、`/channels`、`/conversations`、`/messages`、`/attachments`、`/credentials`、`/mcp`、`/settings`。

`src/services/` 下的服务模块（会增减，以目录为准），常用的几个：

- `channelService.ts` — provider channel CRUD + 密钥加密
- `channelAgentCheckService.ts` — agent 能力探测 + runtime 选择
- `agentSdk.ts` — Claude Agent SDK 分支
- `agentTaskService.ts` / `agentPlanBuilder.ts` / `agentTaskMessage.ts` — task / plan / run 数据模型
- `messageService.ts` — 消息读写，含 `syncSidecarMessages`（sidecar 回合落库，带 usage）
- `mcpLoader.ts` / `mcpService.ts` — MCP server 配置
- `liveCapabilities.ts` / `liveRouteClassifier.ts` / `searchService.ts` — 实时搜索路由
- `attachmentService.ts` / `attachmentParser.ts` — 附件上传与解析
- `credentialDetectionService.ts` — 凭据来源探测（key/test 端点限本地回环）

`src/agent-adapters.ts` 定义 `ProviderAdapter` / `ToolCallingAdapter` 接口。

## 数据库

单个 SQLite 文件 `data/openhorn.db`。当前的表：

`users`、`channels` + `channel_models`、`conversations`、`messages`、`workspaces`、`skills` + `skill_files`、`mcp_servers`、`attachments`、`settings`、`agent_sessions` + `agent_events`、`agent_tasks` + `agent_runs` + `agent_plan_steps` + `agent_task_events` + `agent_approval_requests` + `agent_artifacts`

每张表**两处定义**，必须同步 —— 见 `rules/project-rules.md` § 数据库同步。

## 桌面应用 (apps/desktop)

Tauri 2 + Vite + React 19，Zustand 管理状态。`src/` 下：`components/`（`app` / `auth` / `chat` / `settings` / `theme` 五组）、`hooks/`、`lib/`、`stores/`、`styles/`、`types/`。Rust 宿主在 `src-tauri/`。

macOS 走 `TitleBarStyle::Overlay`，没有原生标题栏 —— 拖拽区必须前端逐块声明，见 `references/gotchas.md#macos-窗口拖不动`。

## Sidecar (apps/sidecar)

独立 Bun WebSocket 服务，类 JSON-RPC 协议（`protocol.ts`）。提供 fs 操作（`fs.ts`）、检查点（`checkpoints.ts`）、shell 风险评估（`shell-risk.ts`）、三条 agent runtime（`agent/`）。分层安全防御详见 `rules/sidecar-security.md`。

改 `apps/sidecar/src/` 后必须重新编译，否则 Tauri 用的还是旧二进制 —— 见 `references/gotchas.md#sidecar-编译`。

## 常用命令

```bash
# 根目录
pnpm install / pnpm dev / pnpm build / pnpm typecheck / pnpm check / pnpm format

# 单个应用
pnpm dev:server / pnpm dev:desktop / pnpm --filter sidecar dev

# 类型检查与测试（各 workspace 同构）
pnpm --filter server exec tsc --noEmit
pnpm --filter server exec bun test
pnpm --filter desktop exec bun test
pnpm --filter sidecar exec bun test

# 数据库
pnpm --filter server run db:push      # drizzle-kit push
pnpm --filter server run db:studio    # drizzle studio

# Sidecar 重新编译
pnpm --filter sidecar run compile:tauri:host
```
