# State Management

> How state is managed in this project.

---

## Overview

<!--
Document your project's state management conventions here.

Questions to answer:
- What state management solution do you use?
- How is local vs global state decided?
- How do you handle server state?
- What are the patterns for derived state?
-->

(To be filled by the team)

---

## State Categories

<!-- Local state, global state, server state, URL state -->

(To be filled by the team)

---

## When to Use Global State

<!-- Criteria for promoting state to global -->

(To be filled by the team)

---

## Server State

<!-- How server data is cached and synchronized -->

(To be filled by the team)

---

## Scenario: 用户消息渲染状态的持久化往返（syncSidecar 链路契约）

### 1. Scope / Trigger

- 触发：给用户消息（user message）新增任何气泡渲染所依赖的字段，或修改 sidecar 本地运行的落库逻辑
- 不变量：**用户气泡渲染所依赖的一切状态，必须能完整走「落库 → 重新拉取 → 渲染」往返**。只存在于前端内存 message 对象上的字段，切换会话/重启后必丢（2026-07-03 附件名丢失 bug 的根因）

### 2. Signatures

sidecar 本地运行（Agent 模式）的落库唯一路径，五段链路缺一不可：

| 段 | 位置 | 职责 |
|---|---|---|
| ① 类型 | `apps/desktop/src/lib/serverApi.ts` `messages.syncSidecar` | 入参类型声明字段 |
| ② 透传 | `apps/desktop/src/hooks/useSidecarAgentRun.ts` `persistOnce` | 从 `input` 透传（done 与所有失败路径都收敛到此） |
| ③ 落库 | `apps/server/src/services/messageService.ts` `syncSidecarMessages` | 写 messages/attachments 表；edit-and-resend 更新在位分支同样要处理 |
| ④ 回读 | 同文件 `listMessages`（~918-949 join attachments） | 从库拼回 DTO |
| ⑤ 映射 | `apps/desktop/src/lib/chatAdapter.ts` `mapAttachmentsMeta` 等 | DTO → `Message` 字段 |

### 3. Contracts

- `syncSidecar` 现有字段：`conversationId`、`userContent`（= displayContent，含 `/command` token）、`assistantContent`、`model`、`agentRun`、可选 `userMessageId`/`assistantMessageId`（编辑重发更新在位）、可选 `attachmentsMeta: Array<{ fileName: string; fileType?: string; fileSize?: number }>`
- 本地文件不上传，只落 meta：`attachments.filePath` 用 `local:<fileName>` 哨兵（列 notNull，不改 schema）；读取端点必须对 `local:` 行 404（见 `routes/attachments.ts`）
- **会话内临时值必须剥离不落库**：objectURL（`previewUrl`）、临时 id（`temp-`/`draft-` 前缀）。desktop 侧用 `toSyncAttachmentsMeta` 之类的 helper 在发送前剥离
- `attachmentsMeta` 语义：`undefined` = 不动现有行；`[]` = 权威清空（更新在位分支先 delete 再重插）

### 4. Validation & Error Matrix

- `fileName` 非字符串 → 该项被过滤，不入库
- `fileType` 非字符串/空 → 回落 `application/octet-stream`；`fileSize` 非有限数 → 回落 0
- `attachmentsMeta` 非数组的畸形 body → 跳过附件写入，不抛 TypeError
- 落库失败 → best-effort，不影响 UI（`persistOnce` catch 吞掉）

### 5. Good/Base/Bad Cases

- Good：Agent 模式发带附件消息 → 切会话/重启 → 附件名 chip 仍在（走 ③④⑤ 恢复）
- Base：无附件消息 → `attachmentsMeta` 为 `undefined`，链路各段不做无谓写删
- Bad（禁止）：只把新字段塞进 `useChatStore` 的 message 对象、不扩展 syncSidecar 链路——当场能看见、切换即丢

### 6. Tests Required

- server：`syncSidecarMessages` 插入分支写 attachment 行（断言 filePath `local:` 前缀、缺省值）；更新在位分支传 `[]` 清空、传 `undefined` 不动
- desktop：`toSyncAttachmentsMeta` 剥离 `previewUrl`/`id`、空数组返回 `undefined`

### 7. Wrong vs Correct

#### Wrong

```ts
// 只更新内存 message，落库 payload 不带新字段
addMessage({ ...msg, myNewField });
await api.messages.syncSidecar({ conversationId, userContent, assistantContent });
```

#### Correct

```ts
// 五段链路同步扩展：serverApi 类型 → persistOnce 透传 → syncSidecarMessages 落库
// → listMessages 回读 → chatAdapter 映射；临时值（objectURL 等）发送前剥离
await api.messages.syncSidecar({ ..., myNewField: stripEphemeral(msg.myNewField) });
```

补充：`chatStore.reconcileSidecarMessageIds` 用对象展开只换 `id`，其余字段保留——改它时保持这一行为，否则落库前的内存字段会在 id 对齐时丢失。

---

## Common Mistakes

### Common Mistake: 渲染字段只活在内存

**Symptom**: 某个 UI 信息（如附件名）发送后可见，切换会话或重启后消失

**Cause**: 字段只挂在 `useChatStore` 的 message 对象上，sidecar 落库路径（syncSidecar）没带它，重新拉取时自然没有

**Fix / Prevention**: 按上方 Scenario 的五段链路逐段检查；新增用户消息渲染字段时五段必须同批改完
