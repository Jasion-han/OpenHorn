# 移除服务端 Agent 回合死路径

## 背景（第一性原理）
Agent 只由 sidecar 执行。49de578 删除了 `/agent/*` 路由（含审批 / 执行入口），但保留了
`messageService` 中的 task-backed 回合（`createTaskBackedAgentTurn` → `planTaskForTurn` →
`applyTaskBackedAgentTurnToMessage`）。现在它只会**规划**任务（停在 `draft` / `awaiting_approval`），
没有任何东西能再执行或审批它：用户看到一个永远空白的 Agent 气泡，`conversations.runStatus` 停在
draft / awaiting_approval，并且因为状态非终态，每次加载会话消息都会触发 `syncTaskBackedMessages`（约 8 次查询）。

仍能到达这条路径的入口（check agent 报告，需逐条核实）：
1. 桌面重新生成 Agent 回复，会话无 `channelId` 或模型无效：`DesktopChatArea.tsx` ~1274-1275 → ~1326
   `regenerateMessage`（`messageService.ts` ~1558）。
2. 桌面编辑重发，同样条件（~1442-1445 → ~1480 `editUserMessage`，`messageService.ts` ~1375）；
   **另外**：Agent 模式用户消息后面没有 assistant 回复时，即使渠道有效也会走服务端（`existingAssistantMessage`
   为 undefined，服务端按 `userMsg.mode` 走 agent）。
3. `POST /messages` mode=agent（`messageService.ts` ~1125），桌面不调用，仅外部 API。

## 目标
1. **桌面**：重新生成 / 编辑重发的 Agent 路径与「发送」路径一致——无渠道 / 模型无效时报同样的错误
   （发送路径用 `chat.error.noChannel` / `chat.error.noModel`），不再回落到服务端；编辑重发在后面没有
   assistant 回复时也走 sidecar（新建 assistant 消息），与正常发送一致。
2. **服务端**：不再创建 task-backed Agent 回合。`/messages`、regenerate、edit 收到 agent 模式请求时返回明确的
   4xx（错误码 / 文案按现有约定），而不是建一个永不执行的任务。删除因此失去调用方的代码
   （createTaskBackedAgentTurn / applyTaskBackedAgentTurnToMessage / planTaskForTurn 等，以及只为它们存在的
   服务层代码）——逐个核实调用方后再删，保留仍有消费者的部分（例如读取历史 task-backed 消息、
   `syncTaskBackedMessages` 若仍需用于终态旧数据则保留，否则一并处理）。
3. **存量**：库中停在 draft / awaiting_approval 且永远不会推进的任务及其消息 / 会话 runStatus：
   一次性迁移把它们标为终态（如 cancelled），使读取路径不再每次同步；空白气泡的消息显示合理状态
   （核实桌面对 cancelled 的渲染）。
4. **一次性迁移**：`bootstrap.ts` 中 `backfillAgentReplyContent`（38d0a25）每次启动全表扫描。所有写入路径
   已经保证不变量，改为只执行一次（项目里若已有迁移版本 / marker 机制就复用，否则用 `PRAGMA user_version`
   或 settings 表的 marker；先看 bootstrap.ts 已有约定）。第 3 点的迁移同样一次性。
5. 测试：桌面路由判断（可抽成纯函数测试）、服务端 agent 模式请求被拒、一次性迁移只跑一次。

## 约束
workspace 名导入；桌面无内联中文（新增文案进 `apps/desktop/src/lib/i18n/`）；桌面 matcher 限制；
服务端 mock.module 规则；Biome；DB schema 若改两处同步。跑 shared/desktop/server/sidecar 测试，
desktop & server tsc，biome。不要手动改 data/openhorn.db（dev server 会在重启时执行 bootstrap；
写迁移前先用 sqlite3 只读确认数据形态）。

## 验收
没有任何入口能产生永不执行的服务端 Agent 回合；存量卡住的任务归为终态；迁移只跑一次。

## 核实记录（实现时对照代码 / 数据）
- **入口 3 与 PRD 不同**：`POST /messages`（`sendMessage`）mode=agent 从不建任务，只跑一次普通 chat 并把消息标成 agent。
  真正走到 task-backed 的是 `POST /messages/stream`（`streamMessage`）——且**省略 mode 时默认就是 agent**。
  现在两者都在写库前拒绝（stream 只接受显式 `mode: "chat"`），regenerate / edit 在打开 SSE 之前判定 agent 回合并拒绝；
  路由统一返回 400 `{ error, code: "agent_mode_unsupported" }`（`AgentModeUnsupportedError`）。
- 入口 1、2 属实，包括「Agent 用户消息后无回复时，渠道有效也走服务端」。桌面改为 `lib/agentRerunRoute.ts`
  的 `resolveRerunRoute`：agent 回合只走 sidecar，缺渠道 / 模型时报发送路径同样的
  `chat.error.noChannel` / `chat.error.noModel`，且在改动气泡之前判定（拒绝时保留原回答 / 编辑框）。
- 编辑无回复的 Agent 用户消息走 sidecar 时，原持久化逻辑（两个 id 都已持久化才原地更新）会再插一条用户消息。
  `syncSidecarMessages` 新增「只给 userMessageId」：原地更新用户消息并在其后插入回复；桌面相应只传 userMessageId，
  取消回滚时不删除复用的用户消息。
- `agentTaskService.ts` / `agentPlanBuilder.ts` 只被 messageService 的死路径使用（routes / 定时任务 / 导入导出均无引用），
  连同测试删除；`syncTaskBackedMessages`、`buildTaskBackedAgentRun`、`isTerminalTaskStatus` 及读路径同步一并删除
  （迁移后所有 task-backed 消息都是终态，读路径再无可同步的东西）。`agentTaskMessage.ts` 仅保留回填用的
  `selectTaskReplyText` / `selectTaskFailure`。`agent_*` 表保留（会话删除、渠道删除、回填仍读写）。
- 数据（dev 库只读核实）：7 个未终态任务（5 draft、2 awaiting_approval），但只有 2 条消息指向它们；另有 26 条消息
  `taskStatus: "draft"` 而任务早已 completed（陈旧标记）；`conversations.run_status` 有 141 条 `draft`，绝大多数任务其实已完成，
  桌面不读取 `runStatus`——因此迁移把未终态的 run_status 置 NULL（「无运行中」），而不是标成 cancelled。
- 迁移：bootstrap 原无迁移版本机制（`PRAGMA user_version` = 0），新增 `ONE_TIME_MIGRATIONS` + `user_version`：
  1 = `settleServerAgentTasks`（任务 / 运行 → cancelled、pending 审批 → rejected、消息 `agentRun.status/taskStatus`
  对齐任务终态、run_status 置 NULL；只改状态字段，不碰 content / steps；单事务），2 = `backfillAgentReplyContent`。
  在 dev 库副本上演练：任务 7 条 → cancelled，2 条消息 → cancelled，全部消息 content 前后逐行一致，user_version = 2；真实库未改动。
- 回填加固：任务没有 final_result 时保留消息已有的 text 步骤（原逻辑会清空它们）。
- 桌面对「cancelled 且无步骤 / 无错误」的 run 原先渲染为空白，新增 `chat.agent.cancelled`（已取消）元信息行。
