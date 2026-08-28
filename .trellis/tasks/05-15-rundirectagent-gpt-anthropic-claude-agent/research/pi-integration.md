# Research: pi-agent-core / pi-ai / pi-coding-agent Integration into OpenHorn Sidecar

- **Query**: 如何将 earendil-works/pi 的三个包集成到 OpenHorn sidecar 替换 runDirectAgent
- **Scope**: external + internal (mixed)
- **Date**: 2026-05-13

---

## 1. pi-ai StreamFn 接口

### 完整签名

```typescript
// packages/ai/src/types.ts

// 底层通用 StreamFunction
export type StreamFunction<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions
> = (
  model: Model<TApi>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStream;

// 简化版（带 reasoning 参数）
export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
}
```

**Agent 层使用的 StreamFn**（定义在 `packages/agent/src/types.ts`）：

```typescript
export type StreamFn = (
  ...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;
```

等价于：

```typescript
type StreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
```

### 关键类型

**Context**:
```typescript
export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
```

**Model**:
```typescript
export interface Model<TApi extends Api> {
  id: string;          // 如 "claude-sonnet-4-20250514"
  name: string;        // 如 "Claude Sonnet 4"
  api: TApi;           // 如 "anthropic-messages" | "openai-completions" | "openai-responses" | ...
  provider: Provider;  // 如 "anthropic" | "openai" | "deepseek" | ...
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: ...;        // 各 API 的兼容性设置
}
```

**AssistantMessageEventStream** 是一个 `EventStream<AssistantMessageEvent, AssistantMessage>`，支持 `async for...of` 迭代和 `.result()` 获取最终结果。

### 已内置的提供商 API

`KnownApi` 已支持：
- `"openai-completions"` — OpenAI Chat Completions
- `"openai-responses"` — OpenAI Responses API
- `"anthropic-messages"` — Anthropic Messages API
- `"google-generative-ai"` — Google Gemini
- `"google-vertex"` — Google Vertex AI
- `"bedrock-converse-stream"` — Amazon Bedrock
- `"mistral-conversations"` — Mistral
- `"azure-openai-responses"` — Azure OpenAI
- `"openai-codex-responses"` — OpenAI Codex

**结论**: 不需要自己实现 StreamFn。直接用 `streamSimple()` + 正确的 `Model` 对象即可路由到内置提供商。可通过 `getModel("openai", "gpt-4o")` 获取预定义模型，或手动构造 `Model` 对象指定自定义 `baseUrl`。

### 已内置的提供商列表

pi-ai 已内置 30+ 个 provider，包括：`openai`、`anthropic`、`google`、`deepseek`、`groq`、`cerebras`、`openrouter`、`xai`、`mistral`、`together`、`fireworks`、`huggingface` 等。

---

## 2. pi-agent-core Agent 类用法

### 创建 Agent

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple, getModel } from "@earendil-works/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant...",
    model: getModel("openai", "gpt-4o"),
    // 或手动构造 Model 对象
    tools: [/* AgentTool[] */],
    messages: [],  // 可预填历史
    thinkingLevel: "off",  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  },
  streamFn: streamSimple,  // 可选，默认就是 streamSimple
  getApiKey: async (provider) => {
    // 动态返回 API key
    if (provider === "openai") return "sk-...";
    if (provider === "anthropic") return "sk-ant-...";
  },
  // 可选钩子
  beforeToolCall: async (ctx, signal) => {
    // 返回 { block: true, reason: "..." } 可拦截工具
    return undefined;
  },
  afterToolCall: async (ctx, signal) => {
    // 可修改工具结果
    return undefined;
  },
  toolExecution: "parallel",  // "parallel" | "sequential"
});
```

### AgentOptions 完整定义

```typescript
export interface AgentOptions {
  initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  streamFn?: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
  prepareNextTurn?: (signal?: AbortSignal) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  steeringMode?: QueueMode;       // "all" | "one-at-a-time"
  followUpMode?: QueueMode;
  sessionId?: string;
  thinkingBudgets?: ThinkingBudgets;
  transport?: Transport;          // "sse" | "websocket" | "websocket-cached" | "auto"
  maxRetryDelayMs?: number;
  toolExecution?: ToolExecutionMode;  // "sequential" | "parallel"
}
```

### 订阅事件

```typescript
const unsubscribe = agent.subscribe((event, signal) => {
  // event: AgentEvent
  // signal: AbortSignal（当前 run 的）
  switch (event.type) {
    case "agent_start": ...
    case "message_start": ...
    case "message_update": ...   // 流式 text delta
    case "message_end": ...
    case "tool_execution_start": ...
    case "tool_execution_update": ...
    case "tool_execution_end": ...
    case "turn_start": ...
    case "turn_end": ...
    case "agent_end": ...
  }
});
```

### 发送 Prompt

Agent 类有 `prompt()` 和 `continueRun()` 方法（在 agent.ts 尾部定义）。基本用法：

```typescript
// 发送消息并等待完成
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// 或通过底层 agentLoop 函数
import { agentLoop } from "@earendil-works/pi-agent-core";
const stream = agentLoop(
  [{ role: "user", content: "Hello", timestamp: Date.now() }],
  { systemPrompt: "...", messages: [], tools: [...] },
  { model, convertToLlm: (msgs) => msgs, ... },
  signal,
  streamFn,
);
for await (const event of stream) { /* handle event */ }
const finalMessages = await stream.result();
```

### 中止

```typescript
agent.abort();  // 中止当前 run
```

---

## 3. pi-agent-core 事件类型 → OpenHorn AgentEvent 映射

### pi-agent-core AgentEvent（完整定义）

```typescript
export type AgentEvent =
  // Agent 生命周期
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn 生命周期（一次 assistant 响应 + 工具调用/结果）
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // 消息生命周期
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // 工具执行生命周期
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

### AssistantMessageEvent（流式内容事件，嵌套在 `message_update` 中）

```typescript
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: ...; message: AssistantMessage }
  | { type: "error"; reason: ...; error: AssistantMessage };
```

### OpenHorn 现有 AgentEvent

```typescript
// apps/sidecar/src/agent/events.ts
export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "final_text"; content: string }
  | { type: "tool_start"; toolName?: string; toolInput?: unknown }
  | { type: "tool_result"; content?: string }
  | { type: "user_message"; userMessageId: string }
  | { type: "done" }
  | { type: "error"; content: string };
```

### 映射关系

| pi-agent-core 事件 | OpenHorn AgentEvent | 说明 |
|---|---|---|
| `message_update` + `assistantMessageEvent.type === "text_delta"` | `{ type: "final_text", content: delta }` | 流式文本增量 |
| `message_end`（assistant message 有 text content） | `{ type: "text", content: fullText }` | 完整文本块（可选，用于非流式场景） |
| `tool_execution_start` | `{ type: "tool_start", toolName, toolInput: args }` | 工具开始 |
| `tool_execution_end` | `{ type: "tool_result", content: resultText }` | 工具完成 |
| `agent_end` | `{ type: "done" }` | Agent 运行结束 |
| `message_update` + `assistantMessageEvent.type === "error"` | `{ type: "error", content: errorMessage }` | 错误 |
| `agent_start` / `turn_start` / `turn_end` | (无直接映射) | 可忽略或记录日志 |
| `tool_execution_update` | `{ type: "tool_start", toolName }` | 工具进度更新（可选） |

---

## 4. coding-agent 工具创建

### createAllTools

```typescript
// packages/coding-agent/src/core/tools/index.ts

export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
  return {
    read: createReadTool(cwd, options?.read),
    bash: createBashTool(cwd, options?.bash),
    edit: createEditTool(cwd, options?.edit),
    write: createWriteTool(cwd, options?.write),
    grep: createGrepTool(cwd, options?.grep),
    find: createFindTool(cwd, options?.find),
    ls: createLsTool(cwd, options?.ls),
  };
}

// 也有子集版本
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[];   // read, bash, edit, write
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[]; // read, grep, find, ls
```

### AgentTool execute 签名

```typescript
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  executionMode?: ToolExecutionMode;
}

export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  terminate?: boolean;
}
```

### BashTool 签名示例

```typescript
const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema>;

export interface BashToolOptions {
  operations?: BashOperations;       // 可自定义执行后端
  commandPrefix?: string;
  shellPath?: string;
  spawnHook?: BashSpawnHook;
}
```

**重要**: `createBashTool` 内部调用 `wrapToolDefinition(createBashToolDefinition(cwd, options))`。`ToolDefinition` 包含渲染器等 TUI 相关内容，但 `AgentTool` 层面不包含 UI，`wrapToolDefinition` 只提取 `name/label/description/parameters/execute/executionMode`。

---

## 5. npm 包可用性

| 包名 | 版本 | 发布日期 | 状态 |
|---|---|---|---|
| `@earendil-works/pi-ai` | 0.74.0 | 一周前 | **可用** |
| `@earendil-works/pi-agent-core` | 0.74.0 | 一周前 | **可用** |
| `@earendil-works/pi-coding-agent` | 0.74.0 | 一周前 | **可用** |
| `@earendil-works/pi-tui` | 0.74.0 | (同版本) | **可用** |

所有包 MIT 协议。维护者：mitsuhiko (Armin Ronacher), badlogic (Mario Zechner)。

**pi-ai 的依赖** (11 个)：`@anthropic-ai/sdk ^0.91.1`、`openai 6.26.0`、`@google/genai ^1.40.0`、`@aws-sdk/client-bedrock-runtime`、`@mistralai/mistralai`、`typebox ^1.1.24`、`undici ^7.19.1` 等。

**pi-agent-core 的依赖** (2 个)：`@earendil-works/pi-ai ^0.74.0`、`typebox ^1.1.24`。

**pi-coding-agent 的依赖** (21 个，含 pi-tui)。

---

## 6. pi-tui 依赖分析

### pi-tui 是什么

终端 UI 框架，提供 `Container`、`Text`、`EditorComponent` 等组件。用于 coding-agent 的交互式 TUI 界面。

### pi-tui 的依赖

```json
{
  "dependencies": {
    "get-east-asian-width": "^1.3.0",
    "marked": "^15.0.12"
  },
  "optionalDependencies": {
    "koffi": "^2.9.0"       // FFI 库，用于原生调用
  }
}
```

### coding-agent 对 pi-tui 的使用

coding-agent 在以下位置导入 pi-tui：
- `bash.ts` — `import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui"` （渲染工具结果）
- `interactive/` 目录 — 交互式 TUI 模式
- `theme/theme.ts` — 主题

### 能否只用工具不用 UI？

**可以。** 分析结果：

1. **`@earendil-works/pi-agent-core`** — 完全不依赖 pi-tui。只依赖 pi-ai 和 typebox。**可直接使用**。

2. **`@earendil-works/pi-coding-agent` 的工具** — `createBashTool` 等返回的 `AgentTool` 对象本身不包含 UI 代码（UI 在 `ToolDefinition.renderCall/renderResult` 中，被 `wrapToolDefinition` 剥离了）。但模块级别导入了 pi-tui（`bash.ts` 文件顶部就有 `import { Container, Text } from "@earendil-works/pi-tui"`），所以 **import 时会加载 pi-tui 模块**。

3. **推荐方案**:
   - **方案 A（推荐）**: 只用 `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`，**自己编写简化版工具**（不导入 coding-agent）。工具逻辑很简单（bash/read/write/edit/grep/find/ls），OpenHorn sidecar 已有类似实现。
   - **方案 B**: 安装 `@earendil-works/pi-coding-agent`，接受 pi-tui 作为传递依赖。运行时不会实际渲染 TUI（没有终端绑定），但会增加 ~4.3MB 的 pi-ai + ~11.2MB 的 coding-agent 包体积以及 21 个额外依赖。
   - **方案 C**: 从 coding-agent 源码中拷贝工具创建逻辑（bash.ts/read.ts/edit.ts 中的 execute 函数），去掉 TUI 导入。

---

## 7. 现有 OpenHorn Sidecar runDirectAgent 分析

### 文件位置
- `apps/sidecar/src/agent/direct.ts` — 主实现（~464 行）
- `apps/sidecar/src/agent/events.ts` — AgentEvent 类型 + convertSdkEvent（~80 行）

### 现有架构
- 手动调用 Anthropic/OpenAI REST API（非流式，非 SDK）
- 自己管理 tool loop（最多 30 轮）
- 自己实现 7 个工具（bash, read_file, list_dir, write_file, edit_file, grep, glob, web_search）
- 通过 `protocol` 参数区分 `"anthropic"` 和 OpenAI 兼容

### 替换要点
- `RunDirectAgentInput.apiKey` → `Agent.getApiKey`
- `RunDirectAgentInput.baseUrl` → `Model.baseUrl`
- `RunDirectAgentInput.model` → `Model.id`
- `RunDirectAgentInput.protocol` → `Model.api`（"anthropic-messages" / "openai-completions"）
- `RunDirectAgentInput.conversationHistory` → `Agent.initialState.messages`
- `RunDirectAgentInput.onEvent` → `Agent.subscribe`（事件映射见上表）
- `RunDirectAgentInput.abortController` → `agent.abort()`
- `TOOLS` 常量 → `AgentTool[]`（用 pi-agent-core 的 `AgentTool` 接口）
- `executeTool` 函数 → 每个工具的 `execute` 方法

---

## 8. 集成方案总结

### 需要安装的包

```bash
pnpm --filter sidecar add @earendil-works/pi-agent-core @earendil-works/pi-ai
# 不需要 pi-coding-agent，自己写工具即可
```

### 构造 Model 对象

```typescript
// 对于已知模型，可用 getModel
import { getModel } from "@earendil-works/pi-ai";
const model = getModel("openai", "gpt-4o");

// 对于自定义模型/baseUrl，手动构造
const customModel: Model<"openai-completions"> = {
  id: input.model,
  name: input.model,
  api: "openai-completions",           // 或 "anthropic-messages"
  provider: "openai",                  // 或 "anthropic"
  baseUrl: input.baseUrl || "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};
```

### 实现骨架

```typescript
import { Agent, type AgentEvent as PiAgentEvent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import type { AgentEvent } from "./events";

export async function runDirectAgent(input: RunDirectAgentInput): Promise<void> {
  const model = buildModel(input);
  const tools = buildTools(input.cwd);  // 自定义 AgentTool[]

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: Object.values(tools),
      messages: buildInitialMessages(input.conversationHistory),
    },
    streamFn: streamSimple,
    getApiKey: async () => input.apiKey,
  });

  agent.subscribe((event: PiAgentEvent) => {
    const mapped = mapEvent(event);
    if (mapped) input.onEvent(mapped);
  });

  try {
    await agent.prompt({
      role: "user",
      content: input.prompt,
      timestamp: Date.now(),
    });
  } finally {
    input.onEvent({ type: "done" });
  }

  // abort 支持
  input.abortController.signal.addEventListener("abort", () => agent.abort());
}
```

---

## Caveats / Not Found

1. **pi 仓库 URL 注意**: GitHub 仓库名为 `earendil-works/pi`，但 monorepo 实际名为 `earendil-works/pi-mono`（package.json 中）。文件 URL 使用 `earendil-works/pi` 的 `main` 分支。

2. **Agent.prompt() 方法**: 在 `agent.ts` 中定义，但代码太长未完全读取。从 subscribe 和 agentLoop 的分析来看，`prompt()` 应该接受 `AgentMessage` 并返回 `Promise<void>`。

3. **版本锁定**: 所有包目前只有 0.74.0 一个版本，刚发布一周。API 可能不稳定。

4. **pi-ai 体积**: 包含 OpenAI、Anthropic、Google、AWS Bedrock、Mistral 等 SDK，解压后 4.3MB。sidecar 打包时可能增加产物体积。

5. **Bun 兼容性**: pi 使用 Node.js 20+。OpenHorn sidecar 使用 Bun 运行时。需验证 pi-ai 的 SDK 依赖在 Bun 下正常工作（特别是 `@aws-sdk/client-bedrock-runtime` 和 `koffi`）。

6. **`register-builtins.js` 副作用**: `pi-ai` 的 `stream.ts` 顶部导入 `"./providers/register-builtins.js"`，这会在模块加载时注册所有内置提供商。这是预期行为，但意味着即使只用 OpenAI，也会加载 Anthropic/Google 等 SDK。

7. **web_search 工具**: 现有 sidecar 有 `web_search` 工具，pi-coding-agent 没有。需要自己保留或扩展。
