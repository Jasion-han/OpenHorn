# Codex CLI 子进程运行模式

## Goal

让 OpenHorn 桌面端支持通过 Codex CLI 子进程执行 Agent 任务，使 Codex CLI OAuth 渠道真正可用。Codex CLI OAuth token 只能通过 ChatGPT Backend API 工作，无法调用标准 OpenAI API，因此必须通过 Codex CLI 自身来执行。

## Research References

- [`research/codex-cli-jsonrpc.md`](research/codex-cli-jsonrpc.md) — Codex CLI app-server JSON-RPC 协议详解

## Requirements

- Codex CLI 渠道在桌面端 Agent 模式下能正确发送消息并流式接收回复
- 通过 sidecar 路径执行（与 Claude Code sidecar 一致）
- 事件流与现有 UI 兼容（复用 `chatStore.applyStreamEvent`）
- 支持所有 Codex 可用模型（gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2）
- Codex CLI 不可用时给出明确错误提示
- 不需要传 API Key — Codex CLI 使用自身已登录的 ChatGPT session

## Acceptance Criteria

- [ ] Codex CLI 渠道在桌面端 Agent 模式下能正常对话
- [ ] 流式文本输出实时显示
- [ ] 工具调用事件正确展示（tool_start / tool_result）
- [ ] Codex CLI 未安装时显示友好错误
- [ ] auto-title 在 Codex CLI 对话后正常工作

## Definition of Done

- Tests added/updated (unit/integration where appropriate)
- Lint / typecheck / CI green
- 桌面端 UI 手动验证通过

## Technical Approach

### 方案：Sidecar 路径（与 Claude Code 一致）

**新增文件：**
- `apps/sidecar/src/agent/codex.ts` — spawn `codex app-server --listen stdio://`，JSONL 通信，事件转换

**修改文件：**
- `apps/sidecar/src/index.ts` — `agent.run` RPC 接受 protocol 参数，路由到 claude 或 codex
- `apps/sidecar/src/protocol.ts` — 扩展 AgentRunRequest schema 添加 protocol 字段
- `apps/desktop/src/hooks/useSidecarAgentRun.ts` — 传 protocol 给 sidecar
- `apps/server/src/services/genericAgentTypes.ts` — 新增 `"codex_cli"` AgentCapabilityMode
- `apps/server/src/services/channelAgentCheckService.ts` — Codex CLI OAuth 渠道返回 `codex_cli` mode

**事件映射（Codex → OpenHorn）：**
- `item/agentMessage/delta` → `text`（流式文本）
- `item/started` (type: function_call_output) → `tool_start`
- `item/completed` (type: function_call_output) → `tool_result`
- `turn/completed` → `done`
- error → `error`

**Codex CLI 生命周期：**
1. sidecar 收到 `agent.run` + protocol="openai" + isCliOAuth
2. spawn `codex app-server --listen stdio://`
3. 发送 `initialize` → 收到 response → 发送 `initialized`
4. 等待 Codex 使用已有 `~/.codex/auth.json` 自动认证
5. 发送 `thread/start` + prompt
6. 流式接收事件 → 转换为 AgentEvent → 发送到桌面端
7. `turn/completed` → 清理子进程

## Decision (ADR-lite)

**Context:** Codex CLI OAuth token 无法调用标准 OpenAI API，需要通过 Codex CLI 子进程执行。
**Decision:** 方案 A — sidecar 路径。在 sidecar 中新增 Codex agent，与 Claude Code 共用 WebSocket 通信层和前端事件处理。
**Consequences:** sidecar 需要重新编译（`compile:tauri:host`），但架构一致性好，前端改动最小。

## Out of Scope (explicit)

- Web 端支持（仅桌面端）
- Codex CLI 的审批流程（设置 approvalPolicy: "never"）
- Codex CLI 的 checkpoint/rollback
- 对 Codex CLI 安装/更新的管理
- 通过 Codex CLI 渠道发普通 Chat 消息（仅 Agent 模式）

## Technical Notes

- Codex CLI 二进制：`/opt/homebrew/bin/codex`（macOS），需要 `which codex` 检测
- 启动命令：`codex app-server --listen stdio://`
- 通信格式：JSONL over stdin/stdout，JSON-RPC 2.0（省略 `"jsonrpc":"2.0"` header）
- Codex 使用 `~/.codex/auth.json` 自动认证，不需要传 API Key
- `AgentCapabilityMode` 新增 `"codex_cli"`
- 参考实现：`apps/sidecar/src/agent/claude.ts`
- 编译命令：`pnpm --filter sidecar run compile:tauri:host`
