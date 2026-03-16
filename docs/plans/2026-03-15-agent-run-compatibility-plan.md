# Agent Run Compatibility Guardrails Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Agent 页面和服务端运行入口增加真实兼容性校验，避免不兼容的渠道/模型组合进入“提交后无回复”的坏状态。

**Architecture:** 复用既有 `agentCheck` 诊断接口。Web 在运行前和模型选择前做预检；Server 在 `POST /agent/sessions/:id/run` 建立 SSE 前做最终兜底。失败时返回明确错误，不自动修改用户配置。

**Tech Stack:** Next.js App Router；Zustand；Hono；Bun test；Claude Agent SDK 兼容性探测服务。

---

### Task 1: 写设计文档

**Files:**
- Create: `docs/plans/2026-03-15-agent-run-compatibility-design.md`

**Step 1: 写入已确认设计**

- 记录问题背景、约束、双层 guardrail 方案、受影响文件和验证方式。

**Step 2: Commit**

```bash
git add docs/plans/2026-03-15-agent-run-compatibility-design.md
git commit -m "docs: add agent run compatibility design"
```

### Task 2: 服务端运行前兜底检查

**Files:**
- Modify: `apps/server/src/routes/agent.ts`
- Test: `apps/server/src/routes/agent.run.test.ts` 或现有路由测试文件

**Step 1: 写失败测试**

- 构造一个 `provider = anthropic` 但 `checkChannelAgentCompatibility` 返回失败的场景。
- 断言 `POST /agent/sessions/:id/run` 直接返回 `400` 文本错误，不返回 SSE。

**Step 2: 实现最小改动**

- 在 run 路由里计算实际使用的 channel/model
- 调用 `checkChannelAgentCompatibility(...)`
- 失败则直接 `return c.text(error, 400)`

**Step 3: 跑测试**

Run: `pnpm --filter server test -- --runInBand` 或项目内已有等价命令

**Step 4: Commit**

```bash
git add apps/server/src/routes/agent.ts apps/server/src/routes/agent.run.test.ts
git commit -m "fix(server): guard agent run with compatibility check"
```

### Task 3: Agent 页面运行前预检

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`

**Step 1: 写最小实现**

- 提取当前会话有效 `channelId + modelId`
- 在 `handleRun` / `runAgentPrompt` 实际提交前调用 `api.channels.agentCheck(...)`
- 失败时：
  - `addEvent({ type: 'error', ... })`
  - `setModelPickerOpen(true)`
  - 不调用 `api.agent.runSession(...)`

**Step 2: 本地验证**

- 兼容渠道时仍能正常提交
- 不兼容渠道时即时报错且不进入 running

**Step 3: Commit**

```bash
git add apps/web/src/app/(app)/agent/page.tsx
git commit -m "fix(web): preflight agent runs with compatibility check"
```

### Task 4: Agent 模型选择前预检

**Files:**
- Modify: `apps/web/src/components/chat/ModelPickerModal.tsx`
- Modify: `apps/web/src/app/(app)/agent/page.tsx`

**Step 1: 扩展选择器接口**

- 增加可选 `beforeSelect(channelId, modelId)` 钩子
- 返回成功才执行真正保存

**Step 2: Agent 页面接入**

- 传入 `beforeSelect`
- 失败时 toast 报错，不更新当前 session

**Step 3: Commit**

```bash
git add apps/web/src/components/chat/ModelPickerModal.tsx apps/web/src/app/(app)/agent/page.tsx
git commit -m "fix(web): validate agent model selection before save"
```

### Task 5: 验证

**Files:**
- (none)

**Step 1: 运行针对性测试和 typecheck**

Run:
- `pnpm --filter server test`
- `pnpm --filter web typecheck` 或仓库内等价命令

**Step 2: 手动回归**

- Agent 兼容组合正常运行
- `Anthropic + OpenAI relay` 组合在运行前直接失败
- 模型选择器不再允许保存不兼容组合
