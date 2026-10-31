# Agent 回复正文以 content 为唯一事实来源

## 背景（第一性原理）
上一个任务（fe84395）发现 Agent 回复只存在 `agentRun.steps[]` 的 `{type:"text"}` 里，
`messages.content` 为 `""`。当时的修复在读取端打补丁（`shared/message-text` 的 `messageText`、
桌面 `buildConversationHistory`、服务端 `withAgentReplyText`、复制按钮）。但根因是数据本身违反了
「assistant 消息 content = 回复正文」这一不变量，其他只读 content 的消费方仍然是坏的：
messages_fts 全文搜索、`exportService`、`summaryService`、`autoTitleService`……
库里现有 28 条 agent 回复 content 为空。

为何当初留空：`DesktopMessageBubble` 对 Agent 消息先渲染 processPanel（时间线，含 text 步骤），
再渲染 content，若 content 非空会显示两遍；`chatStore.applyStreamEvent` 因此把 delta 只写进步骤。

## 目标：让坏状态不可能出现
1. **不变量**：assistant 且有 `agentRun` 的消息，`content` === text 步骤按序以 `\n\n` 拼接后 trim
   （复用 `shared/message-text` 的推导函数，必要时拆出 `agentRunReplyText(agentRun)`）。
   - 桌面 `chatStore`：所有修改 agentRun.steps 的路径（delta→text 步骤、`clear_streaming_text`、
     reasoning、done、后台缓存 `updateCachedMessage` 路径等）在更新后由步骤推导 content，而不是各处手写。
     最好集中在一个函数（例如 `withDerivedContent(message)`）里。
   - `failStreamingMessage`：Agent 消息不再把错误写进 content（错误留在 `agentRun.error`，面板已渲染它）；
     Chat 消息行为不变。
   - 服务端写入口：`syncSidecarMessages`（routes/messages.ts `/sync-sidecar`）以及服务端执行的 Agent 回合
     （`messageService.ts` 中 `applyTaskBackedAgentTurnToMessage` / ~336、~527 一带）在落库前同样以
     agentRun 推导 content，客户端传空也不影响。核实这些路径现在实际写的是什么。
2. **渲染**：`DesktopMessageBubble`：Agent 消息若 agentRun 含 text 步骤，只渲染时间线，不再渲染 content 块
   （流式中同理，不能出现双份）；没有 text 步骤的旧数据（content 有值、步骤无 text）保持现在的渲染。
   核实 `DesktopAgentRunPanel` 的 text 段就是正文的完整渲染（含 genui 代码块、genUiScope / 状态 key
   不变——`lib/genui/blockState.ts` 的 key 用 `<messageId>[:<agentStepIndex>]:<offset>`，不能因此丢已存状态）。
3. **存量回填**：`apps/server/src/db/bootstrap.ts` 加幂等迁移：content 为空且 agent_run 含 text 步骤的
   assistant 行，用推导结果回填；确保 messages_fts 同步（看现有触发器 / 重建逻辑，~1332、~1408 行）。
   Drizzle schema 不变（没有新列）。
4. **收回读端补丁**：不变量成立后，`withAgentReplyText`、`buildConversationHistory` 里的 agentRun 回退、
   复制按钮的回退都改为直接读 content；删除不再使用的代码与对应测试，保留推导函数本身及其测试。
   sidecar 的真实多轮消息（buildHistoryMessages）保留——那是另一个独立的正确改动。
5. **测试**：推导 / store 不变量（delta、clear_streaming_text→reasoning 后 content 随之变化、失败不写错误）、
   服务端写入口规范化、回填迁移幂等。桌面 matcher 限 toBe/toBeDefined/toEqual/toHaveLength/toMatchObject；
   服务端 mock.module 规则见 CLAUDE.md。

## 约束
- 包按 workspace 名导入；桌面组件无内联中文；Biome 2 空格 / 100 列。
- 跑 desktop / server / sidecar / shared 测试，desktop / server tsc，biome。改了 sidecar 才需重编。

## 验收
- 新 Agent 回复落库后 content 非空且等于正文；界面不重复显示；全文搜索能搜到 Agent 回复内容；
  存量 28 条回填。

## 实现备注（核实结果）
- **服务端执行的 Agent 回合不违反不变量**：`applyTaskBackedAgentTurnToMessage` / `syncTaskBackedMessages`
  写的 content 是 `buildTaskMessageSummary(detail)`（任务摘要，非空），agentRun 由
  `buildTaskBackedAgentRun` 生成，`steps: []`，没有 text 步骤。本地导入（`importTurnBuilder`）与
  旧 agent_sessions 迁移的 agentRun 也不含 text 步骤，正文本来就在 content。
  因此服务端规则定为 `agentReplyContent(content, agentRun)`：**有 text 步骤 → content 由步骤推导；
  否则保留传入值**。唯一产生 text 步骤的写入口是 `syncSidecarMessages`（插入与更新在位两个分支都已规范化）。
- **桌面端规则更严格**：有 agentRun 的消息 content 恒等于步骤推导（无 text 步骤即 `""`），
  这样 `clear_streaming_text` 删掉唯一 text 步骤时 content 会随之清空。集中在
  `chatStore.updateAgentMessage` → `withDerivedContent`，覆盖 delta / clear_streaming_text /
  agent_event / done / failStreamingMessage，以及后台缓存分支。
- `failStreamingMessage`：有 agentRun 的消息只写 `agentRun.error`；**没有 agentRun 的消息（含 server 路径
  `sendMessage` 建的 agent 草稿，它不带 agentRun）仍把错误写进 content**，否则错误无处显示。
- **FTS 没有触发器**：`messages_fts` 全靠 `ftsUpsert` 手动同步，回填函数 `backfillAgentReplyContent`
  在 `ensureMessagesFtsTable` 之后运行，逐行 DELETE + INSERT FTS。
- genui 状态 key：Agent 消息的 content 块之前因 content 为空从未渲染，正文一直由时间线 text 段以
  `<messageId>:<stepIndex>` 作 scope 渲染；现在仍只渲染时间线，key 不变。
- 额外发现：`DesktopChatArea` 停止流式后的 orphan 清理会删除所有 content 为空的 assistant 消息——
  之前会误删已落库的 Agent 回复（content 为空）。现在 content 已填，但失败的 Agent 回合 content 可为空，
  所以清理条件加上 `!m.agentRun?.error`。
- `messageText`（content 优先的读端回退）已无调用方，替换为 `agentRunReplyText` /
  `hasAgentReplyTextSteps` / `agentReplyContent`。
