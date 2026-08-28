# Sidecar 运行的用户消息附件 meta 落库 — 切换会话后保留

## Goal

Agent（sidecar 本地运行）模式下发送带附件的消息，附件名称当场可见，但切换会话再回来就消失。修复它，并建立不变量：**用户消息气泡渲染所依赖的一切状态，必须能完整走一遍「落库 → 重新拉取 → 渲染」往返**，杜绝这一类"内存里有、库里没有"的问题。

## Root Cause（已确认）

用户气泡渲染依赖三个字段：`content`（含 /command token，已持久化 ✓）、`mode`（✓）、`attachmentsMeta`（✗）。

- Agent 模式下附件不上传服务器，`DesktopChatArea.tsx` 只把 `localAttachmentMeta` 放进内存 message（~1484 行），文件内容转成 attachmentParts 直接发给 sidecar
- 落库唯一路径是 `useSidecarAgentRun.ts` 的 `persistOnce` → `api.messages.syncSidecar`（~194 行），payload 只有 `userContent / assistantContent / model / agentRun`，**没有附件信息**
- 服务端 `syncSidecarMessages`（`messageService.ts:1622`）插入 user message 时 `attachments: null`，也不写 `attachments` 表
- 会话切换重新拉取时，`listMessages` 是从 `attachments` 表 join 出 `attachmentsMeta`（`messageService.ts:948`）→ 空
- 对照组：Chat 模式走 `uploadAttachments` + `chatPrepare`，附件真实上传并 link 到消息，所以能保留。差异只在 sidecar 路径

## Requirements

1. `syncSidecar` API（desktop `serverApi.ts` + server `routes/messages.ts` + `messageService.syncSidecarMessages`）新增可选 `attachmentsMeta: Array<{ fileName: string; fileType?: string; fileSize?: number }>`
2. 服务端把 meta 写入现有 `attachments` 表并 link 到 user message（`messageId`、`conversationId`）。本地文件没有服务器路径：`filePath` 用 `local:` 前缀标记（如 `local:<fileName>`），表示 metadata-only、不可下载
3. 更新在位（edit-and-resend 分支，1648-1683 行）：若传了 `attachmentsMeta`，先删除该 user message 现有 attachment 行再重插，避免编辑后重复/陈旧
4. `useSidecarAgentRun.ts`：`startRun` input 增加 `attachmentsMeta`，`persistOnce` 透传；所有失败路径（persistFailure）同样保留
5. `DesktopChatArea.tsx` agent 分支：把 `localAttachmentMeta` 传入 `startRun`，**剥离 `previewUrl`**（objectURL 是会话内临时值，不得落库）
6. 确认 `reconcileSidecarMessageIds` 换 id 时不丢内存里的 `attachmentsMeta`；若会丢，一并修复
7. 不改 Chat 模式已正常的上传路径；不引入 DB schema 变更（复用 attachments 表现有列）

## Acceptance Criteria

* [ ] Agent 模式发送带本地文件的消息 → 切换到其他会话再切回 → 用户气泡仍显示附件名称
* [ ] 重启应用后（纯服务端数据）附件名称仍在
* [ ] 图片附件切回后至少显示文件名 chip（previewUrl 丢失可接受，不得报错）
* [ ] edit-and-resend 一条带附件的消息后无重复 attachment 行
* [ ] 运行失败的 round（persistFailure 路径）附件 meta 同样保留
* [ ] 附件的下载/读取端点不会把 `local:` 行当可下载文件返回（若有此类端点，需防御；没有则记录说明）
* [ ] server `bun test` 失败数不高于基线（~15 个既有失败）；desktop `bun test` 全过；`tsc` 全过

## Definition of Done

* typecheck / biome 无新增问题
* 真实应用中按验收步骤验证
* 通过 trellis-update-spec 把「用户消息渲染状态必须可持久化往返」不变量沉淀进 spec

## Out of Scope

* 本地文件内容上传/图片预览的持久化（只保 meta）
* Web 端组件树
* Chat 模式路径重构

## Technical Notes

* 落库消息表有双定义规则，但本方案不改 schema，不涉及 bootstrap.ts
* `attachments.filePath` 为 notNull —— `local:` 哨兵即为此设计
* 涉及文件：`apps/desktop/src/components/chat/DesktopChatArea.tsx`、`apps/desktop/src/hooks/useSidecarAgentRun.ts`、`apps/desktop/src/lib/serverApi.ts`、`apps/server/src/routes/messages.ts`、`apps/server/src/services/messageService.ts`
* 若 `packages/shared/src/types` 已有 attachment meta DTO 则复用，别新造
