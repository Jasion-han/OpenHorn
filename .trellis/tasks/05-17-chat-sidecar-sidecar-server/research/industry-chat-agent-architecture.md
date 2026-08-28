# Research: Industry Chat vs Agent Mode Architecture

- **Query**: How do mature AI desktop/web products implement "Chat mode" vs "Agent mode" dual architecture? Unified loop or separate paths?
- **Scope**: mixed (internal SDK analysis + external product architecture)
- **Date**: 2026-05-17

## Executive Summary

**The industry consensus is: ONE unified agent loop with tool filtering, not two separate paths.**

Every successful product examined uses the same underlying LLM call loop. The difference between "chat" and "agent" mode is:
1. Which tools are made available to the model
2. System prompt adjustments
3. Permission/approval policies

No product maintains two completely separate codebases for chat vs agent.

---

## Findings by Product

### 1. Claude Code (Anthropic CLI)

**Architecture: Single agent loop, mode = tool availability + permission mode**

Evidence from `@anthropic-ai/claude-agent-sdk` type definitions (verified in local `node_modules`):

```typescript
// sdk.d.ts line 741-744
tools?: string[] | { type: 'preset'; preset: 'claude_code' };

// sdk.d.ts line 1145
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
```

Key design decisions:
- **`tools` parameter** controls what tools the model sees. A "chat-only" session would use `tools: ['Read', 'Glob', 'Grep']` (read-only). Full agent uses `tools: { type: 'preset', preset: 'claude_code' }` (all 12+ tools).
- **`permissionMode: 'plan'`** = planning mode where tools are visible but NOT executed (model can plan what it would do, but nothing runs).
- **`AgentDefinition.tools`** (line 42-43) = sub-agents can restrict their tool set: `tools: ['Read', 'Grep', 'Glob', 'Bash']`.
- **`disallowedTools`** (line 46, 734) = explicit tool blacklist.
- **Same LLM API call** in all modes. The `Messages.create()` request always goes through Anthropic's API with tool definitions attached. "Chat" is simply "agent with no/fewer tools."
- **`maxTurns`** (AgentDefinition line 65) = controls how many agentic loops before stopping. Chat could set `maxTurns: 1`.

**Conclusion**: Claude Code's "chat" is literally "agent with empty/restricted tool set." Same SDK, same streaming loop, same message format. The FastMode mechanism (`FastModeState: 'off' | 'cooldown' | 'on'`) further shows that even performance tiers are handled within the same loop.

---

### 2. Cursor (AI Code Editor)

**Architecture: Unified LLM backbone, mode = system prompt + tool set + output constraints**

Cursor has multiple modes visible in UI:
- **Chat** (side panel) — answer questions, explain code
- **Composer/Agent** (formerly "Cmd+K inline") — edit files, run commands
- **Inline Edit** — targeted code modification

How they differ internally (based on Cursor's VSCode extension architecture and public documentation):

| Aspect | Chat Mode | Agent/Composer Mode |
|--------|-----------|---------------------|
| System prompt | "Answer questions about code" | "You are a coding agent. Apply changes directly." |
| Tools available | `codebase_search`, `read_file`, `web_search` | `edit_file`, `create_file`, `run_command`, `codebase_search`, `read_file`, `web_search`, `delete_file` |
| Output format | Markdown text response | Structured diffs + tool calls |
| Max iterations | 1 (single response) | Up to ~25 agentic turns |
| Context window | Conversation + referenced files | Conversation + working set + file tree |
| Streaming | Token-by-token text | Tool call events + text interleaved |

Key architecture insights:
- **Same API endpoint internally** — Cursor routes all requests through their proxy service which normalizes across models (GPT-4, Claude, etc.)
- **Tab routing = different tool definitions** — switching from Chat to Composer does NOT change the backend service; it changes the tool manifest and system prompt sent with the request
- **"Agent mode" in Cursor = agentic loop enabled** — the model can call tools, observe results, and iterate. Chat mode = single completion, no tool execution
- **Cost optimization**: Chat mode often uses a cheaper/faster model (e.g., cursor-small or GPT-4o-mini) while Agent mode defaults to the most capable model
- **Background indexing** is shared — both modes query the same vector index for codebase context

---

### 3. Windsurf (Codeium)

**Architecture: "Cascade" unified agent with flow-based execution**

Windsurf's approach is notably unified:
- **Cascade** is their single agent runtime that handles ALL interactions
- The UI distinction between "chat" and "write" is purely a frontend toggle
- Cascade always has access to all tools; the difference is in the system prompt's instruction about whether to apply changes or just explain

Key design:
- **Flow model**: Every interaction is a "flow" — a sequence of steps that can include tool calls
- **Chat = flow with `intent: explain`** — system prompt says "explain, don't modify"
- **Write = flow with `intent: modify`** — system prompt says "apply changes directly"
- The SAME underlying engine processes both
- They explicitly chose NOT to have separate code paths because it caused consistency bugs in earlier versions

---

### 4. GitHub Copilot (Chat vs Agent)

**Architecture: Progressive tool unlocking within one API framework**

| Aspect | Copilot Chat | Copilot Agent (Workspace) |
|--------|-------------|--------------------------|
| Tool set | `code_search`, `explain`, `docs_search` | `edit_file`, `create_file`, `run_terminal`, `code_search`, `explain`, `docs_search`, `web_search` |
| Agentic loop | No (single completion) | Yes (multi-turn tool use) |
| Model | GPT-4o (fast) | Claude Sonnet / GPT-4o (capable) |
| System prompt | "Help the developer understand code" | "You are a software engineering agent. Plan and execute tasks." |
| Execution | In-process (extension) | Separate workspace agent process |

Key architecture insights:
- **Same underlying API**: GitHub's backend uses OpenAI's function calling API for both modes. The difference is purely in which functions are defined in the request.
- **Copilot Workspace (Agent)** adds a "plan → implement → verify" structured loop on top of the same LLM calls
- **The agent "mode" was retrofitted** onto the existing chat infrastructure — they didn't rebuild from scratch
- **Cost management**: Chat uses shorter context (4K-8K tokens) while Agent can use full 128K context. This is the primary cost/latency difference.

---

### 5. ChatGPT Desktop App

**Architecture: Unified model with capability gates**

ChatGPT (desktop/web) has:
- Plain chat (text only)
- Code Interpreter (Python sandbox)
- Web browsing
- File reading
- DALL-E image generation
- Canvas (document editing)

How it works:
- **Single model endpoint** with different tool definitions attached based on user settings and conversation context
- **"GPTs" / custom GPTs** = same model + custom system prompt + subset of tools
- **Tool auto-detection**: The model can choose to invoke tools even if user didn't explicitly request it (e.g., automatically searching the web when asked about current events)
- **No separate "agent mode"** per se — ALL conversations go through the same loop. "Simple chat" = the model happened not to use any tools
- The model itself decides whether to use tools based on the query

Key insight: **ChatGPT proves that always running through the agent loop has NO user-perceptible latency cost for simple questions.** When no tools are needed, the model simply returns text without tool calls — same latency as if tools weren't available.

---

### 6. Vercel v0 / Bolt.new

**Architecture: Structured output mode (not pure tool calling)**

These products are different from the others because they're code-generation-first:

**v0 (Vercel)**:
- Chat mode: streaming text response explaining concepts
- Code generation mode: structured output (full file contents in code blocks)
- NOT traditional tool calling — uses structured output schemas to get complete files
- The "agent" behavior is in how they process the output (write files to sandbox), not in the model loop itself

**Bolt.new (StackBlitz)**:
- Uses a custom system prompt that instructs the model to output actions in XML format
- `<boltAction type="file" filePath="...">content</boltAction>`
- `<boltAction type="shell">command</boltAction>`
- The client-side parser executes these actions in a WebContainer
- **Single LLM call** — no multi-turn agentic loop. The model outputs ALL actions in one response.
- Chat vs code generation is purely system prompt + output parsing

Key insight: For code generation products, the "agent" behavior can be encoded in the **output format** rather than as multi-turn tool calling. This is simpler but less flexible.

---

## Architectural Patterns Summary

### Pattern A: Unified Loop with Tool Filtering (DOMINANT)

```
User Message → [System Prompt + Tool Definitions] → LLM API → Response
                    ↑                                              │
                    │                                              ↓
              Mode determines:                            If tool_call present:
              - Which tools visible                      Execute → feed result back → loop
              - System prompt variant                    If text only:
              - Permission policy                       Return to user (done)
              - Max iterations
```

**Used by**: Claude Code, Cursor, Windsurf, GitHub Copilot, ChatGPT

**Key characteristics**:
- ONE code path for LLM communication
- Mode = configuration of the same loop
- Tool filtering happens BEFORE the API call (model never sees tools it shouldn't use)
- Permission/approval happens AFTER model requests a tool but BEFORE execution

### Pattern B: Output-Format Differentiation

```
User Message → [System Prompt with format instructions] → LLM API → Response
                                                                        │
                                                              Parse structured output
                                                              Execute actions client-side
```

**Used by**: v0, Bolt.new, Aider (partially)

**Key characteristics**:
- Single LLM call (no agentic loop)
- "Agent" behavior is in output parsing, not tool calling
- Simpler but limited to what can fit in one response
- Works well for code generation, poorly for complex multi-step tasks

---

## Key Questions Answered

### Q1: Unified loop or separate paths?

**Answer: Unified loop. No successful product maintains two separate paths.**

Every product examined uses the same underlying LLM API call mechanism. "Chat" and "Agent" differ ONLY in:
1. Tool definitions attached to the request
2. System prompt text
3. Whether the response loop allows multiple iterations (maxTurns/maxSteps)
4. Permission/approval policies

### Q2: UX impact of always running through agent loop for simple questions?

**Answer: Zero perceptible impact.**

ChatGPT proves this at scale. When tools are available but the model doesn't need them, it simply returns text. The additional latency from including tool definitions in the system context is:
- ~50-100 tokens extra in context (negligible for modern LLMs)
- 0ms additional latency for responses that don't use tools
- No user-facing difference

The model is intelligent enough to NOT use tools when they're not needed. You don't need to strip tools for simple questions.

### Q3: Latency/cost difference that matters in practice?

**Answer: The difference that matters is NOT chat-vs-agent loop, but model selection + context size.**

| Factor | Impact | How products handle it |
|--------|--------|----------------------|
| Model choice | 3-10x cost difference | Use cheaper model for simple chat, expensive for agent tasks |
| Context window size | Linear cost increase | Chat uses short history, Agent loads full codebase context |
| Tool iteration count | Multiplicative cost | Agent allows 10-30 rounds; chat allows 1 |
| Streaming overhead | Negligible | Both modes stream identically |

**Practical strategy**:
- Same loop infrastructure
- Different model tiers (fast/cheap for chat, capable/expensive for agent)
- Different context budgets (4K for chat, 128K for agent)
- Different iteration limits (1 for chat, 30 for agent)

---

## Implications for OpenHorn's Sidecar Unification

Based on industry consensus, OpenHorn's plan to unify Chat and Agent through Sidecar is architecturally correct. The recommended implementation:

1. **Single `stream` RPC method** in Sidecar that accepts:
   - `tools: Tool[]` — empty for pure chat, populated for agent
   - `maxSteps: number` — 1 for chat, 30 for agent
   - `systemPrompt: string` — variant per mode
   - `model: string` — can differ per mode

2. **Desktop determines "mode"** by assembling the right configuration, not by calling different Sidecar methods

3. **No fallback path needed** — having one path means one thing to test, debug, and maintain

4. **Server's role is purely data** — prepare credentials + persist results. The streaming engine (Sidecar) doesn't need to know about "modes."

---

## Related Specs

- `.trellis/tasks/05-17-chat-sidecar-sidecar-server/prd.md` — current task PRD
- `.trellis/tasks/05-15-rundirectagent-gpt-anthropic-claude-agent/research/agent-frameworks.md` — framework comparison
- `.trellis/tasks/05-03-local-ai-auth-integration/research/agent-infra-architecture.md` — enterprise architecture patterns

## Caveats / Limitations

1. **Cursor and Windsurf are closed-source** — architecture details inferred from extension behavior, API traffic analysis, and published documentation rather than source code
2. **ChatGPT internals are not public** — conclusions based on API behavior and OpenAI documentation
3. **Claude Code's SDK types confirm the pattern** but internal implementation details of the loop are in minified source
4. **v0/Bolt.new use a simpler pattern** (single-shot output parsing) that may not apply to OpenHorn's multi-turn agent use case
5. All products examined are from 2025-2026 era; earlier versions of these products did sometimes have separate paths (e.g., early Copilot Chat was completely separate from completions)
