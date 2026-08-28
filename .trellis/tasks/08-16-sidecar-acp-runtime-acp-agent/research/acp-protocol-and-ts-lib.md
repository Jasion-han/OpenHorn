# Research: ACP（Agent Client Protocol）协议规范与 TypeScript 库现状

- **Query**: ACP 协议生命周期 / session-update 事件清单 / 反向调用与 capabilities / token 上报 / TS 库现状 / 版本稳定性
- **Scope**: external（官方 spec 文档 + GitHub + npm registry 实测）
- **Date**: 2026-08-16
- **主要来源**:
  - 官方文档索引: https://agentclientprotocol.com/llms.txt （所有页面均有 `.md` 纯文本版）
  - 协议仓库: https://github.com/agentclientprotocol/agent-client-protocol （原 zed-industries/agent-client-protocol，已迁移到独立 org；3987 stars，最后 push 2026-08-16 当天）
  - TS SDK 仓库: https://github.com/agentclientprotocol/typescript-sdk
  - npm: https://www.npmjs.com/package/@agentclientprotocol/sdk

## 结论速览（TL;DR）

1. **协议现有两个大版本**：v1 是 stable（`protocolVersion: 1`），v2 是 draft（`protocolVersion: 2`，官方明确"gate behind feature flags until it stabilizes"）。**新集成应实现 v1**，v2 仅作前瞻。
2. **传输层**：stdio + 换行分隔的 JSON-RPC 2.0（UTF-8，每行一条消息，stdout 只许 ACP 消息，stderr 可自由打日志）。Streamable HTTP/WebSocket 还在 draft RFD。
3. **TS 官方库已改名**：`@zed-industries/agent-client-protocol`（最新 0.4.5，2025-10-02）**已被 npm 标记 deprecated**，官方提示迁移到 **`@agentclientprotocol/sdk`**（latest **1.3.0**，2026-07-21 发布）。
4. **token 上报**：v1 stable 已有 `usage_update`（session 级上下文 used/size + 累计 cost）；**逐 turn 的 input/output/cache token 细分还在 RFD 阶段**（end-turn-token-usage，strawman 是在 PromptResponse 加 `usage` 字段），当前要细分只能走 `_meta` 扩展。
5. Client 侧**必须实现的只有 `session/request_permission`**；fs/terminal 全部是可选 capability，不声明 Agent 就不许调。

---

## 1. 协议核心生命周期（v1）

来源: https://agentclientprotocol.com/protocol/v1/overview.md 、 /protocol/v1/initialization.md 、 /protocol/v1/session-setup.md 、 /protocol/v1/prompt-turn.md

### 传输层

来源: https://agentclientprotocol.com/protocol/v1/transports.md

- JSON-RPC 2.0，两类消息：Method（请求-响应）和 Notification（单向）。
- **stdio transport**（SHOULD 支持）：Client 把 Agent 作为子进程启动；消息以 `\n` 分隔、UTF-8、消息体内不得含裸换行；Agent 的 stdout **MUST NOT** 输出任何非 ACP 内容；stderr 可用于日志，Client 可捕获/转发/忽略。
- Streamable HTTP：仅 draft proposal（RFD: streamable-http-websocket-transport）。自定义 transport 允许，只要保住 JSON-RPC 格式与生命周期。
- 约定：所有文件路径 **MUST 为绝对路径**；行号 1-based；属性名 camelCase，discriminator 字符串值 snake_case。

### 调用顺序

```
Client → Agent: initialize          （版本+capability 协商）
Client → Agent: authenticate        （仅当 Agent 声明 authMethods 且需要）
Client → Agent: session/new 或 session/load / session/resume
Client → Agent: session/prompt      （一个 turn 开始）
Agent  → Client: session/update * N（notification，流式进度）
Agent  ⇄ Client: fs/* terminal/* session/request_permission（按需反向调用）
Client → Agent: session/cancel      （notification，可随时）
Agent  → Client: session/prompt 响应 { stopReason }（turn 结束）
```

### initialize

请求（Client → Agent）：

```json
{
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": true, "writeTextFile": true },
      "terminal": true
    },
    "clientInfo": { "name": "my-client", "title": "My Client", "version": "1.0.0" }
  }
}
```

响应（Agent）：

```json
{
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "promptCapabilities": { "image": true, "audio": true, "embeddedContext": true },
      "mcpCapabilities": { "http": true, "sse": true }
    },
    "agentInfo": { "name": "my-agent", "version": "1.0.0" },
    "authMethods": []
  }
}
```

- `protocolVersion` 是单个整数（MAJOR），仅 breaking change 时递增。Client 发它支持的最新版本；Agent 支持就回同版本，否则回自己的最新版本；Client 不支持 Agent 回的版本则 SHOULD 断连。
- 所有 capability 省略即视为 **UNSUPPORTED**。新增 capability 不算 breaking change。
- `clientInfo`/`agentInfo` 目前 SHOULD（文档注明未来会 required）。

### session/new

```json
{
  "method": "session/new",
  "params": {
    "cwd": "/home/user/project",
    "mcpServers": [
      { "name": "filesystem", "command": "/path/to/mcp-server", "args": ["--stdio"], "env": [] }
    ]
  }
}
→ { "result": { "sessionId": "sess_abc123def456" } }
```

`cwd` 与 `mcpServers` 都是必填（v1；v2 中 mcpServers 变为可选）。

### session/load（可选，需 `agentCapabilities.loadSession: true`）

- 参数：`sessionId` + `cwd` + `mcpServers`。
- Agent **MUST 以 `session/update` 通知重放整段历史**（`user_message_chunk` / `agent_message_chunk` 等），全部重放完后才响应 `session/load`（result 为 null）。
- 另有 `session/resume`（capability `sessionCapabilities.resume: {}`）：恢复上下文但**不重放**历史，直接返回 `{}`；以及 `session/close`（`sessionCapabilities.close`）、`session/list`（`sessionCapabilities.list`）、`session/delete`（`sessionCapabilities.delete`）。
- 来源: https://agentclientprotocol.com/protocol/v1/session-setup.md

### session/prompt

```json
{
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123def456",
    "prompt": [
      { "type": "text", "text": "Can you analyze this code?" },
      { "type": "resource", "resource": { "uri": "file:///.../main.py", "mimeType": "text/x-python", "text": "..." } }
    ]
  }
}
```

- prompt 是 `ContentBlock[]`；Client MUST 按 promptCapabilities 限制内容类型。
- turn 结束时 Agent MUST 响应 `{ "stopReason": ... }`。StopReason 枚举：`end_turn` / `max_tokens` / `max_turn_requests` / `refusal` / `cancelled`。

### session/cancel（notification）

- 参数仅 `{ "sessionId": ... }`。
- Client 发出后 SHOULD 预先把当前 turn 未完成 tool call 标为 `cancelled`，并 **MUST** 以 `cancelled` outcome 应答所有 pending 的 `session/request_permission`。
- Agent 中止后 **MUST** 用 stopReason `cancelled` 响应原 `session/prompt`（文档特别警告：要 catch SDK abort 异常，不要把 abort 当 error 返回，否则 Client 会把它显示成错误）。
- 另有通用请求级取消 `$/cancel_request` notification（可选实现），被取消请求以错误码 **-32800** 或带部分结果的正常响应收尾。来源: /protocol/v1/cancellation.md

---

## 2. `session/update` 事件类型清单（v1 全集）

来源: /protocol/v1/prompt-turn.md 、 /protocol/v1/tool-calls.md 、 /protocol/v1/agent-plan.md 、 /protocol/v2/migration.md 的 v1→v2 对照表（可当 v1 全集清单用）

| `sessionUpdate` 值 | 含义 | 关键字段 |
|---|---|---|
| `user_message_chunk` | 用户消息分块（主要用于 session/load 重放） | `content: ContentBlock`, `messageId`(可选) |
| `agent_message_chunk` | Agent 回复文本流 | `content`, `messageId`(可选；相同 id = 同一条消息，变化 = 新消息) |
| `agent_thought_chunk` | 思考/推理流 | `content`, `messageId`(可选) |
| `tool_call` | 新 tool call 创建 | `toolCallId`(必), `title`(必), `kind`, `status`, `content[]`, `locations[]`, `rawInput`, `rawOutput` |
| `tool_call_update` | tool call 状态/内容更新 | `toolCallId` 必填，其余全可选（只传变化字段） |
| `plan` | 执行计划（每次发**完整列表**，Client 整体替换） | `entries[]: {content, priority: high/medium/low, status: pending/in_progress/completed}` |
| `available_commands_update` | slash command 列表变化 | 见 /protocol/v1/slash-commands.md |
| `current_mode_update` | 模式切换（配合 `session/set_mode`） | 见 /protocol/v1/session-modes.md |
| `config_option_update` | 会话配置项变化 | 见 /protocol/v1/session-config-options.md |
| `session_info_update` | 会话标题等元信息 | 见 RFD session-info-update |
| `usage_update` | 上下文占用/累计费用（见 §4） | `used`(必), `size`(必), `cost{amount,currency}`(可选) |

### tool call 生命周期状态

`status`: `pending`（输入还在流式/等审批）→ `in_progress` → `completed` | `failed`。取消时由 Client 侧预标记 `cancelled`。

`kind`（用于 UI 选图标）: `read` / `edit` / `delete` / `move` / `search` / `execute` / `think` / `fetch` / `other`(默认)。

### ToolCallContent 三种类型

1. `{ "type": "content", "content": <ContentBlock> }` — 普通内容块
2. `{ "type": "diff", "path": "/abs/path", "oldText": "...|null(新文件)", "newText": "..." }` — 文件修改 diff
3. `{ "type": "terminal", "terminalId": "term_xyz789" }` — 内嵌活终端（Client 持续显示实时输出，terminal released 后仍保留显示）

另有 `locations[]: { path, line? }` 支持 follow-along（实时跟踪 Agent 正在碰哪些文件）。

### ContentBlock 类型（与 MCP ContentBlock 结构一致，可直接转发 MCP 工具输出）

来源: /protocol/v1/content.md

| type | 必备字段 | prompt 里使用的 capability 门槛 |
|---|---|---|
| `text` | `text` | 无（所有 Agent MUST 支持） |
| `image` | `data`(base64), `mimeType` | `promptCapabilities.image` |
| `audio` | `data`, `mimeType` | `promptCapabilities.audio` |
| `resource`（内嵌资源，@-mention 首选） | `resource: {uri, text}` 或 `{uri, blob}` | `promptCapabilities.embeddedContext` |
| `resource_link` | `uri`, `name` | 无（所有 Agent MUST 支持） |

---

## 3. 反向调用（Agent → Client）与 capabilities 协商

来源: /protocol/v1/overview.md 、 /protocol/v1/file-system.md 、 /protocol/v1/terminals.md 、 /protocol/v1/tool-calls.md#requesting-permission

### Client 必须实现（baseline）

- **`session/request_permission`** — 唯一的 Client 侧 baseline method。参数：`sessionId` + `toolCall`（ToolCallUpdate，含 toolCallId 等）+ `options[]`（`{optionId, name, kind}`，kind ∈ `allow_once`/`allow_always`/`reject_once`/`reject_always`）。响应 `outcome`：`{"outcome":"selected","optionId":...}` 或 `{"outcome":"cancelled"}`。Client 可按用户设置自动允许/拒绝。

### Client 可选实现（靠 clientCapabilities 声明，不声明 Agent MUST NOT 调用）

| 方法 | capability | 语义要点 |
|---|---|---|
| `fs/read_text_file` | `fs.readTextFile: true` | 参数 `sessionId, path(绝对), line?(1-based), limit?`；返回 `{content}`。**要能读到编辑器未保存内容** |
| `fs/write_text_file` | `fs.writeTextFile: true` | 参数 `sessionId, path, content`；文件不存在 Client MUST 创建；成功返回 null |
| `terminal/create` | `terminal: true`（一个布尔覆盖全部 terminal/* 方法） | 参数 `sessionId, command, args?, env?[{name,value}], cwd?, outputByteLimit?`；**立即**返回 `{terminalId}`，命令后台跑；截断从头部截、保证字符边界 |
| `terminal/output` | 同上 | 取当前输出+退出状态 |
| `terminal/wait_for_exit` | 同上 | 等待命令退出 |
| `terminal/kill` | 同上 | 杀进程但不释放 terminal（还能查 output） |
| `terminal/release` | 同上 | Agent 用完 MUST release |
| `elicitation/create` | `elicitation` 对象（按 form/url 模式分别声明；`{}` 不代表支持 form，和 MCP 不同） | 向用户请求结构化输入 |

Client 侧 notification：`session/update`（接收）、`elicitation/complete`。

### Agent 侧 capability 汇总（v1）

- baseline（无 capability，必须有）：`initialize`、`session/new`、`session/prompt`、`session/cancel`、发 `session/update`。
- `loadSession: true` → `session/load`；`sessionCapabilities.{list,resume,close,delete}` → 对应方法；`promptCapabilities.{image,audio,embeddedContext}`；`mcpCapabilities.{http,sse}`；`auth.logout` → `logout`；`session/set_mode`（modes）。
- 自定义扩展：`_meta` 字段带自定义数据、`_` 前缀自定义方法、initialize 时用 `_meta` 广告自定义 capability（/protocol/v1/extensibility.md）。

---

## 4. token / usage 上报

- **v1 stable 已内置 `usage_update`**（来源: /protocol/v1/prompt-turn.md#session-usage-updates，由 RFD session-usage 落地）：

```json
{
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "usage_update",
      "used": 53000,
      "size": 200000,
      "cost": { "amount": 0.045, "currency": "USD" }
    }
  }
}
```

  - `used`/`size` 必填非空（当前 session 上下文 token 数 / 窗口总大小）；`cost` 可选，为**累计** session 费用，`currency` 是 ISO 4217。
  - 语义是"session 级上下文占用"，**不是逐 turn 的 input/output 细分**。

- **逐 turn token 细分仍是 RFD**（https://agentclientprotocol.com/rfds/end-turn-token-usage.md ，尚未进入 stable schema）。strawman 形态：在 `session/prompt` 响应（v2 则是 idle `state_update`）加可选 `usage`：

```json
{ "stopReason": "end_turn",
  "usage": { "totalTokens": 53000, "inputTokens": 35000, "outputTokens": 12000,
             "thoughtTokens": 5000, "cachedReadTokens": 5000, "cachedWriteTokens": 1000 } }
```

- **结论**：OpenHorn 若要拿逐 turn input/output token，标准字段今天还不存在——要么读各 agent 的 `_meta` 私有扩展，要么先用 `usage_update` 的 used/size/cost，等 end-turn-token-usage RFD 落地再跟进。

---

## 5. TypeScript 库现状

### 包的迁移（重要）

- **旧包 `@zed-industries/agent-client-protocol`：npm 已标 deprecated**，deprecation 消息原文："This package has been renamed to @agentclientprotocol/sdk. Please migrate to continue receiving updates."。最后版本 0.4.5（2025-10-02），deps 仅 `zod ^3.0.0`。
- **新包 `@agentclientprotocol/sdk`**（实测 npm registry）：
  - latest **1.3.0**（2026-07-21）；1.0.0 于 2026-06-24 发布；近两月节奏约每 1-2 周一个 minor。
  - 无 runtime deps；**peerDependencies: `zod ^3.25.0 || ^4.0.0`**；无 engines 限制；纯 ESM。
  - exports：主入口 `.`（= **v1 stable API**）、`./experimental/v2`、`./experimental/http-client`、`./experimental/ws-client`。
  - 仓库: https://github.com/agentclientprotocol/typescript-sdk （Apache 2.0）
  - API 文档: https://agentclientprotocol.github.io/typescript-sdk

### Client 侧 API 形态（fluent API，官方示例）

来源: https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/examples/client.ts （另有 agent.ts / dual-version-agent.ts / http-client.ts / ws-client.ts）

```ts
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

// 1. spawn agent 子进程，stdio 转成 Web Streams
const agentProcess = spawn("some-acp-agent", [], { stdio: ["pipe", "pipe", "inherit"] });
const input = Writable.toWeb(agentProcess.stdin!);
const output = Readable.toWeb(agentProcess.stdout!) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(input, output);   // 换行分隔 JSON-RPC 流

// 2. fluent client：注册反向调用 handler，然后 connectWith
const promptResult = await acp
  .client({ name: "example-client" })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => handlePermission(ctx.params))
  .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => handleWrite(ctx.params))
  .onRequest(acp.methods.client.fs.readTextFile, (ctx) => handleRead(ctx.params))
  .connectWith(stream, async (ctx) => {
    const initResult = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    return ctx.buildSession(process.cwd()).withSession(async (session) => {
      session.prompt("Hello, agent!");
      for (;;) {
        const message = await session.nextUpdate();   // pull 式消费 session/update
        if (message.kind === "stop") return message.response;  // {stopReason}
        await onSessionUpdate(message.notification);  // switch(update.sessionUpdate)
      }
    });
  });
```

- Agent 侧对称：`agent({ name })` + `initialize(...)`/`newSession(...)`/`prompt(...)` handler + `connect(stream)`。
- 旧 API `AgentSideConnection`/`ClientSideConnection` 类**已 deprecated 但仍可用**（向后兼容），新集成官方要求用 fluent `agent()`/`client()`。
- 类型齐全：`acp.Client` 接口、`acp.SessionNotification`、`acp.RequestPermissionRequest` 等均导出。

### Bun 支持

- 官方未明说 Bun；实测包无 engines 限制、无 native deps、纯 ESM + zod。传输抽象是 **Web Streams**（`ndJsonStream(WritableStream, ReadableStream)`），示例用 `node:child_process` + `Writable.toWeb`/`Readable.toWeb` —— 这两套 Bun 都实现了；用 `Bun.spawn` 时 `proc.stdout` 本身就是 `ReadableStream`，stdin FileSink 需包一层 WritableStream。**结论：无阻碍，但需自行冒烟验证（未见官方 Bun CI）**。

### 维护活跃度

- typescript-sdk releases（GitHub API 实测）：v0.23.0(2026-06-01) → … → v1.0.0(2026-06-24) → v1.1.0 → v1.2.0/1.2.1 → v1.3.0(2026-07-21)，两个月内 15 个 release，非常活跃。
- 生产级参考实现：Gemini CLI 的 ACP agent 端（https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/zed-integration/zedIntegration.ts）。

---

## 6. 协议版本与稳定性

- **当前 stable：v1（`protocolVersion: 1`）**。MAJOR 版本号只在 breaking change 时递增；v1 期间的新功能（session/resume、session/close、session/list、usage_update、elicitation、config options、messageId 等）全部以**可选 capability / 可选字段**方式追加，对 v1 client 不构成 breaking。
- **v2：draft**（`protocolVersion: 2`，schema/v2/schema.json 为 baseline，另有 schema.unstable.json）。官方原话（migration 页）："The v2 protocol surface as a whole is still labeled draft, so gate v2 support behind explicit version negotiation and feature flags until it stabilizes."；SDK README 也警告 v2 wire protocol 与 TS API "may change incompatibly in any SDK release"。
- v2 主要变化（供前瞻，来源 /protocol/v2/migration.md）：
  - `session/prompt` 响应只表示"已接受"，turn 结束改由 `state_update`(running/idle/requires_action) 通知携带 stopReason；
  - 更新语义统一为按 ID upsert（省略=不变、null=清除、值=替换、chunk=追加），`messageId` 变必填；
  - **`fs/*`、`terminal/*`（Client 执行面）、`session/set_mode`、`session/load` 全部移除**（Client 侧工具改走 client-provided MCP server；Agent 自有终端展示改为 `terminal_update`/`terminal_output_chunk`）；
  - `authenticate`/`logout` → `auth/login`/`auth/logout`；capabilities 重组为双向 `info` + `capabilities`，布尔标记全部改为对象标记。
- **近 6 个月（2026-02 至 2026-08）breaking 频率评估**：协议 v1 wire 层面 0 次 breaking（靠 capability 追加演进）；变动集中在 (a) TS SDK 从 0.x 快速迭代到 1.0（2026-06-24 前 API 形态多次变化，AgentSideConnection → fluent API），(b) v2 draft 面的高频改动。**锁定 `@agentclientprotocol/sdk` ^1.x 主入口 + protocolVersion 1 即可获得稳定面**。

---

## 7. 生态补充（对 sidecar 选型有用）

来源: https://agentclientprotocol.com/get-started/agents.md

已支持 ACP 的 agent（可被 client spawn）节选：**Gemini CLI**（内置）、**Claude Agent SDK**（经 Zed 适配器 https://github.com/zed-industries/claude-agent-acp ，即原 claude-code-acp）、**Codex CLI**（经 https://github.com/zed-industries/codex-acp ）、GitHub Copilot CLI（2026-01 公测）、Cursor CLI、Goose、OpenCode、OpenHands、Qwen Code、Kimi CLI、Mistral Vibe 等 40+。另有 ACP Registry（/get-started/registry.md）用于发现/安装 agent。

## Caveats / Not Found

- 逐 turn token 细分（inputTokens/outputTokens/cache）**没有** stable 标准字段，只有 RFD strawman（见 §4），实现时需按 agent 私有 `_meta` 兜底。
- SDK 对 Bun 无官方承诺/CI，结论"应可用"来自包结构分析（Web Streams + 无 native deps），未做运行冒烟。
- GitHub API 未认证访问偶发限流，SDK release 列表取到最近 15 个；协议仓库 star/push 数据为 2026-08-16 实测快照。
- v1 文档中 `session/set_mode`、slash-commands、session-config-options、elicitation 详情页未逐页抓取，只记录了入口 URL；需要时再深挖。
