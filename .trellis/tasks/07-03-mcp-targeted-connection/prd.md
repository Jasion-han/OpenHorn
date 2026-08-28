# MCP 按需连接 + 斜杠指定服务器直达 + 工具上限保护

## Goal

用户 `/context7` 显式调用 MCP，模型却回答"没有 context7 工具入口"。修复 MCP 工具到达模型的最后一公里，并消除每次运行 2 分钟的启动黑洞。

## Root Cause（已实测确认，数据可信）

1. **工具超限截断**：23 个启用的 MCP 服务器共 126 个工具（实测），加内置工具后超过 OpenAI 128 个工具上限；MCP 工具按 `Object.entries(mcpServers)` 顺序追加在内置工具之后，context7 排第 21 位，其 2 个工具（resolve-library-id / query-docs）落在被截/被拒的尾部 → 模型看不到
2. **串行连接黑洞**：`connectMcpTools`（`apps/sidecar/src/agent/mcp-tools.ts`）for 循环串行连接全部服务器，每个 15s 超时；实测 23 个服务器 wall time **130s**（excel、puppeteer 各超时 15s；PostgreSQL/acemcp/web_search_mcp/ydc-server 失败）。每次 agent 运行都全量重连
3. 佐证：DB 中该会话两轮运行的 agentRun steps 只有 web_search/web_fetch；context7 单独连接实测 4-8s 成功并列出 2 个工具；`/mcp/servers` API 正常返回 23 个 enabled；sidecar 二进制含 MCP 桥接代码（7 月 1 日编译 > 6 月 29 日 MCP 提交）

## Requirements

### R1 斜杠指定 MCP 时只连该服务器（direct 命中用户意图）
- desktop：`resolveSkillMcpSlash`（DesktopChatArea）已识别出被调用的 MCP 名字，把它作为 `targetMcpServer?: string` 随 `startRun` 传入（send / retry / edit-and-resend 三处一致；retry/edit 场景从原消息 content 用 `findKnownSlashToken` 重新解析）
- `useSidecarAgentRun`：有 `targetMcpServer` 时，`mcpServers` map 只保留该服务器（名字大小写不敏感匹配）；没有时维持现有全量行为（受 R3 上限保护）
- sidecar `runAgent` 协议透传（`protocol.ts` 如需加字段则加）；Claude SDK 路径（claude.ts）如果同样接收 mcpServers，行为自然一致，确认即可

### R2 并行连接
- `connectMcpTools` 改为 `Promise.allSettled` 并行连接全部服务器，单服务器 15s 超时不变 → wall time 从 130s 降到 ~15s 封顶
- 工具聚合顺序保持确定性（按传入的 key 顺序拼接结果，不按完成顺序），失败服务器照旧 console.error 跳过

### R3 工具上限保护
- 桥接完成后若「内置工具数 + MCP 工具数」超过安全上限（OpenAI 128；取 120 留余量，常量注明），按服务器顺序截断 MCP 工具并 console.error 列出被丢弃的服务器/工具数——**不能静默**
- 若 R1 的 targetMcpServer 存在，其工具必须优先保留（排在 MCP 工具最前）

### R4 sidecar 重编译
- 改完 `apps/sidecar/src/` 必须运行 `pnpm --filter sidecar run compile:tauri:host`（项目硬规则），并验证编译产物成功生成

## Acceptance Criteria

* [ ] `/context7 查 react 文档` 发送后，执行流出现 `context7 · resolve-library-id` / `context7 · query-docs` 步骤（模型确实可见并调用）
* [ ] 带 `/mcp名` 的运行启动等待 ≤ ~20s（单服务器连接），不再全量 130s
* [ ] 不带斜杠的普通 agent 运行：并行连接后启动等待 ≤ ~20s；工具超限时日志明确列出被丢弃者
* [ ] retry 与 edit-and-resend 一条 `/context7` 消息时同样只连 context7
* [ ] sidecar 重编译成功；desktop/sidecar `bun test` 无新增失败；两端 tsc 通过
* [ ] biome 无新增

## Out of Scope

* MCP 服务器管理 UI 的改动（用户可自行在设置里禁用无用服务器）
* 工具级别的智能筛选/语义路由
* Claude SDK 路径的 MCP 行为重构（透传保持即可）
* server 端

## Technical Notes

* 涉及：`apps/desktop/src/components/chat/DesktopChatArea.tsx`、`apps/desktop/src/hooks/useSidecarAgentRun.ts`、`apps/desktop/src/lib/sidecarClient.ts`（runAgent 入参）、`apps/sidecar/src/protocol.ts`、`apps/sidecar/src/index.ts`（消息路由）、`apps/sidecar/src/agent/direct.ts`、`apps/sidecar/src/agent/mcp-tools.ts`、可能 `apps/sidecar/src/agent/claude.ts`
* DesktopChatArea/useSidecarAgentRun 有多批未提交改动（今天四个任务），最小 diff、不得回退
* 实测数据（2026-07-03）：23 servers → 126 tools / 130s serial；context7 8.4s / 2 tools
