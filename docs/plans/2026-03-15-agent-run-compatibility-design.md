# Agent Run Compatibility Guardrails Design

**Goal:** 修复 Agent 模式在渠道/模型组合不兼容 Claude Agent SDK 时“无回复/像卡住”的问题，让用户在运行前或运行时都能得到明确、可执行的错误提示。

## Problem

当前 Chat 与 Agent 走的是两条不同的运行链路：

- Chat 走通用对话适配器，对 OpenAI 兼容 relay 更宽容。
- Agent 走 Claude Agent SDK，要求渠道在运行语义上兼容 Anthropic Agent。

这导致一种常见误配会表现得很混乱：

- 用户把 OpenAI 兼容 relay 或混合代理配置成 `Anthropic` provider。
- 渠道模型列表里可能出现 `gpt-*` 等非 Claude 模型。
- Chat 仍然可用，但 Agent 在运行时可能长时间没有可见输出，用户感知为“没有回复”。

## Constraints

- 不自动修改用户渠道配置，不偷偷切换 Provider。
- 不把“Agent 可运行”简化成 `provider === 'anthropic'` 的静态判断，必须允许真实探测。
- 失败必须给出明确错误，优先复用已有 `agentCheck` 诊断逻辑。
- 保持现有 Agent 仅支持 Anthropic runtime 的产品边界，不引入 OpenAI Agent runtime。

## Approach

采用“前端预检 + 服务端兜底”的双层 guardrail：

1. Agent 页面在点击运行前，对当前会话实际使用的 `channelId + modelId` 发起一次 `agentCheck`。
2. Agent 模型选择器在保存会话模型前，也先做同样的 `agentCheck`。
3. 服务端 `POST /agent/sessions/:id/run` 在真正建立 SSE 运行前，再做一次最终兼容性检查。

这样可以同时解决两个问题：

- 避免用户保存明显错误的 Agent 会话组合。
- 避免前端绕过或旧状态残留时，服务端仍进入“运行中但无可见输出”的坏路径。

## UX

### 运行前

- 如果当前会话没有可用渠道/模型/Workspace，保持现有拦截逻辑。
- 如果当前组合的 `agentCheck` 失败：
  - 不发起 `/run`
  - 在 Agent 事件区插入一条 `error` 事件
  - 打开模型选择器，提示用户切换渠道/模型

### 模型选择

- 在 Agent 页面内通过 `ModelPickerModal` 切换模型时：
  - 先对候选组合执行 `agentCheck`
  - 成功才调用 `api.agent.updateChannel(...)`
  - 失败时弹出明确错误，不保存会话模型

### 错误文案

- 对“Anthropic provider 但 Base URL 更像 OpenAI 兼容接口”的情况，直接展示现有后端诊断文案。
- 不再使用“运行中”“无输出”这类模糊状态掩盖真实原因。

## Server Changes

- `apps/server/src/routes/agent.ts`
  - 在 `run` 路由里解析当前 session 实际使用的 `channelId + modelId`
  - 调用 `checkChannelAgentCompatibility(...)`
  - 失败时直接返回 `400` 文本错误，不建立 SSE 流

- 不改变 `runAgent(...)` 的核心流式实现，避免重复探测和不必要的运行时侵入。

## Web Changes

- `apps/web/src/app/(app)/agent/page.tsx`
  - 增加 Agent 运行前预检
  - 预检失败时插入错误事件并打开模型选择器

- `apps/web/src/components/chat/ModelPickerModal.tsx`
  - 支持一个可选的“选择前校验”钩子
  - Agent 页面传入该钩子，Chat 页面保持现状

## Testing

- Server：
  - 为 Agent `run` 路由新增兼容性失败路径测试，确认直接失败且不进入 SSE。
- Web：
  - 至少做 typecheck
  - 手动回归以下场景：
    - 兼容渠道：可正常运行
    - 不兼容 relay：运行前即报错，不再出现静默卡住
    - 在模型选择器里选到不兼容组合：不保存会话模型
