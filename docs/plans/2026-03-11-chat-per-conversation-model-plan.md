# Chat Per-Conversation Model (Proma-like) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 对标 Proma 的 Chat 主路径体验：会话侧栏（置顶+分组+菜单）、ChatHeader 模型选择，并实现“全局默认 + 按对话覆盖”的模型选择与持久化。

**Architecture:** 后端以“对话覆盖优先、全局默认兜底”的规则解析运行时模型；前端在 ChatHeader 提供模型选择弹窗并写入对话，ChatAside 做信息组织与会话管理；通知/确认弹窗统一用 Mantine Providers，移除 `alert/confirm`。

**Tech Stack:** Next.js App Router, Mantine, Zustand, Hono, Drizzle ORM (SQLite), Bun.

---

### Task 1: 去重 DB Schema 引用（Server 改用 workspace `db` 包）

目的：避免 `apps/server/src/schema.ts` 与 `packages/db/src/schema/index.ts` 双份定义带来的重复修改与漂移风险。本任务完成后，后续所有 DB schema 只改 `packages/db` 一处。

**Files:**
- Modify: `apps/server/src/db/index.ts`
- Modify: `apps/server/src/services/*.ts`（所有 `../schema` 引用）
- Delete: `apps/server/src/schema.ts`（若确认无引用）

**Step 1: 写一个会失败的 smoke test（验证 schema 入口存在）**

Create: `apps/server/src/db/schema-import.test.ts`

```ts
import { test, expect } from "bun:test";
import * as schema from "db";

test("server imports schema from workspace db package", () => {
  expect(schema.users).toBeTruthy();
  expect(schema.conversations).toBeTruthy();
});
```

**Step 2: 运行确保失败**

Run: `cd apps/server && bun test src/db/schema-import.test.ts`  
Expected: FAIL（当前 server 还没改为从 `db` 包导入，或路径未统一）

**Step 3: 最小实现**

1. 将 `apps/server/src/db/index.ts` 改为：

```ts
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "db";

const client = createClient({
  url: process.env.DATABASE_URL || "file:./data/openhorn.db",
});

export const db = drizzle(client, { schema });
```

2. 把所有 `import { ... } from '../schema'` 改为 `import { ... } from 'db'`。

**Step 4: 运行确保通过**

Run: `cd apps/server && bun test src/db/schema-import.test.ts`  
Expected: PASS

**Step 5: 手动验证**

Run: `cd apps/server && bun run typecheck`  
Expected: PASS

**Step 6: Commit（占位）**

```bash
git add apps/server/src/db/index.ts apps/server/src/db/schema-import.test.ts apps/server/src/services
git commit -m "refactor(server): use shared db schema package"
```

---

### Task 2: 增加 conversations.modelId 字段并 push DB

**Files:**
- Modify: `packages/db/src/schema/index.ts`

**Step 1: 写一个失败测试（纯类型/存在性检查）**

Create: `packages/db/src/schema/conversations-modelId.check.ts`

```ts
import { conversations } from "./index";

// @ts-expect-error - modelId not present yet
conversations.modelId;
```

**Step 2: 运行确保失败**

Run: `cd packages/db && node src/schema/conversations-modelId.check.ts`  
Expected: FAIL（或 TS 报错）

**Step 3: 最小实现（加字段）**

在 `conversations` 表里新增：

```ts
modelId: text("model_id"),
```

（nullable 即可）

**Step 4: 运行 check 通过**

Run: `cd packages/db && node src/schema/conversations-modelId.check.ts`  
Expected: PASS

**Step 5: push 数据库**

Run（优先其一即可）:
- `cd /Users/han/Project/OpenHorn && bunx drizzle-kit push --config drizzle.config.ts`
- 若你习惯 pnpm：`cd /Users/han/Project/OpenHorn && pnpm --filter server db:push`

Expected: drizzle 输出包含对 `conversations` 增加 `model_id` 的变更。

**Step 6: Commit（占位）**

```bash
git add packages/db/src/schema/index.ts
git commit -m "feat(db): add conversations.modelId"
```

---

### Task 3: 扩展 Conversation API（create/update 支持 channelId+modelId）

**Files:**
- Modify: `apps/server/src/services/conversationService.ts`
- Modify: `apps/server/src/routes/conversations.ts`

**Step 1: 写失败测试（规范化输入）**

Create: `apps/server/src/services/conversationService.model.test.ts`

```ts
import { test, expect } from "bun:test";
import { normalizeConversationModelInput } from "./conversationService";

test("normalizeConversationModelInput keeps both channelId+modelId or strips both", () => {
  expect(normalizeConversationModelInput({ channelId: "c", modelId: "m" })).toEqual({ channelId: "c", modelId: "m" });
  expect(normalizeConversationModelInput({ channelId: "c" })).toEqual({ channelId: null, modelId: null });
  expect(normalizeConversationModelInput({ modelId: "m" })).toEqual({ channelId: null, modelId: null });
  expect(normalizeConversationModelInput({})).toEqual({ channelId: null, modelId: null });
});
```

**Step 2: 运行确保失败**

Run: `cd apps/server && bun test src/services/conversationService.model.test.ts`  
Expected: FAIL（缺少 export）

**Step 3: 最小实现**

在 `conversationService.ts` 增加：

```ts
export function normalizeConversationModelInput(input: { channelId?: string; modelId?: string }) {
  if (input.channelId && input.modelId) return { channelId: input.channelId, modelId: input.modelId };
  return { channelId: null, modelId: null };
}
```

并在：
- `createConversation()` insert values 写入 `channelId/modelId`
- `updateConversation()` 允许更新 `channelId/modelId`（注意要成对更新）

`routes/conversations.ts` 中：
- `POST` body 校验允许 `modelId`
- `PUT` body 校验允许 `channelId/modelId`

**Step 4: 运行测试通过**

Run: `cd apps/server && bun test src/services/conversationService.model.test.ts`  
Expected: PASS

**Step 5: Commit（占位）**

```bash
git add apps/server/src/services/conversationService.ts apps/server/src/routes/conversations.ts apps/server/src/services/conversationService.model.test.ts
git commit -m "feat(server): persist per-conversation channel+model"
```

---

### Task 4: 实现“对话覆盖优先 + 默认兜底”的运行时模型解析

**Files:**
- Modify: `apps/server/src/services/channelService.ts`
- Modify: `apps/server/src/services/messageService.ts`
- Test: `apps/server/src/services/channelService.conversation-resolve.test.ts`

**Step 1: 写失败测试（核心规则）**

Create: `apps/server/src/services/channelService.conversation-resolve.test.ts`

```ts
import { test, expect } from "bun:test";
import { resolveModelIdFromChannelItem } from "./channelService";

test("resolveModelIdFromChannelItem prefers explicit modelId when enabled, otherwise falls back to default", () => {
  const channel: any = {
    id: "c1",
    enabled: true,
    legacyModel: null,
    models: [
      { modelId: "m1", enabled: true, isDefault: false },
      { modelId: "m2", enabled: true, isDefault: true },
    ],
  };
  expect(resolveModelIdFromChannelItem(channel, "m1")).toBe("m1");
  expect(resolveModelIdFromChannelItem(channel, "disabled")).toBe("m2");
});
```

**Step 2: 运行确保失败**

Run: `cd apps/server && bun test src/services/channelService.conversation-resolve.test.ts`  
Expected: FAIL（缺少 helper）

**Step 3: 最小实现（channelService 增加可复用 helpers）**

在 `channelService.ts` 增加两个 helper（供 messageService 复用，避免重复实现）：

```ts
export function resolveModelIdFromChannelItem(channel: ChannelItem, requestedModelId?: string | null) {
  if (requestedModelId) {
    const match = channel.models.find((m) => m.modelId === requestedModelId && m.enabled);
    if (match) return match.modelId;
  }
  const def = channel.models.find((m) => m.isDefault && m.enabled) || channel.models.find((m) => m.enabled) || null;
  return def?.modelId || channel.legacyModel || null;
}
```

并新增一个用于对话解析的入口（伪代码，实际按现有 `getResolvedChannelForUser` 风格写）：
- `getResolvedChannelForConversation(userId, conversation)`
  - 如果 conversation 有 `channelId`：取 owned channel item（enabled），用 `resolveModelIdFromChannelItem(channel, conversation.modelId)` 生成 modelId
  - 否则回退 `getResolvedChannelForUser(userId, null)`

**Step 4: 修改 messageService 使用新解析**

在 `sendMessage` 与 `streamMessage` 内：
- 替换 `getResolvedChannelForUser(userId, null)` 为 `getResolvedChannelForConversation(userId, conversation)`

**Step 5: 运行测试通过**

Run: `cd apps/server && bun test src/services/channelService.conversation-resolve.test.ts`  
Expected: PASS

**Step 6: 手动验证**

Run: `cd apps/server && bun run typecheck`  
Expected: PASS

**Step 7: Commit（占位）**

```bash
git add apps/server/src/services/channelService.ts apps/server/src/services/messageService.ts apps/server/src/services/channelService.conversation-resolve.test.ts
git commit -m "feat(server): resolve model per conversation with fallback"
```

---

### Task 5: Web API 类型补齐（ApiConversation/ApiMessage）并统一 Date 解析

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/stores/chatStore.ts`

**Step 1: 增加类型与解析函数**

在 `apps/web/src/lib/api.ts`：
- 增加 `ApiConversation`, `ApiMessage`
- `api.conversations.list/get/create` 返回精确类型
- `api.messages.list` 返回精确类型

建议同时增加轻量转换函数（避免散落 `new Date(...)`）：

```ts
export function parseApiConversation(c: ApiConversation): Conversation {
  return { ...c, createdAt: new Date(c.createdAt), updatedAt: new Date(c.updatedAt) };
}
```

**Step 2: 手动验证**

Run: `pnpm --filter web build`  
Expected: PASS

**Step 3: Commit（占位）**

```bash
git add apps/web/src/lib/api.ts apps/web/src/stores/chatStore.ts
git commit -m "refactor(web): type conversations/messages and parse dates"
```

---

### Task 6: Web 计算“生效模型”（对话覆盖优先、默认兜底）

**Files:**
- Create: `apps/web/src/lib/effective-model.ts`
- Modify: `apps/web/src/components/ChatArea.tsx`
- Modify: `apps/web/src/components/app/AppHeader.tsx`（若需要复用同一套展示逻辑）

**Step 1: 实现 helper**

```ts
import type { ApiChannel } from "./api";
import type { Conversation } from "@/stores/chatStore";
import { getGlobalDefaultChannel } from "./default-channel";

export function getEffectiveModelForConversation(channels: ApiChannel[], conversation: Conversation | null) {
  if (conversation?.channelId && conversation.modelId) {
    const ch = channels.find((c) => c.id === conversation.channelId && c.enabled);
    const ok = ch?.models.find((m) => m.modelId === conversation.modelId && m.enabled);
    if (ch && ok) {
      return { channelId: ch.id, modelId: ok.modelId, label: `${ch.provider} · ${ok.modelId}`, source: "conversation" as const };
    }
  }
  const def = getGlobalDefaultChannel(channels);
  return def ? { ...def, source: "global" as const } : null;
}
```

**Step 2: 手动验证**

Run: `pnpm --filter web build`  
Expected: PASS

---

### Task 7: 接入 Mantine Notifications + Modals（统一提示与确认）

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/app/layout.tsx`（或已有 Mantine Provider 的入口）
- Create: `apps/web/src/components/ui/notify.ts`

**Step 1: 安装依赖**

Run: `cd apps/web && pnpm add @mantine/notifications @mantine/modals`

**Step 2: 在 root 注入 providers**

- 包裹 `ModalsProvider`、`Notifications`
- 提供 `notifySuccess/notifyError` 小封装

**Step 3: 手动验证**

- 任意地方调用通知可弹出
- 删除对话时使用 confirm modal

---

### Task 8: 实现 ChatHeader + ModelPickerModal（对标 Proma ModelSelector）

**Files:**
- Create: `apps/web/src/components/chat/ChatHeader.tsx`
- Create: `apps/web/src/components/chat/ModelPickerModal.tsx`
- Modify: `apps/web/src/components/ChatArea.tsx`

**Step 1: ChatHeader 展示**

- 左侧：对话标题
- 右侧：模型 badge（显示 source: conversation/global/missing）
- badge 点击打开 modal

**Step 2: ModelPickerModal**

- 数据源：`useChatStore().channels`（打开时可刷新一次 `api.channels.list()`）
- 渠道分组 + 搜索 + 选择
- 选择后调用 `api.conversations.update(conversationId, { channelId, modelId })`
- 更新 store 中 `currentConversation` 与 `conversations` 列表项（保持一致）

**Step 3: ChatArea 接入**

- 顶部插入 `<ChatHeader />`
- `canSend` 改为基于 `effectiveModel`，而不是仅 `getGlobalDefaultChannel`

**Step 4: 手动验证**

- 选择模型后刷新页面，对话仍保持该模型
- 另一个对话仍继承默认模型

---

### Task 9: ChatAside 对标 Proma（置顶+分组+菜单）

**Files:**
- Modify: `apps/web/src/components/chat/ChatAside.tsx`
- (Optional) Delete: `apps/web/src/components/Sidebar.tsx`（确认无引用后）

**Step 1: 列表分组函数**

- 新增 `groupByUpdatedAt(conversations)` 输出 `今天/昨天/更早`

**Step 2: 新对话按钮**

- 点击创建，标题可先用 `New Chat` + 时间戳（后续再做自动标题）

**Step 3: 置顶折叠区**

- `isPinned` 为 true 的放置顶区
- 菜单支持置顶/取消置顶（调用 `api.conversations.update(id, { isPinned })`）

**Step 4: 重命名**

- 先用 modal 输入框：`api.conversations.update(id, { title })`

**Step 5: 删除确认**

- 使用 Mantine confirm modal 替换 `confirm()`

**Step 6: 手动验证**

- 置顶后出现在置顶区
- 修改标题后列表即时更新
- 删除后当前会话清空

---

### Task 10: 清理与一致性检查（避免重复实现逻辑）

**Files:**
- Modify/Delete: `apps/web/src/hooks/useChat.ts`（若与 store 重复）
- Modify/Delete: `apps/web/src/components/Sidebar.tsx`（若已弃用）

**Step 1: 搜索引用**

Run:
- `rg -n "useChat\\(" apps/web/src -S`
- `rg -n "from '../components/Sidebar'|Sidebar\\b" apps/web/src -S`

**Step 2: 删除或合并**

原则：
- 会话/消息/流式的单一事实来源：`useChatStore` + `api`（避免再维护一套 `useChat` hook 的重复逻辑）

**Step 3: 最终验证**

Run:
- `pnpm --filter web build`
- `cd apps/server && bun run typecheck`

---

## Notes

- 该仓库当前环境可能不是 git 仓库，以上 commit 步骤为占位。
- 全程不要把任何 API Key 写入仓库；渠道配置仅走后端加密存储。

