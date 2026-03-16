# Agent Stream Tail Glow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Agent 流式输出阶段只给最新增长的尾部文本加一次淡流光，历史文本保持静态，且在消息完成后恢复为普通 Markdown 展示。

**Architecture:** 在 `agentStore` 的本地 `text` 事件上追加 `streamTail` 和 `streamPulseKey` 元数据；Agent 流式阶段使用“稳定文本 + 尾部文本”双段渲染；CSS 只作用于尾部文本，且遵守 reduced-motion。

**Tech Stack:** Next.js App Router；React；Zustand；CSS Modules；Tailwind utility classes。

---

### Task 1: 写设计文档

**Files:**
- Create: `docs/plans/2026-03-16-agent-stream-tail-glow-design.md`

**Step 1: 记录视觉目标、状态结构、渲染规则和验证方式**

**Step 2: Commit**

```bash
git add docs/plans/2026-03-16-agent-stream-tail-glow-design.md
git commit -m "docs: add agent stream tail glow design"
```

### Task 2: 本地事件状态支持最新尾部跟踪

**Files:**
- Modify: `apps/web/src/stores/agentStore.ts`

**Step 1: 扩展本地 `AgentEvent`**

- 增加 `streamTail?: string`
- 增加 `streamPulseKey?: number`

**Step 2: 更新 `addEvent` 合并逻辑**

- 当新的 `text` delta 进入且最后一条也是 `text` 时：
  - 把 delta 追加到 `content`
  - 把本次 delta 写入 `streamTail`
  - 递增 `streamPulseKey`

**Step 3: Commit**

```bash
git add apps/web/src/stores/agentStore.ts
git commit -m "feat(web): track agent stream tail metadata"
```

### Task 3: Agent 消息渲染

**Files:**
- Modify: `apps/web/src/components/agent/AgentEventCard.tsx`
- Modify: `apps/web/src/components/ui/markdown.module.css`

**Step 1: streaming 阶段拆分稳定文本与尾部文本**

- 没文本时继续显示 `TypingIndicator`
- streaming 且有文本时：
  - 历史文本用普通静态文本渲染
  - `streamTail` 用专门的 glow class 渲染
- 非 streaming 时恢复现有 `MarkdownMessage`

**Step 2: 添加 CSS 动画**

- 只给尾部文本做一次 500-700ms 的淡扫光
- 添加 `prefers-reduced-motion` 退化

**Step 3: Commit**

```bash
git add apps/web/src/components/agent/AgentEventCard.tsx apps/web/src/components/ui/markdown.module.css
git commit -m "fix(web): add agent streaming tail glow effect"
```

### Task 4: 验证

**Files:**
- (none)

**Step 1: 运行**

Run: `pnpm --filter web typecheck`

**Step 2: 手动回归**

- 三个点仍保留在“无文本”阶段
- 首个字出现后不再显示三个点
- 只有最新尾部片段有淡流光
- 流式结束后恢复 Markdown 展示
