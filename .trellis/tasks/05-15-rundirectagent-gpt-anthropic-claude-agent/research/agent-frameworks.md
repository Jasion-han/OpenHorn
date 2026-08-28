# Research: Agent Tool Frameworks for OpenHorn Sidecar

- **Query**: 调研适合 OpenHorn sidecar 使用的 Agent 工具框架/SDK，让 GPT 等非 Anthropic 模型拥有与 Claude Agent SDK 对等的编码 Agent 能力
- **Scope**: mixed (internal codebase + external npm packages)
- **Date**: 2026-05-13

---

## Current Architecture

### Files Found

| File Path | Description |
|---|---|
| `apps/sidecar/src/agent/direct.ts` | 手写的 Direct Agent runtime，含 8 个工具定义和双协议（Anthropic / OpenAI）agentic loop |
| `apps/sidecar/src/agent/claude.ts` | Claude Agent SDK 集成，调用 `@anthropic-ai/claude-agent-sdk` 的 `query()` |
| `apps/sidecar/src/agent/codex.ts` | OpenAI Codex CLI 集成，通过 JSON-RPC stdio 协议驱动 `codex app-server` |
| `apps/sidecar/src/agent/events.ts` | 统一的 `AgentEvent` 类型定义，所有 runtime 都输出此格式 |
| `apps/sidecar/package.json` | 当前依赖：`@anthropic-ai/claude-agent-sdk@0.2.71`, `zod@^3.25.0` |

### Current Tool Set (direct.ts)

8 个手写工具：`bash`, `read_file`, `list_dir`, `write_file`, `edit_file`, `grep`, `glob`, `web_search`

特点：
- 工具定义使用 Anthropic `input_schema` 格式，另有 `OPENAI_TOOLS` 转换为 OpenAI `function` 格式
- 工具执行全部直接调用 Node.js APIs（`exec`, `readFile`, `writeFile` 等）
- 双协议 agentic loop：`runAnthropicAgent()` 和 `runOpenAIAgent()` 分别处理不同 API 格式
- 最大 30 轮，无 streaming（非 SSE，但实时 `onEvent` 回调）
- web_search 使用 DuckDuckGo instant answer API（功能有限）

### Pain Points

1. 工具实现简陋（无错误恢复、无超时控制、无并发工具执行）
2. 无 diff/patch 编辑能力（仅字符串替换）
3. web_search 只用 DuckDuckGo instant answer，几乎无法搜到有用信息
4. 无 workspace 边界安全检查（direct.ts 中虽有 `startsWith(cwd)` 检查，但不防御 symlink）
5. 双协议代码大量重复

---

## Framework Evaluation

### 1. @anthropic-ai/claude-agent-sdk

| 维度 | 评估 |
|---|---|
| **版本** | 0.3.142 (latest), 项目用 0.2.71 |
| **包大小** | 4.5 MB |
| **周下载量** | 5.3M |
| **多模型支持** | **不支持**。SDK 本质上是 spawning `claude` CLI binary 的 wrapper |
| **内置工具** | Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Agent, TodoWrite, NotebookEdit, MCP |
| **Streaming** | 支持（`includePartialMessages`） |
| **Tool Calling** | 由 Claude CLI 内部处理，SDK 消费者无法自定义 tool calling 协议 |
| **Bun 兼容** | 需要 `claude` CLI 安装在 PATH 中 |

**结论**：**不适合用于非 Anthropic 模型**。SDK 的 `query()` 函数内部 spawn 了 `claude` CLI，该 CLI 只与 Anthropic API 通信。`model` 参数虽然是 `string` 类型，但只接受 Anthropic 模型名（sonnet/opus/haiku）。无法传 OpenAI API key 或指向 OpenAI 端点。

Options 类型中的关键约束：
- `pathToClaudeCodeExecutable` — 必须是 claude CLI
- `env.ANTHROPIC_API_KEY` — 只接受 Anthropic key
- `model: 'sonnet' | 'opus' | 'haiku' | 'inherit'`（AgentDefinition 中）

**当前项目已正确使用**：仅在 `claude.ts` 中用于 Anthropic 模型。

---

### 2. @openai/agents (OpenAI Agents SDK)

| 维度 | 评估 |
|---|---|
| **版本** | 0.11.4 |
| **包大小** | agents-core 5.4 MB, 总计 ~20 MB（含 openai SDK） |
| **周下载量** | 770K |
| **多模型支持** | **支持，通过 ModelProvider 接口**。核心包 `@openai/agents-core` 定义了抽象 `Model` 和 `ModelProvider` 接口 |
| **内置工具** | `shellTool`, `computerTool`, `applyPatchTool`, `hostedMcpTool`, function tool (自定义) |
| **Streaming** | 支持（`getStreamedResponse` 返回 `AsyncIterable<StreamEvent>`） |
| **Tool Calling** | 使用 OpenAI Responses API 格式（`function_call` / `tool_calls`） |
| **Bun 兼容** | 依赖 `openai` SDK，理论可在 Bun 中运行 |

**Model 接口** (来自 `@openai/agents-core`):
```typescript
interface Model {
  getResponse(request: ModelRequest): Promise<ModelResponse>;
  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent>;
  getRetryAdvice?(args: ModelRetryAdviceRequest): Promise<ModelRetryAdvice | undefined>;
}

interface ModelProvider {
  getModel(modelName?: string): Promise<Model> | Model;
}
```

**FunctionTool 接口**:
```typescript
type FunctionTool<Context, TParameters, Result> = {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonObjectSchema<any>;
  strict: boolean;
  execute: (context: RunContext<Context>, input: TParameters) => Promise<Result>;
  // ...
};
```

**优势**：
- `ModelProvider` 抽象允许实现任意模型后端（Anthropic、Google 等）
- 内置 `shellTool` + `applyPatchTool` 提供比当前 direct.ts 更高质量的工具
- 支持 multi-agent handoff
- 有 retry、guardrail、tool approval 等成熟机制
- OpenAI 官方维护

**劣势**：
- 默认绑定 OpenAI Responses API 格式
- 要支持 Anthropic 需要自己实现 `ModelProvider`（社区可能已有）
- 包体不算小（含 openai SDK 后 ~20MB）
- `shellTool` 设计为 Codex sandbox 环境，本地使用需额外配置

**结论**：**值得深入评估**。核心的 Model/ModelProvider 抽象设计清晰，但自己实现 Anthropic 的 ModelProvider 有一定工作量。

---

### 3. @openai/codex (Codex CLI)

| 维度 | 评估 |
|---|---|
| **版本** | 0.130.0 |
| **包大小** | 12.9 KB (只是 CLI wrapper) |
| **周下载量** | 31M |
| **多模型支持** | 仅 OpenAI 模型 |
| **内置工具** | shell execution, file editing (apply_patch), file reading |
| **集成方式** | JSON-RPC over stdio（`codex app-server`） |
| **Bun 兼容** | 需要 `codex` 安装在 PATH 中 |

**结论**：**不适合作为 Agent runtime 框架**。Codex CLI 是一个独立应用，不是可嵌入的 SDK。当前项目已通过 `codex.ts` 以子进程方式集成。它没有可导入的 TypeScript API，只能通过 JSON-RPC stdio 通信。且仅支持 OpenAI 模型。

---

### 4. Vercel AI SDK (ai / @ai-sdk/*)

| 维度 | 评估 |
|---|---|
| **版本** | 6.0.182 |
| **包大小** | 6.6 MB (core), providers 各 ~1MB |
| **周下载量** | 13M |
| **多模型支持** | **最强**。官方 providers: `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/groq` 等 20+ |
| **内置工具** | **无内置文件操作工具**。提供 tool calling 抽象层 (`tool()` helper)，需自定义工具实现 |
| **Streaming** | **最强**。`streamText()`, `generateText()` with tool calling |
| **Tool Calling** | 统一 tool calling 抽象，自动适配各 provider 的 function calling 协议 |
| **Bun 兼容** | 兼容 |

**核心 API**:
```typescript
import { generateText, streamText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';

const result = await generateText({
  model: openai('gpt-4o'),  // 或 anthropic('claude-sonnet-4-20250514')
  tools: {
    readFile: tool({
      description: 'Read a file',
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }) => { /* ... */ },
    }),
  },
  maxSteps: 30, // agentic loop
  prompt: 'Fix the bug in src/index.ts',
});
```

**优势**：
- **模型无关**：一套代码可切换 OpenAI/Anthropic/Google/Groq/DeepSeek 等
- 统一的 tool calling 抽象（处理各 provider 的格式差异）
- `maxSteps` 实现 agentic loop（自动处理 tool_calls → tool_result → 下一轮）
- 优秀的 streaming 支持
- 社区最活跃（13M 周下载）
- 轻量（core 6.6MB，按需加载 provider）
- Zod schema 原生支持
- Bun 兼容性好

**劣势**：
- **无内置编码工具**（read_file, write_file, edit, bash 等需自己实现）
- 只提供 LLM 调用层和 tool calling 抽象，不提供完整 agent runtime
- 当前 direct.ts 的手写工具可以直接迁移到 AI SDK 的 `tool()` 格式

**结论**：**最推荐方案**。AI SDK 是"tool calling 协议适配层"的最佳选择，可以直接替换 direct.ts 中的双协议 agentic loop 代码，同时保留现有的手写工具实现。

---

### 5. LangChain.js (@langchain/core + langchain)

| 维度 | 评估 |
|---|---|
| **版本** | core 1.1.46, langchain 1.4.0 |
| **包大小** | core 2.9MB, langchain 2.9MB, **但依赖链极深** |
| **周下载量** | 2.1M |
| **多模型支持** | 支持。`@langchain/openai`, `@langchain/anthropic`, `@langchain/google-genai` 等 |
| **内置工具** | 有 `DynamicTool`, `StructuredTool` 抽象; `@langchain/community` 有 FS/Shell 工具 |
| **Streaming** | 支持（基于 LangChain Expression Language） |
| **Tool Calling** | 支持（`bindTools()` + `ToolCallingAgent`） |
| **Bun 兼容** | 部分兼容（某些 community packages 可能有 Node 特有依赖） |

**优势**：
- 生态最成熟，工具/chain/memory/retrieval 一应俱全
- 有 LangGraph 做复杂 agent workflow

**劣势**：
- **过重**。依赖 `@langchain/langgraph`, `@langchain/langgraph-checkpoint`, `langsmith` 等，安装后数十 MB
- 抽象层过多，对 Bun standalone binary 打包是灾难
- API 变动频繁（v0.1 → v0.2 → v0.3 大量 breaking changes）
- 对简单的 tool calling agent 来说严重 over-engineering

**结论**：**不推荐**。对 OpenHorn sidecar 的嵌入式场景来说太重了。

---

### 6. Mastra (@mastra/core)

| 维度 | 评估 |
|---|---|
| **版本** | core 1.34.0 |
| **包大小** | **53.5 MB** |
| **周下载量** | 960K |
| **多模型支持** | 支持（使用 AI SDK provider 抽象，`@ai-sdk/provider` v5/v6） |
| **内置工具** | 有 tool 抽象，MCP 支持 |
| **Streaming** | 支持 |
| **Bun 兼容** | 不确定（大量依赖如 `hono`, `execa`, `archiver` 等） |

**优势**：
- 基于 AI SDK 的 provider 抽象，模型支持广泛
- 内置 workflow 编排、MCP server 支持
- TypeScript 原生

**劣势**：
- **极重**（53.5 MB 未打包），30 个 dependencies
- 依赖 `hono`, `execa`, `archiver`, `dotenv` 等，包含大量 sidecar 不需要的功能
- 新兴框架，API 不稳定（1235 个版本 = 频繁发布）
- 面向服务端应用而非嵌入式 agent runtime

**结论**：**不推荐**。包体过大，功能过多，不适合嵌入到 Bun standalone binary。

---

### 7. 直接使用 OpenAI SDK (openai) Tool Calling

| 维度 | 评估 |
|---|---|
| **版本** | 6.37.0 |
| **包大小** | 9.3 MB |
| **周下载量** | N/A (极高) |
| **多模型支持** | 仅 OpenAI API 格式（但可通过 baseURL 指向兼容端点） |
| **内置工具** | 无 |
| **Streaming** | 支持 |
| **Bun 兼容** | 兼容 |

**结论**：当前 direct.ts 已经是这种方式的手写版本。直接用 SDK 只是语法糖。

---

## Comparison Matrix

| Framework | 多模型 | 内置工具 | 包大小 | Streaming | 嵌入性 | 社区 | 推荐度 |
|---|---|---|---|---|---|---|---|
| claude-agent-sdk | Anthropic only | 12+ 高质量 | 4.5MB | Yes | 差(需 CLI) | 5.3M/w | -- |
| @openai/agents | 可扩展 | shell, patch | 5.4MB | Yes | 中 | 770K/w | B |
| @openai/codex | OpenAI only | shell, patch | 13KB(CLI) | Yes | 差(需 CLI) | 31M/w | -- |
| **Vercel AI SDK** | **20+ providers** | **无** | **6.6MB** | **Yes** | **好** | **13M/w** | **A** |
| LangChain.js | 多 | 少量 | 2.9MB+ | Yes | 差 | 2.1M/w | D |
| Mastra | 多(via AI SDK) | 抽象层 | 53.5MB | Yes | 差 | 960K/w | D |

---

## Recommended Approach

### Option A: Vercel AI SDK (最推荐)

**策略**: 用 AI SDK 替换 direct.ts 中的双协议 agentic loop，保留并增强现有手写工具。

```
依赖: ai + @ai-sdk/openai + @ai-sdk/anthropic + @ai-sdk/google
新增包大小: ~10MB (core + 3 providers)
改动范围: 仅 apps/sidecar/src/agent/direct.ts
```

具体做法：
1. 安装 `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`
2. 将现有 8 个工具转换为 AI SDK `tool()` 格式（工具实现代码不变）
3. 用 `generateText({ model, tools, maxSteps: 30 })` 替换手写的 agentic loop
4. 根据 `protocol` 参数选择不同的 provider（`openai()` / `anthropic()` / `google()`）
5. 消除 `runAnthropicAgent` vs `runOpenAIAgent` 的代码重复

**优势**: 最小改动，最大收益。工具实现不变，只替换 LLM 调用层和 agentic loop。

### Option B: @openai/agents-core (备选)

**策略**: 实现自定义 `ModelProvider` 桥接 Anthropic/Google API。

较高的实现成本，但获得更完整的 agent runtime（approval、guardrail、handoff）。适合未来需要 multi-agent 编排的场景。

### Option C: 保持手写 + 优化 (最保守)

**策略**: 保留当前手写架构，仅优化工具实现。

增加 streaming、并发工具执行、更好的 web_search（换用 Tavily/SearXNG），增加 diff/patch 编辑能力。不引入新框架依赖。

---

## Caveats / Not Found

1. **@anthropic-ai/agent-core** / **pi-agent-core**: 前者 npm 上不存在，后者仅为 placeholder 包（由 Armin Ronacher 保留的包名）
2. 未找到既支持多模型又内置文件操作工具的轻量级框架 — 这个组合目前不存在
3. AI SDK 虽无内置文件工具，但当前 direct.ts 的工具实现可以一对一迁移到 AI SDK 的 `tool()` 格式
4. Bun standalone binary 打包时，AI SDK 的 tree-shaking 效果未经实测，可能需要验证最终 binary 大小
5. AI SDK v6 (当前最新) 和 v7 (beta) 之间有 breaking changes，建议锁定 v6
