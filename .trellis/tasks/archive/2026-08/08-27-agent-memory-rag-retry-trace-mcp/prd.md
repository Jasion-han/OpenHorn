# Agent 质量深度优化 PRD

## 背景
基于 2026-08-27 的五维度代码级审计，OpenHorn 的 agent 系统在 Memory、RAG、错误恢复、可观测性、Multi-Agent 五个维度存在系统性空白。本任务按优先级逐步实施改进。

## P0 — 必须做，不做会崩（第 1-2 周）

### P0-1: Token-aware 上下文窗口管理
**问题：** `buildChatMessages()` 取最近 200 条全量发送，无 token 计数。Sidecar 4 个 runtime 全部 string concat 注入历史。`contextLength` 字段从未被读取。长对话必爆 context window。

**方案：**
- 在 `messageService.ts` 的 `buildChatMessages()` 中加入 token 估算（字符数/4 作为简易估算）
- 根据模型 context window 动态截断（从 channel 配置或 model metadata 获取 maxTokens）
- 使 `conversations.contextLength` 字段真正生效作为 token 预算上限
- 对被截断的旧消息，调用 LLM 生成摘要作为 "conversation so far" 前缀

**涉及文件：**
- `apps/server/src/services/messageService.ts` (buildChatMessages)
- `packages/shared/src/types` (model metadata types)

### P0-2: Sidecar 历史注入结构化
**问题：** 4 个 runtime 都用 `"User: xxx\n\nAssistant: yyy"` string concat，浪费 token 且模型难以区分历史/当前。

**方案：**
- Direct runtime: 改为传 messages array 给 OpenAI/Anthropic/Google API
- Claude runtime: 利用 SDK 原生 messages 支持
- ACP/Codex: 评估是否可改为结构化

**涉及文件：**
- `apps/sidecar/src/agent/direct.ts` (conversationHistory 注入)
- `apps/sidecar/src/agent/claude.ts`
- `apps/sidecar/src/agent/acp.ts`
- `apps/sidecar/src/agent/codex.ts`
- `apps/desktop/src/hooks/useSidecarAgentRun.ts` (构建 conversationHistory)

### P0-3: 重试策略升级
**问题：** Adapters 层只有 1 次线性重试（500ms），`retryable` 标记从未被消费。三个 adapter 复制粘贴相同重试代码。

**方案：**
- 抽取 `withRetry(fn, options)` 到 `packages/adapters/src/retry.ts`
- 实现指数退避 + jitter + 可配置最大次数（默认 3 次）
- 对 429 读 `Retry-After` header
- 在 server 层消费 `providerErrorSummary` 的 `retryable` 标记

**涉及文件：**
- `packages/adapters/src/adapters.ts` (重试逻辑)
- `apps/server/src/services/providerErrorSummary.ts` (retryable 标记)

### P0-4: MCP 连接复用
**问题：** 每次 agent run 全量 connect/close 所有 MCP server，stdio server 有进程启动开销。

**方案：**
- 在 sidecar 层维护 per-workspace 的 MCP 连接池
- 连接池有 idle TTL，超时自动关闭
- agent run 结束后连接回池而不是关闭
- 健康检查失败时自动重连

**涉及文件：**
- `apps/sidecar/src/mcp-tools.ts` (connectMcpTools / cleanup)

## P1 — 显著提升体验（第 3-4 周）

### P1-1: Agent run 结构化 trace 持久化
### P1-2: 对话历史 FTS5 全文搜索
### P1-3: Checkpoint 扩展到 Direct 运行时
### P1-4: Token budget 上限

## P2 — 锦上添花（第 5-8 周）

### P2-1: 会话级摘要记忆 + 用户偏好学习
### P2-2: 文档 RAG（LanceDB + Embedding）
### P2-3: 基于意图的工具路由
### P2-4: Provider fallback + Circuit breaker

## 验收标准
- P0-1: 长对话（>200条）不会爆 context window，contextLength 字段生效
- P0-2: sidecar 历史注入为结构化 messages array
- P0-3: 429/502/503 错误自动指数退避重试，retryable 闭环
- P0-4: 连续两次 agent run 之间 MCP server 不重新 spawn
