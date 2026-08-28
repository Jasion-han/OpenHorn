# Chat 模式统一到 Sidecar — 统一 Agent Loop + 工具集控制

## Goal

将桌面端 Chat 模式统一到 Sidecar 执行，与 Agent 模式共用同一套代码路径。Chat = "只读权限的 Agent"（tools=[只读], maxSteps=1），Agent = "完整权限"（tools=[全部], maxSteps=30）。Server 退化为纯数据层。

## Decisions (ADR-lite)

### D1: Adapter 代码复用方式
- **决定**: 抽成 shared package（`packages/adapters`）
- **理由**: Server 和 Sidecar 都依赖同一份代码，避免维护两份

### D2: Sidecar 不可用时的行为
- **决定**: Chat 和 Agent 统一禁用，不保留 Server fallback
- **理由**: 避免维护两套流式代码，保持架构一致性

### D3: Chat 与 Agent 的关系
- **决定**: 统一 Agent loop + 工具集/maxSteps 控制（行业标准做法）
- **理由**: Claude Code、Cursor、Windsurf、GitHub Copilot、ChatGPT 均采用此模式。ChatGPT 证明注册工具但不使用时零延迟损耗
- **实现**: 
  - Chat: `agent.run({ tools: [fs.read, fs.list, web_search], maxSteps: 1 })`
  - Agent: `agent.run({ tools: [fs.read, fs.list, fs.write, bash, web_search], maxSteps: 30 })`

### D4: 附件处理
- **决定**: Server prepare 接口返回已编码的完整消息数组
- **理由**: Sidecar 保持无状态执行引擎角色，不访问存储层

## Architecture

```
桌面端统一流程（Chat 和 Agent 共用）:

1. Desktop → Server POST /chat/prepare
   ← 返回: { apiKey, baseUrl, protocol, model, messages[], userMsgId, assistantMsgId }

2. Desktop → Sidecar WS agent.run({ ...preparedData, tools, maxSteps })
   ← 流式返回: AgentEvent (text_delta / tool_start / tool_result / done / error)

3. Desktop → Server POST /chat/complete
   → 提交: { assistantMsgId, content, model, citations? }
```

## Requirements

### Phase 1: 抽取 Adapter 为 shared package
- 将 `apps/server/src/agent-adapters.ts` 移至 `packages/adapters/`
- 保留 `createAdapter()`, `chatStream()`, `chat()` 等核心 API
- Server 和 Sidecar 都从 `"adapters"` workspace 包引入
- 工具调用相关逻辑（`ToolCallingAdapter` 等）一并迁移

### Phase 2: Server 新增数据层接口
- `POST /chat/prepare`:
  - 验证用户身份
  - 创建 user message (DB INSERT)
  - 创建空 assistant message (DB INSERT)
  - 解密 Channel API Key
  - 加载对话历史消息
  - 处理附件（base64 编码）
  - 返回完整的 prepared data（含凭证、历史消息、新消息 ID）
- `POST /chat/complete`:
  - 接收 assistantMessageId + 最终 content
  - 更新 assistant message (DB UPDATE)
  - 更新 conversation metadata (updatedAt, lastMode)
  - 可选: citations、model

### Phase 3: Sidecar 统一执行引擎
- `agent.run` RPC 支持新参数：
  - `tools: string[]` — 可用工具列表
  - `maxSteps: number` — 最大迭代轮数
  - `messages: ChatMessage[]` — 预构建的消息数组（含附件）
- 内部路由逻辑：
  - Claude 模型 → Claude Agent SDK（带工具过滤）
  - 非 Claude 模型 → 使用 shared adapters package 流式调用
- 根据 tools 列表动态注册/限制工���能力
- 根据 maxSteps 控制循环次数

### Phase 4: Desktop 前端统一
- 移除 `chatAdapter.ts` 中 Server 直连流式逻辑
- Chat 和 Agent 统一走 Sidecar WebSocket：
  1. 调 `serverApi.chat.prepare()` 获取数据
  2. 调 `sidecarClient.agentRun()` 流式执行
  3. 调 `serverApi.chat.complete()` 持久化结果
- Sidecar 未就绪时统一禁用 Chat 和 Agent（复用现有 Agent 的禁用提示逻辑）
- 移除 `DesktopChatArea.tsx` 中 Chat/Agent 的分支判断

## Acceptance Criteria

- [ ] `packages/adapters` 正确导出，Server 和 Sidecar 均可引用
- [ ] Server typecheck 和现有测试通过（adapter 引用路径变更后）
- [ ] `POST /chat/prepare` 正确返回凭证 + 历史 + 附件编码
- [ ] `POST /chat/complete` 正确写入 DB
- [ ] Sidecar `agent.run` 支持 tools/maxSteps 参数
- [ ] Chat 消息通过 Sidecar 流式返回文本
- [ ] Agent 消息仍正常工作（无回归）
- [ ] 支持 OpenAI / Anthropic / Google 三协议
- [ ] 附件（图片）能通过 prepare → Sidecar → LLM 正确传递
- [ ] Sidecar 未启动时 Chat 和 Agent 统一显示禁用提示
- [ ] 流式过程中可中断（abort）

## Definition of Done

- Tests added/updated (unit/integration where appropriate)
- Lint / typecheck / CI green
- Desktop 实际测试：纯文本 Chat、带图片 Chat、Agent 均正常
- 旧的 Server 直连 Chat 流式路径标记为 deprecated（Web 端仍用）

## Out of Scope

- Web 端（apps/web）改动——仍走 Server 直连
- Server 旧 `/messages/stream` 路由删除（Web 端依赖，仅标记 deprecated）
- 本地模型（Ollama）接入——未来任务
- Live Context / 搜索路由分类优化——未来任务
- Sidecar checkpoint/rollback 对 Chat 的适配——Chat 无写操作不需要

## Technical Notes

### 关键文件变更
- `apps/server/src/agent-adapters.ts` → `packages/adapters/src/index.ts`
- `apps/server/src/services/messageService.ts` — 提取 prepare/complete 逻辑
- `apps/server/src/routes/messages.ts` — 新增 prepare/complete 路由
- `apps/sidecar/src/index.ts` — agent.run 参数扩展
- `apps/sidecar/src/agent/` — 工具过滤 + maxSteps 控制
- `apps/desktop/src/lib/chatAdapter.ts` — 重构为 Sidecar 路径
- `apps/desktop/src/components/chat/DesktopChatArea.tsx` — 移除 Chat/Agent 分支

### 已有可复用基础设施
- Server 的 `/messages/sync-sidecar` 端点（Agent 回写逻辑，complete 可参考）
- `ChatStreamEvent` 类型已统一定义
- Sidecar `agent.run` 已有成熟的事件推送机制
- `useSidecarAgentRun` hook 可扩展为 Chat 也使用

### 风险点
- adapter 抽包后 Bun 的 workspace 解析是否正常
- Claude Agent SDK 的 tools 过滤 API 是否支持动态限制
- WebSocket 传输大图 base64 的帧大小限制（prepare 走 HTTP 可规避）

## Research References

- [`research/industry-chat-agent-architecture.md`](research/industry-chat-agent-architecture.md) — 行业产品架构调研：所有成熟产品均采用统一 Agent loop + 工具集控制
