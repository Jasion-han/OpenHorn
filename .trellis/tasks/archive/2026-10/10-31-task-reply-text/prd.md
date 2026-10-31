# 服务端 Agent 回合以完整最终结果作为回复正文

## 背景（第一性原理）
上个任务（f53c70e）确立不变量「assistant content = 回复正文 = agentRun 中 text 步骤的拼接」，
但留下两套规则：桌面 store 总是由步骤推导；服务端 `syncSidecarMessages` 有 text 步骤才推导、否则保留
传入 content。原因是**服务端执行的 Agent 回合（task-backed）根本没有 text 步骤**：
- `messageService.ts` `buildTaskBackedAgentRun` 返回 `steps: []`；
- content / summary 来自 `buildTaskMessageSummary` = `task.insight.previewText`，而 previewText 是
  `agentTaskService.ts` `buildTaskInsight` 产出的**卡片预览**：`clipInsightText` 截到 160 字符加「…」，
  且任务失败时取的是错误字符串。
后果：库中 163 条 task-backed 消息的 content 是截断预览或错误文本，历史 / 搜索 / 导出 / 摘要都拿到
截断内容，错误被当成回答进历史；桌面端实时副本（无 text 步骤 → content ""）与库中不一致。
根因：「回复正文」与「任务卡片预览」两个概念混用。

## 目标
1. task-backed 回合的回复正文 = 最新 `final_result` 工件的完整 content（不截断）。
   `buildTaskBackedAgentRun` 把它表示为 text 步骤（无最终结果则无 text 步骤）；失败的错误放 `agentRun.error`
   （status failed），不进 content。`agentRun.summary`（卡片 / 元信息行用）可继续用 preview —— 核实桌面
   哪些地方读 summary / insight，保持卡片展示不变。
2. 所有写入 task-backed 消息的路径（`applyTaskBackedAgentTurnToMessage`、`syncTaskBackedMessages`、
   其它调用 `buildTaskMessageSummary` 写 content 的地方）content 一律由同一推导函数从 agentRun 得出，并同步
   FTS（`ftsUpsert`）。`buildTaskMessageSummary` 若不再用于 content，按实际用途改名或删除。
3. 统一规则：服务端 `syncSidecarMessages` 去掉「无 text 步骤则保留传入 content」的分支，与桌面一致：
   有 agentRun 的 assistant 消息 content 总是由步骤推导。逐个核实还有哪些写入方会写「有 agentRun 但无 text
   步骤、content 非空」的行（导入 import_records / 迁移 / 定时任务 / chat→agent 等），全部改为同一表达，
   或明确记录为何例外。没有 agentRun 的消息（chat 模式）不受影响。
4. 桌面端：服务端执行的 Agent 回合实时副本与库一致——核实桌面如何收到 task-backed 回合的结果
   （SSE done 事件 / 重新拉取 / 轮询 task），确保拿到带 text 步骤的 agentRun，并经 `withDerivedContent`
   得到同样的 content。气泡对 task-backed 消息的渲染（DesktopAgentRunPanel / 任务卡片）不出现双份。
5. 存量回填（`bootstrap.ts`，幂等，FTS 同步）：对 agent_run 含 taskId 的 assistant 行，用 agent_artifacts
   中该任务最新 final_result 的 content 重建 text 步骤与 content；失败任务把错误移到 agentRun.error、
   content 置空（若无最终结果）。与上个任务的 `backfillAgentReplyContent` 合并或顺序明确。
   核实 agent_artifacts 的列与 task 关联方式。
6. 测试覆盖：buildTaskBackedAgentRun（有结果 / 无结果 / 失败 / 超长结果不截断）、写入路径 content 推导、
   syncSidecarMessages 新规则、回填幂等与 FTS。服务端 mock.module 规则见 CLAUDE.md。

## 约束
workspace 名导入；桌面组件无内联中文；桌面 matcher 限制；Biome；DB 两处定义同步（预计不改 schema）。
跑 shared / desktop / server / sidecar 测试，desktop & server tsc，biome。

## 验收
task-backed 消息 content 为完整最终结果，失败不写错误进 content；服务端与桌面只有一条推导规则；
存量 163 条回填；实时副本与库一致。

## 实施记录（核实结论，与 PRD 不符处以证据为准）

### 唯一规则
`shared/message-text` 的 `assistantMessageContent(content, agentRun)`：有可解析的 agentRun → content =
text 步骤推导（无 text 步骤即 ""，**不再回退到传入 content**）；无 agentRun（chat）→ 原样。旧的
`agentReplyContent`（有回退）已删除。桌面 `withDerivedContent` 与服务端所有写入方都调用这一个函数。

### 核实结果
1. **agent_artifacts 列**：id, task_id, run_id, type, title, content(NOT NULL), metadata, created_at, updated_at；
   与任务经 task_id 关联，与执行轮经 run_id 关联。不改 schema。
2. **服务端已无任务执行器**：`createAgentArtifact` 在服务端没有任何调用方（执行路由在 49de578 随 /agent
   路由层一起删除）。现在 task-backed 回合只做规划（draft / awaiting_approval），永远产生不了新的
   final_result。所以「完整最终结果」对**新**回合永远为空 → content 为 ""；完整结果只对存量（来自旧执行器的
   artifacts）有意义，由回填处理。`buildTaskBackedAgentRun` 仍按 PRD 实现（有结果即 text 步骤），执行器若恢复即生效。
3. **桌面如何拿到 task-backed 结果**：桌面新消息全部走 sidecar（`chatStore.sendMessage` 无组件调用）。只有
   agent 消息在会话无 channelId / 模型无效时的「重新生成 / 编辑重发」回退到服务端 `regenerateMessage` /
   `editUserMessage`，经 SSE 唯一的 `done` 事件拿到 agentRun → `applyStreamEvent("done")` →
   `updateAgentMessage` → `withDerivedContent`，与库中同一推导；之后 `loadMessages` 重新拉取。读路径
   `getMessagesForUserWithAttachments` 对非终态任务调用 `syncTaskBackedMessages`，同样经推导函数并同步 FTS。
4. **summary / insight 的读者**：桌面不读 `insight`；`agentRun.summary` 只在 DesktopAgentRunPanel /
   DesktopMessageBubble 的进行中 meta 行显示。所以 summary 保留卡片预览（`buildTaskCardSummary`，原
   `buildTaskMessageSummary` 改名），展示不变；`DesktopMessageBubble` 对含 text 步骤的消息只渲染时间线，无双份。
5. **其它「有 agentRun 无 text 步骤、content 非空」的写入方**（PRD 只列了猜测，实际是）：
   - 导入（ChatGPT / Claude.ai 导出 importService，Claude Code / Codex 本地导入 localImportService）：最终正文放
     content、steps 不含 text → 改为 `buildImportedAgentRun(steps, reply)` 把正文作为收尾 text 步骤，content 推导
     （因此会 trim，如 "Done.\n" → "Done."）。纯文本回合仍不带 agentRun（chat 行）。
   - 旧 agent_sessions 迁移（unifiedConversationService）：content = 拼接文本 || 错误 → 文本块按时间线作为
     text 步骤（与工具步骤交错），错误只在 agentRun.error，content 推导。
   - 备份恢复（importService 还原 messages.json）：旧备份行经 `normalizeStoredAgentReply` 拉齐。
   - 旧桌面版本：完成时剥掉 text 步骤、正文留在 content（库中 150 条）；失败时把错误写进 content（21 条，
     含 "Error: X" 前缀形式）。
   - 定时任务 / chat→agent：服务端不写 messages（定时任务走桌面 sidecar → syncSidecar），无需处理。
6. **存量数据**（回填前，dev 库）：437 条带 agentRun 的 assistant 行；163 条 task-backed（133 completed +
   1 failed 有 final_result，5 completed + 2 awaiting_approval 无结果，22 failed 无结果）；非任务行中 232 条
   无 text 步骤但 content 非空（150 旧桌面完成 / 40 旧迁移 / 19 claude-code 导入 / 23 错误文本）。

### 回填（`bootstrap.ts` `backfillAgentReplyContent`，逻辑在 `services/agentReplyNormalization.ts`）
取代上个任务只填空 content 的版本，单遍、幂等（行已对齐则 agentRun 字符串原样返回、不写），content 变化即
重建 FTS 行（为空则只删）。每次启动扫描全部带 agentRun 的 assistant 行（JSON 解析，任务数据批量 3 条查询）。
- task-backed 且任务仍在：用与实时路径相同的选择器（`selectTaskReplyText` / `selectTaskFailure`）重建 text
  步骤与 error；无结果 → content ""。
- 非任务行、无 text 步骤、content 非空：若 status=failed 或 content（去 "Error: " 前缀）等于 agentRun.error →
  视为失败文本，移入 agentRun.error（以用户实际看到的文本为准），content ""；否则作为收尾 text 步骤。
- 已核实：dev 库回填后 437 行 0 条违反规则；task-backed 139 条为完整结果（最长 3365 字符，原上限 160），
  23 条失败行 error 在 agentRun.error、content 为空；第二遍 0 写入。

### 明确的例外 / 不可统一之处
- **任务已删除的 task-backed 行**、**备份恢复的 task-backed 行**（备份不含 agent_tasks）：无法取回完整结果，
  只能走通用规则——存的截断预览成为 text 步骤（失败则移入 error）。这是数据缺失，不是规则分叉。
- **失败行的启发式**：旧桌面在失败时把错误写进 content；也可能有「部分回复 + 失败」被写进 content 的行无法与
  错误文本区分。库中 23 条失败行全部是错误文本，故按「failed 且无 text 步骤 → content 是失败文本」处理。
- FTS 里 1 条长消息的截断位置与 SQL `substr` 不同（JS 按 UTF-16 截 5000），与 `ftsUpsert` 一贯行为一致，非本任务问题。
- 运行中的 dev server（`bun --watch`）在改动时自动重启并已对 data/openhorn.db 执行了新 bootstrap，未手动操作该库。
