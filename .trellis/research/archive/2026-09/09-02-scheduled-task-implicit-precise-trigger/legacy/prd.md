# 定时任务隐式准时触发，并复用真实聊天执行管线

## 问题（现状）

1. 服务端调度器到点只「建会话 + 写一条 run」，并立刻把 run 标成 `completed`，什么都没执行。
2. 桌面端 `backgroundTaskRunner` 每 15s 轮询新 run，用一条裸 `sidecar.runAgent` 跑：
   - 没有 systemPrompt / MCP / Skills / workspace / tavily / 会话历史，与聊天不一致；
   - 事件只拼 `execution_event.content`，工具过程、usage、agentRun 全丢，也不进 chatStore，打开会话看不到流式过程；
   - 持久化走 `POST /messages` 两次，不是聊天用的 `sync-sidecar`；
   - 触发延迟 0~15s，run 状态与真实执行脱钩。

## 目标

到点（误差 ≤ 2s）隐式执行：不跳转、不打断当前对话；执行方式与用户在该会话里手动发一条消息**完全一致**（同一套 sidecar 输入组装、同一套事件映射到 chatStore、同一套 `sync-sidecar` 持久化）；run 状态真实反映 pending → running → completed/failed，并带结果摘要。

## 方案

### Server
- 调度器到点：建会话 + run(`pending`)，**不再**标 completed；`nextRunAt` 查询排除 NULL，避免退化成 60s 轮询。
- 新增 `PATCH /scheduled-tasks/runs/:runId/claim`（pending→running，幂等）与 `PATCH /scheduled-tasks/runs/:runId/complete`（写 status/result/error）。
- 手动「立即执行」路由不动（仍走 composer 真实发送）。

### Desktop
- 从 `useSidecarAgentRun` 抽出可复用的纯函数到 `lib/sidecarRunSupport.ts`：技能解析、MCP 解析、事件→chatStore 映射；hook 改为调用它们（行为不变）。
- `chatStore` 新增 `seedConversationMessages`：把草稿消息塞进非当前会话的缓存（当前会话则直接 append），让后台运行也能在打开会话时看到流式过程。
- 重写 `backgroundTaskRunner`：
  - 精准定时：按 `tasks[].nextRunAt` 最早值 setTimeout（+1.5s 落地），到点拉 runs，未见到新 pending 时 2s 重试 5 次；60s 兜底轮询；任务变更时重新武装。
  - 拾取 pending run → claim → 按聊天同款管线执行 → `sync-sidecar` 持久化 → complete run（result = 回复摘要）→ 刷新 runs/tasks/conversations → 可选 toast。
  - 超过 15 分钟的 pending run 视为「客户端离线错过」，直接标 failed，不补跑。
  - sidecar 未就绪时最多等 60s，否则标 failed。
- 权限：无人值守，固定 `full-access`（沿用 447a685 的决定）。

## 不做
- 不改手动立即执行的交互；不加系统级通知（当前项目没有该能力）；不改 UI 布局。

## 验收
- 建一个 1 分钟后的任务：到点 ≤2s 内会话里出现用户消息+助手回复（含工具步骤），run 状态经历 running→completed 且有结果摘要；当前对话不被打断。
- 主聊天路径回归：手动发一条 agent 消息，流式/工具面板/持久化正常。
- `pnpm typecheck`、desktop/server bun test 通过。
