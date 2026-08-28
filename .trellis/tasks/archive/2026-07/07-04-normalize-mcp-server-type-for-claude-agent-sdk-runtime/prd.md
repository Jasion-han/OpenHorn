# 修复：Claude（anthropic）运行时下 MCP 服务器全部注册失败

## 问题

用户在 agent 模式选 anthropic 协议模型（如 claude-sonnet-4-6）时，所有 npx/stdio 类 MCP 服务器（context7、Playwright、chrome-devtools 等）不可用，模型答复"工具列表里没有 context7 MCP 工具"。同一会话换 openai 协议模型（gpt-5.5）则一切正常。

## 根因（已确认）

- `apps/desktop/src/hooks/useSidecarAgentRun.ts` 构建 MCP 映射：`map[server.name] = { type: server.type, ...(server.config || {}) }`，DB 里 npx 类服务器 `type` 列是 `"npx"`，config 内无 type 字段 → 最终传给 sidecar 的是 `{ type: "npx", command: "npx", args: [...] }`。
- anthropic 协议走 sidecar 的 Claude Agent SDK 运行时（`apps/sidecar/src/agent/claude.ts` 直接把 `input.mcpServers` 透传给 SDK `query` options）。本地 SDK 0.2.71 的 `McpStdioServerConfig` 要求 `type?: 'stdio'`（`McpServerConfig = stdio | sse | http | sdk`），`"npx"` 非法 → 服务器不被注册。
- openai 协议走 direct 运行时（`apps/sidecar/src/agent/mcp-tools.ts` `buildTransport`）：先看 `url`/`http`/`sse`，否则只要有 `command` 就按 stdio 连，忽略声明的 type → 所以 openai 下一直正常。

## 修复方案

在 desktop 构建映射处做类型归一化（改 `useSidecarAgentRun.ts`，不改 sidecar，无需重编译）：

- config 或 server 声明为 `sse` / `http`、或有 `url` → 保留/归一为对应的 `sse`/`http`；
- 有 `command` → `type: "stdio"`（覆盖 `npx`/`uvx` 等 DB 类型值）；
- 归一化逻辑抽成可独立测试的纯函数（可放入现有 hooks 目录，或与 slashToken/sidecarRunOwnership 同级的小模块）。

注意 spread 顺序：config 自带 `type`（如 ydc-server 的 `{"type":"sse"}`）目前会覆盖 server.type，归一化后此行为需保持等价正确。

约束：

- 不改 server 端、不改 sidecar（direct 运行时对归一化后的格式天然兼容：`type:"stdio"` 无 url、有 command → 仍走 stdio 分支）。
- 正常 openai 协议路径行为不得变化。
- desktop 测试矩阵限制（bun test，仅 toBe/toBeDefined/toEqual/toHaveLength/toMatchObject）。

## 验收

- 单测覆盖：npx/uvx/自定义 command 类 → stdio；config 内声明 sse/http 或有 url → 保留 sse/http；env/args/headers 等字段原样保留；无 command 无 url 的残缺配置不崩溃。
- `pnpm --filter desktop exec bun test` 全绿；`pnpm --filter desktop exec tsc --noEmit` 通过。
- 手工回归：claude-sonnet-4-6 会话里 `/context7 ...`，模型能列出并调用 mcp__context7__* 工具；gpt-5.5 会话 context7 仍正常。
