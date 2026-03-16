# Agent Streaming Placeholder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Agent 的等待态和 Chat 一样锚定在当前 assistant 占位消息上，修复等待气泡出现在上一轮内容附近的问题。

**Architecture:** 在 Agent 本地事件流里追加一个空的 `text` 占位事件；`AgentEventCard` 识别“空文本 + streaming”并显示等待指示器；页面级全局等待节点移除。

**Tech Stack:** Next.js App Router；React；Zustand；Tailwind UI 组件。

---

### Task 1: 写设计文档

**Files:**
- Create: `docs/plans/2026-03-16-agent-streaming-placeholder-design.md`

**Step 1: 记录问题、方案、约束与验证方式**

**Step 2: Commit**

```bash
git add docs/plans/2026-03-16-agent-streaming-placeholder-design.md
git commit -m "docs: add agent streaming placeholder design"
```

### Task 2: Agent 时间线改成占位事件模式

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`

**Step 1: 在本地 user 事件后追加空 `text` 占位事件**

- 仅在本轮真正开始运行时追加
- 继续复用现有 `addEvent` 文本合并逻辑

**Step 2: 移除页面级全局等待 indicator**

- 不再使用 `isRunning && !isStreamingText` 的列表外 fallback

**Step 3: Commit**

```bash
git add apps/web/src/app/(app)/agent/page.tsx
git commit -m "fix(web): anchor agent typing indicator to current turn"
```

### Task 3: 占位事件渲染

**Files:**
- Modify: `apps/web/src/components/agent/AgentEventCard.tsx`

**Step 1: 识别空文本占位**

- `text + isStreaming + empty content` 只显示 `TypingIndicator`
- 有文本后恢复现有消息气泡样式

**Step 2: Commit**

```bash
git add apps/web/src/components/agent/AgentEventCard.tsx
git commit -m "fix(web): render agent streaming placeholder like chat"
```

### Task 4: 验证

**Files:**
- (none)

**Step 1: 运行**

Run: `pnpm --filter web typecheck`

**Step 2: 手动回归**

- 第一轮和第二轮等待气泡都紧跟当前 user 消息
- 首个 delta 到达后占位消息平滑转为文本消息
