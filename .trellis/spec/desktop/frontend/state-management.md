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

- `chatStore.loadConversations` refreshes server-owned conversation metadata,
  including persisted `lastMode`, without changing the current local
  `composerMode`. The composer holds the user's choice for the next request;
  an ordinary foreground/background refresh must preserve it, including when
  that choice changes while the refresh is pending.
- Explicit conversation selection and creation restore the selected
  conversation's saved mode. A metadata refresh is not a selection event.
- Keep the `chatStore.test.ts` regressions for both saved modes, foreground and
  background refreshes, and a deferred refresh resolved after a local mode
  change. Assert that metadata is refreshed and explicit selection still
  restores the saved mode.

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
- 附件 chip 在发送前和消息中均可点击：默认复用右侧预览面板中的单个附件标签，点击另一附件替换其内容，不关闭已有文件/网页标签；支持拖动调宽、收起和放大查看。窄窗口（首版小于 1100 CSS px）自动回退弹窗，放大弹窗按 Esc 返回侧栏。支持的类型在 `DesktopAttachmentViewer` 内查看原文件，其余提供文件信息和保存入口；读取失败必须显示原因，不允许静默无响应。
- 附件侧栏开关、收起和拖宽必须保持被点击附件的视口相对位置。按稳定消息/回合标识、附件序号和距聊天区顶部的偏移捕获锚点，不能只保留 `scrollTop`；虚拟列表需临时保留锚点回合，待异步高度测量完成后恢复。手动滚动可以自由浏览，关闭仍返回最近点击处；切换会话或显式发送/重试滚动必须取消旧锚点，不能被旧预览拉回。
- 预览不改变本地 Agent 的仅同步元数据约定。当前会话的临时 `previewUrl` 可用于读取原文件，切换会话时释放；历史 `local:` 元数据没有原文件时明确提示重新附加，不能把模型提取文本冒充原文件。上传过的附件可在临时 URL 失效后回退到带凭据的附件端点。
- Markdown/HTML 附件不得成为可执行页面或 GenUI：HTML 按文本展示，Markdown 排版跳过原始 HTML 和远程图片。首版文本预览限制为前 2 MB，截断时明确说明复制范围，保存始终使用完整原始字节。
- 查看附件不要求用户再次保存。主操作“用默认应用打开”直接调用 `open_attachment`，不弹出保存对话框；应用内部复用内容一致的受控本地缓存，外部编辑过的副本不得被覆盖。导出是独立的“更多操作 → 另存为”，仅此入口调用 `save_attachment` 并让用户选路径。外部打开仍仅允许既有的文档/图片/媒体扩展名。受控缓存不等于历史 Agent 附件引用已补齐。

### 4. Validation & Error Matrix

- `fileName` 非字符串 → 该项被过滤，不入库
- `fileType` 非字符串/空 → 回落 `application/octet-stream`；`fileSize` 非有限数 → 回落 0
- `attachmentsMeta` 非数组的畸形 body → 跳过附件写入，不抛 TypeError
- 落库失败 → 保留生成结果与运行终态，独立提示保存失败并提供仅重试保存的操作（见下方 Agent save recovery 契约）；不得静默丢弃或把保存错误写入回复。

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

## Chat Failure Metadata

Chat `content` contains generated text only, even when empty. `finishReason`
round-trips the safe `error` / `context_budget_exceeded` categories in addition
to Stop and output truncation. `chatAdapter` validates through the shared
normalizer; `DesktopMessageBubble` localizes the reason outside Markdown.
Preparation HTTP failures carry the actual saved user/assistant IDs, so reconcile
both optimistic rows before surfacing the failure. A failed zero-output retry
restores the complete previous snapshot and does not subsequently mark that
restored answer failed. See server `chat-streaming.md` for signatures and the
required service/browser regression matrix.

## Agent Save Recovery

Generation and saving are separate operations. A failed HTTP save must not change
an Agent run's terminal status, reply text, steps, or `agentRun.error`.
`sidecarPersistence` owns the immutable final payload and a persistent notification
with a **Retry save** action. Retrying calls only `messages.syncSidecar`; it must
never invoke the model, repeat tools, or create another foreground turn.

- Retain both local messages with an explicit token before saving. These snapshots
  survive navigation, stale database reads, and eviction from the 20-conversation
  navigation cache, independently of `temp-` / `draft-` naming conventions. Preserve
  prompt-before-reply order and existing render identities when IDs change.
- Assign stable UUIDs before the first HTTP request and reuse the same IDs and
  payload on retry, including after an ACK is lost. For a persisted unanswered
  user, send its existing `userMessageId` and an explicit `newAssistantMessageId`.
  Existing imported message IDs may be opaque strings; validate their ownership,
  conversation and role rather than imposing a new UUID format on historical rows.
- The server transaction validates the owned conversation and message roles, then
  inserts or updates both messages and attachment metadata atomically. A supplied
  pair must either exist in full or be entirely new; partial pairs and ID collisions
  reject. Legacy calls without stable IDs remain supported.
- Each application session supplies a UUID `syncRevision.sessionId` and a positive
  safe-integer sequence. The server privately records `_syncRevision` in the run
  JSON and ignores duplicate or older saves from the same session. This orders
  requests within one running desktop session; it is not cross-client conflict
  detection or a global revision protocol.
- Release retained snapshots only for the matching successful save. A late ACK
  cannot clear a newer token or a currently active replacement run. Markers for
  active generation must be cleared for the stable IDs too; they are independent
  of unsaved-result protection. A read started before the successful ACK must
  reload rather than install its stale result after protection is released.
- Deleting a conversation or resetting the store invalidates its pending actions.
  Deleting one message cancels that pair's save retry and removes only the chosen
  row from live state/cache; retain any other unsaved message for this session.
  A stale retry action must not recreate deleted messages.
- While an HTTP save is in flight, track a separate per-message, per-attempt token
  lock. Disable single-message deletion in the UI and reject it in the store too;
  an earlier save must not commit after a successful deletion and recreate a row.
  Each request releases only its own lock, including after reset or a newer save.
  A settled failure releases this lock so retained messages can be deleted. The
  server treats an absent message as already deleted; it still checks ownership
  of every existing row and never converts a network failure into local success.

Recovery is held only in the current application session's memory. This does not
provide an offline credential queue, durable restart recovery, or automatic model
retries. Keep this limit explicit in user-facing save-failure copy and tests.

Required regressions cover fresh streaming IDs, persisted edits against stale DB
rows, more than 20 nonempty conversations, lost ACK retries, duplicate clicks,
older ACKs/revisions, deletion/reset, stale pending reads, opaque historical IDs,
user-only replies, transaction rollback and invalid role/ownership/ID shapes.

---

## Common Mistakes

### Common Mistake: 渲染字段只活在内存

**Symptom**: 某个 UI 信息（如附件名）发送后可见，切换会话或重启后消失

**Cause**: 字段只挂在 `useChatStore` 的 message 对象上，sidecar 落库路径（syncSidecar）没带它，重新拉取时自然没有

**Fix / Prevention**: 按上方 Scenario 的五段链路逐段检查；新增用户消息渲染字段时五段必须同批改完

### Agent 回复正文不在 `content` 里（2026-10-31，task `10-31-structured-history`）

**Symptom**: Agent 模式多轮对话里模型把上一轮的问题再答一遍（「蓝鲸42\n\n你发了2条消息」），
或者复制 Agent 回复得到空字符串

**Cause**: `chatStore.applyStreamEvent` 有意把 Agent 的 `delta` 写成 `agentRun.steps[]` 里的
`{type: "text"}` 步骤（按时间线渲染），`messages.content` 一直是 `""`。所有只读 `content`
并跳过空文本的地方（历史组装、复制、服务端 `buildChatMessages`）都会把 Agent 回复整条丢掉，
模型只看到用户连续几条提问

**Fix / Prevention**（task `10-31-agent-content-invariant` 起改为写入端不变量）：
有 `agentRun` 的 assistant 消息，`content` 恒等于 text 步骤按序 trim、去空、以 `\n\n` 拼接
（`shared/message-text` 的 `agentRunReplyText`）。桌面 `chatStore` 所有改 agentRun 的路径都经
`updateAgentMessage` → `withDerivedContent` 推导 content；Agent 失败只写 `agentRun.error`，
不写进 content。

**唯一规则**（task `10-31-task-reply-text`）：`shared/message-text` 的
`assistantMessageContent(content, agentRun)`——有 agentRun 则 content = text 步骤推导，**没有任何
「无 text 步骤就保留传入 content」的回退**；无 agentRun（chat）则原样。所有写入方都走它：桌面
`withDerivedContent`、服务端 `syncSidecarMessages`、导入
（`buildImportedAgentRun(steps, reply)` 把正文作为收尾 text 步骤）、旧 agent_sessions 迁移、备份恢复。
`bootstrap.ts` 的 `backfillAgentReplyContent`（逻辑在 `services/agentReplyNormalization.ts`）幂等地把
存量行拉齐并同步 messages_fts；它是一次性迁移（`ONE_TIME_MIGRATIONS`，按 id 记入 `schema_migrations`），
每个数据库只跑一次。旧的服务端任务型回合（`agentRun.taskId`）不再产生（task `10-31-server-agent-deadpath`），
回填按任务的 final_result 重建其 text 步骤；任务没有 final_result 时保留已有步骤。回填**绝不丢弃 content 里有而 text 步骤里没有的文本**（2026-09-09 前的桌面版本完成时弹掉尾部 text 步骤、正文只在 content；这类行要把 content 作为收尾 text 步骤补回，而不是按步骤重算覆盖）。失败行只有在 content 等于 `agentRun.error`（或 status=failed 且无 error）时才视为错误文本；error 已存在且不同时 content 是部分回复。新增写 agentRun 的地方：要么把回复放进 text 步骤，要么接受 content 为 ""。
读取端一律直接读 `content`；`DesktopMessageBubble` 对含 text 步骤的消息只渲染时间线，不再渲染
content 块。sidecar 的 Claude / 直连运行时把历史作为真实的 user / assistant 消息发送
（`agent/context.ts` `buildHistoryMessages`），Codex / ACP 只收单段文本，仍是拼接


## Model Context Configuration

Channel model records carry nullable contextWindow; null is automatic model
metadata, not zero. Preserve the field in every model-list update and map it
through chatAdapter. Settings uses explicit save with integer8192..2000000
validation; blank explicitly resets to automatic. Show effective saved capacity.
Credential requests include the actual selected modelId (URL-encoded), so manual
and background Agent runs never inherit the default model's override. Forward
prepared Chat contextWindow after adding the live output-policy instructions;
sidecar rechecks final input. Legacy conversation.contextLength=4096 must not be
silently interpreted as an intentional new context override. See server
chat-streaming.md for policy, migration and transport-boundary regressions.


## Discovered Context Provenance

Map contextMetadata through channel models, credentials, prepared Chat and both
manual/background sidecar run paths. It is server-owned and excluded from manual
model update payloads; resetting the manual field to null preserves discovery.
Settings has one metadata-only refresh action per channel. Capacity lines label
channel/catalog/runtime/builtin/manual origin; unknown fallback is visibly a
conservative app budget. A timestamp/input-only note can be placed in a tooltip.
Never present fallback32K as a provider's true window. Effective auto windows can
exceed the manual editor range, so transport raw manualnull+metadata instead of
coercing effective capacity into the manual RPC field. See server discovery
contract for source priority, cache invalidation and non-destructive refresh.

## Sidecar Lifecycle Ownership and Chat Transport Completion

### 1. Scope / Trigger

Sidecar startup/shutdown, reconnect attempts, asynchronous workspace resolution,
and Chat SSE response consumption.

### 2. Signatures

Keep SidecarState's public actions and start/stop promises. Lifecycle generation,
captured platform/client identities, pending startup and stop barriers are private.
`readSseStream` requires Chat done/error; `readTypedSseStream` stays protocol-neutral.

### 3. Contracts

Only the current lifecycle/client may publish ready/error/workspace state or
schedule reconnects. Stop/reset/unsupported/platform replacement invalidate old
continuations and dispose connecting/stale clients. A retained old disconnect
callback cannot erase a new connection. Stop clears local ownership immediately;
coordinate already-issued host startup and a later start so a delayed spawn or
old stop cannot resurrect or kill a replacement. Reset does not silently expand
its authority into stopping a shared platform process.

Automatic reconnect is a bounded recovery session: startup and handshake failures
continue exponential backoff up to the existing ten-attempt cap. Success and
explicit lifecycle cancellation reset the session. Late workspace responses cannot
rewrite the new lifecycle's root, error or saved default.

A Chat SSE body's clean EOF is insufficient proof of completion. Require a valid
done/error event; preserve partial text and surface localized interruption when
it is missing. Keep provider error events available to the existing consumer.
Always release the reader; cancel on callback/read failure. UTF8 boundary chunks
and normal final unterminated lines retain their existing decoding behavior.

### 4. Validation & Error Matrix

| Trigger | Expected behavior |
|---|---|
| Stop/reset while host startup or handshake awaits | No late ready/client restoration |
| Old client disconnects after replacement | Preserve the new client |
| Automatic reconnect fails once | Continue bounded backoff |
| Late workspace response after lifecycle changes | No stale state/storage write |
| Partial/empty Chat body ends without terminal | Report interruption, not success |
| Callback or reader throws | Cancel/release reader and preserve the failure |

### 5. Good / Base / Bad Cases

Good: a delayed host response is cleaned up under its original lifecycle.
Base: normal startup and a Chat stream with done/error retain their behavior.
Bad: check only status=ready in an old callback, or reload a partial answer as if
EOF implied successful generation.

### 6. Tests Required

Use fake platform/client promises and restored deterministic timers for startup,
Stop barriers, stale disconnect/workspace callbacks, failed host/handshake retries,
retry cap and cancellation. Pure ReadableStream regressions cover done/error,
partial/empty EOF, split UTF8, callback failure and reader lock cleanup.

### 7. Wrong vs Correct

Wrong: install every awaited client or reconnect only from onDisconnect.
Correct: require current ownership at each continuation and schedule recovery
from failed reconnect attempts too, under the same bounded lifecycle.

## Background Scheduled-Run Identity and Workspace

### 1. Scope / Trigger

Concurrent scheduled Agent runs and their per-conversation workspace preparation.

### 2. Signatures

Keep scheduled task APIs unchanged. Each optimistic turn uses a fresh UUID pair;
`runAgent` receives the exact successful `ensureWorkspace` result as workspaceRoot.

### 3. Contracts

Date.now is a timestamp, not a unique message identity. Independent tasks starting
in the same millisecond must not share ownership, events or persistence guards.
Resolve a conversation's project root before starting the task; if project metadata
is absent, await project loading once and resolve again. A genuinely missing or
unavailable project/default workspace fails that task before any Agent call.
Capture the returned canonical root and pass it explicitly, so another run's later
connection-level workspace selection cannot redirect this one. Never fall back to
whatever cwd the Sidecar happened to retain after preparation failed.

### 4. Validation & Error Matrix

| Trigger | Required result |
|---|---|
| Two due tasks start under a fixed identical clock | Distinct draft identities and both results saved |
| Workspace preparation throws/returns null | Failed task, zero Agent starts |
| Project metadata is slow but valid | Await loading, then start in its canonical project root |
| Project remains missing | Refuse; do not use default/old cwd |
| Another task changes shared workspace after preparation | This run keeps its captured root |

### 5. Good / Base / Bad Cases

Good: simultaneous due tasks retain independent replies and their own directories.
Base: a normal default-workspace task uses the existing saved/default resolver.
Bad: use millisecond IDs or ignore a failed workspace result for unattended work.

### 6. Tests Required

Isolated child fixtures drive the real runner/store/ownership with a fixed clock,
synthetic tasks/API/client and gated project/workspace preparation. Assert both
results persist, invalid preparation starts no runtime, cold metadata loads before
use, and later global root changes do not alter submitted cwd. Unknown fake-fetch
URLs reject; no test may call the normal server, real model or user task list.

### 7. Wrong vs Correct

Wrong: create `temp-${Date.now()}` and submit without workspaceRoot.
Correct: allocate a UUID turn and submit only after resolving its explicit root.
