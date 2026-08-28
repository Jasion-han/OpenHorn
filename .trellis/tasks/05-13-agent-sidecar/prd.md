# 桌面端清除服务端 Agent 路径 — 强制走 sidecar 本地运行

## Goal

桌面端 Agent 模式当前有两条执行路径：服务端 Agent SDK（通过 SSE 流调用 Claude Agent SDK 子进程）和 sidecar 本地运行（直接 fetch API）。服务端路径在桌面端环境下会 hang，且用户已明确只做桌面端不做 web 端。需要清除桌面端中所有服务端 Agent 路径的代码，Agent 模式统一走 sidecar。

## Requirements

### 必须做

1. **Agent 模式强制走 sidecar** — 去掉 `useSidecarRuntime` 条件判断，Agent 模式下直接走 sidecar 路径
2. **移除"本地运行"开关按钮** — 底部工具栏不再显示 toggle，桌面端 Agent 始终走 sidecar
3. **移除 `sidecarRuntimeEnabled` 状态** — 不再需要这个开关状态
4. **移除发送消息的服务端 Agent 路径** — `DesktopChatArea.tsx` 中 `consumeStreamingResponse` 和 SSE 流消费相关代码
5. **移除重试消息的服务端路径** — `handleRetryMessage` 中 `regenerateMessage` 分支
6. **移除编辑消息的服务端路径** — `handleSaveEdit` 中 `editUserMessage` 分支
7. **移除 `runtimeKind` 判断** — 所有消息都是 sidecar 产生的，不需要区分
8. **清理 `agentTaskStream.ts`** — 服务端 Agent Task 事件流处理（如果桌面端不再使用）
9. **清理 `serverApi.ts` 中不再需要的 Agent 端点** — `agentTasks.*` 系列 API（保留 `messages.syncSidecar`）
10. **保留 `chatAdapter.ts` 中的 `loadMessages`** — 消息列表仍需从服务端加载

### 不能做

- 不能影响 `apps/web/` 的任何代码
- 不能影响 `apps/server/` 的任何代码
- 不能影响非 Agent 模式（普通聊天模式仍走服务端 stream）
- 保留 sidecar 连接管理、workspace 选择等现有逻辑
- 保留 `serverApi.ts` 中普通聊天相关的 API（`messages.stream`, `messages.regenerate`, `messages.edit`）— 普通聊天模式仍需要

## Acceptance Criteria

- [ ] 桌面端 Agent 模式发消息自动走 sidecar，不再出现 "Working" hang 住
- [ ] 底部工具栏无"本地运行"按钮
- [ ] 重试/编辑 Agent 消息走 sidecar 路径
- [ ] 普通聊天模式（非 Agent）不受影响，仍走服务端
- [ ] TypeScript 类型检查通过 (`pnpm --filter desktop exec tsc --noEmit`)
- [ ] Biome lint 通过 (`pnpm check`)

## Definition of Done

- TypeScript 无类型错误
- Biome lint/format 通过
- 手动测试 Agent 模式发消息、重试、编辑均正常

## Technical Approach

### 关键修改文件

1. **`DesktopChatArea.tsx`** — 主要改动
   - 移除 `sidecarRuntimeEnabled` 状态和自动同步 effect
   - 移除 `useSidecarRuntime` 条件，Agent 模式直接走 sidecar
   - 移除 `consumeStreamingResponse` 函数
   - 简化 `handleRetryMessage`：Agent 消息只走 sidecar
   - 简化 `handleSaveEdit`：Agent 消息只走 sidecar
   - 移除 `forceCliOAuthSidecar` 逻辑（不再需要，因为全部走 sidecar）
   - 移除 `runtimeKind` 设置（或统一设为 "sidecar"）

2. **`DesktopComposer.tsx`** — 移除"本地运行"按钮
   - 移除 `sidecarRuntimeEnabled` 和 `onToggleSidecarRuntime` props
   - 移除按钮 UI

3. **`agentTaskStream.ts`** — 可能整体移除或简化
   - 检查是否还有其他地方引用

4. **`serverApi.ts`** — 清理 `agentTasks` 系列 API
   - 保留 `messages.*` 系列（普通聊天仍需要）
   - 保留 `messages.syncSidecar`

### 注意事项

- 普通聊天模式（`mode !== "agent"`）仍需要走服务端 SSE 流，不能删除 `sendMessage`/`regenerateMessage`/`editUserMessage` 在非 Agent 场景下的调用
- `consumeStreamingResponse` 如果只用于 Agent 模式可以删除；如果普通聊天也用，需要保留
- Agent 模式下 sidecar 不可用时，应该显示错误提示而不是静默 fallback 到服务端

## Out of Scope

- Web 端 (`apps/web/`) 代码
- 服务端 (`apps/server/`) 代码
- sidecar 本身的功能改进（多轮记忆、text/final_text 分离等）
- 服务端 Agent SDK hang 问题的修复

## Technical Notes

- 当前未提交的改动只有 `DesktopChatArea.tsx` 的 sidecar auto-enable effect（一行 diff）
- `consumeStreamingResponse` 定义在 DesktopChatArea.tsx 第 911-933 行
- `chatAdapter.ts` 中的 `sendMessage`/`regenerateMessage`/`editUserMessage` 同时被 Agent 和普通聊天使用
- `sse.ts` 中的 `readSseStream`/`readTypedSseStream` 是通用工具，可能被普通聊天使用，不能删
