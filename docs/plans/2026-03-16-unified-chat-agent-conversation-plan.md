# Unified Chat Agent Conversation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 Chat 与 Agent 两套会话体系收敛为统一会话和统一时间线，让用户在同一会话里通过输入框底部菜单切换本轮执行模式。

**Architecture:** 先建立统一读模型和统一 UI，再收敛统一写路径。迁移过程中复用现有 `conversations/messages` 与 `agent_sessions/agent_events`，通过 adapter 把旧数据映射成统一会话与统一时间线，随后把新增写入全部切到统一会话模型。

**Tech Stack:** Next.js App Router；Zustand；Hono；Drizzle SQLite；流式 SSE；Claude Agent SDK。

---

### Task 1: 写入设计与迁移约束

**Files:**
- Create: `docs/plans/2026-03-16-unified-chat-agent-conversation-design.md`

**Step 1: 写入已确认设计**

- 记录统一会话模型、统一时间线、底部模式选择器、Agent 折叠执行记录、迁移分阶段策略。

**Step 2: Commit**

```bash
git add docs/plans/2026-03-16-unified-chat-agent-conversation-design.md
git commit -m "docs: add unified chat agent conversation design"
```

### Task 2: 定义统一会话与统一消息的数据结构

**Files:**
- Modify: `packages/db/src/schema/index.ts`
- Modify: `apps/server/src/db/bootstrap.ts`
- Create: `apps/server/src/services/unifiedConversationService.ts`
- Test: `apps/server/src/services/unifiedConversationService.test.ts`

**Step 1: 写失败测试**

- 覆盖统一会话字段与统一消息视图：
  - 会话默认 `defaultMode = agent`
  - 统一列表能同时返回 Chat conversation 与 Agent session
  - Agent 历史被映射成统一 timeline item

**Step 2: 实现最小 schema 扩展**

- 给 `conversations` 增加统一运行所需字段：
  - `workspaceId`
  - `defaultMode`
  - `lastMode`
  - `runStatus`
- 如有必要，为 Agent 附属运行记录新增表

**Step 3: 实现统一 adapter service**

- 提供：
  - `listUnifiedConversations(userId)`
  - `getUnifiedConversation(userId, conversationId)`
  - `getUnifiedTimeline(userId, conversationId)`
- 兼容读取旧 `agent_sessions / agent_events`

**Step 4: 跑测试**

Run: `pnpm --filter server test unifiedConversationService`

**Step 5: Commit**

```bash
git add packages/db/src/schema/index.ts apps/server/src/db/bootstrap.ts apps/server/src/services/unifiedConversationService.ts apps/server/src/services/unifiedConversationService.test.ts
git commit -m "feat(server): add unified conversation read model"
```

### Task 3: 提供统一会话 API

**Files:**
- Modify: `apps/server/src/routes/conversations.ts`
- Modify: `apps/server/src/routes/messages.ts`
- Modify: `apps/server/src/routes/agent.ts`
- Modify: `apps/server/src/lib/api.ts` if present on server side, otherwise skip
- Test: `apps/server/src/routes/conversations.unified.test.ts`
- Test: `apps/server/src/routes/messages.unified.test.ts`

**Step 1: 写失败测试**

- `GET /conversations` 返回统一列表项
- `GET /messages/:conversationId` 返回统一时间线
- 新建统一会话不再创建 `agent_session`

**Step 2: 实现统一读取**

- `conversations` 路由改用 `unifiedConversationService`
- 为列表项返回统一字段：
  - `lastMode`
  - `runStatus`
  - `workspaceId`
  - `isPinned`

**Step 3: 预留统一写入协议**

- `messages.post('/stream')` 接收 `mode`
- `mode = chat` 走现有聊天流
- `mode = agent` 委托统一 Agent 运行写入

**Step 4: 跑测试**

Run: `pnpm --filter server test conversations.unified messages.unified`

**Step 5: Commit**

```bash
git add apps/server/src/routes/conversations.ts apps/server/src/routes/messages.ts apps/server/src/routes/agent.ts apps/server/src/routes/conversations.unified.test.ts apps/server/src/routes/messages.unified.test.ts
git commit -m "feat(server): expose unified conversation APIs"
```

### Task 4: 收敛 Web store 为统一会话状态

**Files:**
- Create: `apps/web/src/stores/conversationStore.ts`
- Modify: `apps/web/src/stores/chatStore.ts`
- Modify: `apps/web/src/stores/agentStore.ts`
- Modify: `apps/web/src/lib/api.ts`
- Test: `apps/web/src/stores/conversationStore.test.ts`

**Step 1: 写失败测试**

- 统一 store 能管理：
  - 会话列表
  - 当前会话
  - 统一时间线
  - composer 当前模式
  - 运行状态

**Step 2: 实现统一 store**

- 新建 `conversationStore`
- 定义统一类型：
  - `UnifiedConversation`
  - `TimelineMessage`
  - `AgentRunSummary`
- 增加 `composerMode: 'chat' | 'agent'`
- 默认值设为 `agent`

**Step 3: 适配旧 store 依赖**

- 先让现有组件逐步读统一 store
- 在过渡阶段保留 `chatStore/agentStore` 但减少新职责

**Step 4: 跑测试**

Run: `pnpm --filter web test conversationStore`

**Step 5: Commit**

```bash
git add apps/web/src/stores/conversationStore.ts apps/web/src/stores/chatStore.ts apps/web/src/stores/agentStore.ts apps/web/src/lib/api.ts apps/web/src/stores/conversationStore.test.ts
git commit -m "feat(web): add unified conversation store"
```

### Task 5: 重做左侧栏为统一混合列表

**Files:**
- Modify: `apps/web/src/components/app/LeftSidebar.tsx`
- Create: `apps/web/src/components/conversation/ConversationAside.tsx`
- Modify: `apps/web/src/components/chat/ChatAside.tsx`
- Modify: `apps/web/src/components/agent/AgentSessionsAside.tsx`

**Step 1: 写最小 UI 验证**

- 统一列表显示 Chat 与 Agent 历史混合项
- 支持搜索、置顶、重命名、删除
- 会话项展示最近模式和运行状态

**Step 2: 实现统一列表组件**

- 抽出 `ConversationAside`
- `ChatAside` / `AgentSessionsAside` 只保留复用逻辑或删除
- `LeftSidebar` 不再显示 Chat / Agent 模式切换

**Step 3: 加入 Agent 置顶能力**

- 统一操作入口全部走 `isPinned`
- Agent 历史同样可置顶

**Step 4: 本地验证**

- 切换会话能立即显示对应时间线
- 置顶和搜索行为对所有会话生效

**Step 5: Commit**

```bash
git add apps/web/src/components/app/LeftSidebar.tsx apps/web/src/components/conversation/ConversationAside.tsx apps/web/src/components/chat/ChatAside.tsx apps/web/src/components/agent/AgentSessionsAside.tsx
git commit -m "feat(web): unify sidebar conversation list"
```

### Task 6: 合并中部页面为统一时间线

**Files:**
- Create: `apps/web/src/components/conversation/ConversationPage.tsx`
- Create: `apps/web/src/components/conversation/ConversationTimeline.tsx`
- Modify: `apps/web/src/components/ChatArea.tsx`
- Modify: `apps/web/src/app/(app)/chat/page.tsx`
- Modify: `apps/web/src/app/(app)/agent/page.tsx`

**Step 1: 写最小 UI 验证**

- 同一会话内能渲染普通消息和 Agent 折叠执行记录
- 旧 Chat 页面与旧 Agent 页面都改成复用统一页面或重定向

**Step 2: 实现统一时间线**

- 抽出统一消息渲染
- Agent 执行记录默认折叠
- 工具过程、日志和错误放到可展开区域

**Step 3: 精简双页面**

- `/chat` 与 `/agent` 过渡期都指向统一会话页面
- 移除页面级的产品分裂，不再各自维护独立时间线

**Step 4: 本地验证**

- 点击任意会话立即显示内容
- Agent 历史默认折叠过程

**Step 5: Commit**

```bash
git add apps/web/src/components/conversation/ConversationPage.tsx apps/web/src/components/conversation/ConversationTimeline.tsx apps/web/src/components/ChatArea.tsx apps/web/src/app/(app)/chat/page.tsx apps/web/src/app/(app)/agent/page.tsx
git commit -m "feat(web): render unified conversation timeline"
```

### Task 7: 在 composer 底栏加入执行模式切换

**Files:**
- Modify: `apps/web/src/components/composer/PromaComposer.tsx`
- Modify: `apps/web/src/components/chat/ChatComposerToolbar.tsx`
- Modify: `apps/web/src/components/conversation/ConversationPage.tsx`

**Step 1: 写最小交互验证**

- 默认模式是 `Agent`
- 用户切到 `Chat` 后，该选择会保留
- 切换会话不会自动覆盖手动选择

**Step 2: 实现模式选择器**

- 在 composer 底栏增加 `Chat / Agent` 切换控件
- 让 `ConversationPage` 把当前 `composerMode` 与 `onModeChange` 传给 `PromaComposer`

**Step 3: 本地验证**

- 同一会话中执行 `Agent -> Chat -> Agent`
- UI 行为符合用户手动选择

**Step 4: Commit**

```bash
git add apps/web/src/components/composer/PromaComposer.tsx apps/web/src/components/chat/ChatComposerToolbar.tsx apps/web/src/components/conversation/ConversationPage.tsx
git commit -m "feat(web): add composer execution mode switch"
```

### Task 8: 收敛统一发送链路

**Files:**
- Modify: `apps/web/src/lib/chat-stream.ts`
- Modify: `apps/web/src/components/conversation/ConversationPage.tsx`
- Modify: `apps/server/src/services/messageService.ts`
- Modify: `apps/server/src/services/agentService.ts`
- Test: `apps/server/src/services/messageService.unified-run.test.ts`

**Step 1: 写失败测试**

- `mode = chat` 时写入统一消息并走聊天流
- `mode = agent` 时写入统一消息并附带 Agent 执行记录

**Step 2: 实现统一提交协议**

- Web 端提交统一 payload：
  - `conversationId`
  - `mode`
  - `content`
  - `attachments`
  - `contextPaths`
  - `workspaceId`
- Server 根据 `mode` 分流执行，但统一落库

**Step 3: 跑测试**

Run: `pnpm --filter server test messageService.unified-run`

**Step 4: Commit**

```bash
git add apps/web/src/lib/chat-stream.ts apps/web/src/components/conversation/ConversationPage.tsx apps/server/src/services/messageService.ts apps/server/src/services/agentService.ts apps/server/src/services/messageService.unified-run.test.ts
git commit -m "feat: unify chat and agent send flow"
```

### Task 9: 回归和清理过渡代码

**Files:**
- Modify: `apps/web/src/components/app/AppShellLayout.tsx`
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/components/chat/ChatHeader.tsx`
- Modify: `apps/web/src/components/chat/ModelPickerModal.tsx`
- Modify: 任何仍强依赖双会话模型的残余文件

**Step 1: 运行针对性测试和 typecheck**

Run:
- `pnpm --filter server test`
- `pnpm --filter web test`
- `pnpm --filter web typecheck`

**Step 2: 手动回归**

- 新建统一会话后连续执行 `Agent -> Chat -> Agent`
- 左侧混合列表支持搜索、置顶、重命名、删除
- 点击会话立即显示统一时间线
- Agent 执行记录默认折叠，展开后查看过程
- 手动切到 `Chat` 后切换会话不回弹为 `Agent`

**Step 3: 清理遗留 UI**

- 首页不再强调 Chat / Agent 为两套入口
- 移除明显过时的页面文案和导航逻辑

**Step 4: Commit**

```bash
git add apps/web/src/components/app/AppShellLayout.tsx apps/web/src/app/page.tsx apps/web/src/components/chat/ChatHeader.tsx apps/web/src/components/chat/ModelPickerModal.tsx
git commit -m "refactor: clean up unified conversation UX"
```
