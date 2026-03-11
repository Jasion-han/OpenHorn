# Agent UI Revamp Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 重构 Agent 页面为“双栏主舞台时间线”布局，并保证任何长消息都不会横向撑宽挤压布局。

**Architecture:** 保持现有状态管理与 API 不变，仅重排页面布局、抽取可复用 UI 组件，并为事件内容区增加统一的“强制换行/断行”样式规范。

**Tech Stack:** Next.js 15, React 19, Mantine 7, Zustand 5

---

### Task 1: 盘点与确定改造边界

**Files:**
- Read: `apps/web/src/app/(app)/agent/page.tsx`
- Read: `apps/web/src/stores/agentStore.ts`
- Read: `apps/web/src/lib/agent-default-workspace.ts`

**Step 1: 确认不改后端/协议**
- 检查页面是否仅做 UI 重构，不触碰 SSE 事件类型与 run 逻辑。

**Step 2: 定义“长内容不撑宽”统一样式常量**
- 目标：在 text/tool_input/tool_output/error 中复用同一套 CSSProperties，避免重复实现。

**Step 3: 提交（仅计划确认，无代码变更）**
- 无需 commit。

---

### Task 2: 抽取 Agent 事件卡片为独立组件并加断行规范

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`
- Create: `apps/web/src/components/agent/AgentEventCard.tsx`
- Create: `apps/web/src/components/agent/agentTextStyles.ts`

**Step 1: 创建统一断行样式**

```ts
// apps/web/src/components/agent/agentTextStyles.ts
import type { CSSProperties } from 'react';

export const AGENT_WRAP_TEXT: CSSProperties = {
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  maxWidth: '100%',
};
```

**Step 2: 将 page 内的 AgentEventCard 搬到组件并复用样式**
- 对 `Text` 和 `pre` 内容应用 `AGENT_WRAP_TEXT`。
- 对 `pre` 外层容器确保不溢出父容器（必要时只让卡片内部横向滚动，而不是整列被撑开）。

**Step 3: 运行检查**
- Run: `pnpm --filter web lint`
- Expected: PASS
- Run: `pnpm --filter web typecheck`
- Expected: PASS

**Step 4: Commit**

```bash
git add apps/web/src/components/agent/AgentEventCard.tsx apps/web/src/components/agent/agentTextStyles.ts apps/web/src/app/'(app)'/agent/page.tsx
git commit -m "refactor(agent): extract event card and enforce wrapping"
```

---

### Task 3: 双栏主舞台布局重排（不改业务逻辑）

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`
- Create: `apps/web/src/components/agent/AgentSessionsPane.tsx`
- Create: `apps/web/src/components/agent/AgentMainPane.tsx`
- Create: `apps/web/src/components/agent/AgentComposer.tsx`

**Step 1: 左栏会话 Pane**
- 目标：标题/状态/菜单保持一行，标题 `truncate`，并确保 `min-width: 0` 生效。
- 新建会话输入框 placeholder 改为中文，右侧按钮更明确（“创建”或 icon+tooltip）。

**Step 2: 右栏主舞台 Pane**
- 顶部工具栏聚合：当前会话标题、状态、Workspace Select、刷新按钮。
- 中部时间线：使用 `ScrollArea` 填满高度。
- 底部 composer：固定在底部（使用 `Stack h="100%"` + `ScrollArea flex=1` + composer 不 flex）。

**Step 3: 空态与禁用原因**
- 未选择会话：右侧显示空态，引导去左侧选择或创建。
- 无 workspace：展示引导去 `/settings` 创建 workspace，并禁用运行相关控件（文案明确）。
- 运行中：输入与附件按钮禁用并显示 loader。

**Step 4: 运行检查**
- Run: `pnpm --filter web lint`
- Expected: PASS
- Run: `pnpm --filter web typecheck`
- Expected: PASS

**Step 5: 手工验收（本地）**
- 打开 `/agent`，创建会话并运行一次任务，观察事件流。
- 粘贴超长无空格字符串（例如长 token/URL）到 tool output 或 text 事件中，确认不会把布局撑宽。
- 缩放到移动端宽度，确认布局不出现横向滚动（除非在卡片内部 `pre` 容器选择性滚动）。

**Step 6: Commit**

```bash
git add apps/web/src/components/agent apps/web/src/app/'(app)'/agent/page.tsx
git commit -m "feat(agent): revamp agent page layout (two-column timeline)"
```

---

### Task 4: 文案与一致性收尾

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`
- Modify: `apps/web/src/components/agent/*.tsx`

**Step 1: 全中文文案**
- 替换残留英文：标题、placeholder、空态、按钮。

**Step 2: 视觉密度**
- 适当减少不必要的 `p="md"` 留白，提升信息密度但不拥挤（Mantine spacing 统一）。

**Step 3: 运行检查**
- Run: `pnpm --filter web lint`
- Expected: PASS
- Run: `pnpm --filter web typecheck`
- Expected: PASS

**Step 4: Commit**

```bash
git add apps/web/src/app/'(app)'/agent/page.tsx apps/web/src/components/agent
git commit -m "chore(agent): polish copy and spacing"
```

