# 停止生成保留提问与已生成内容

## 背景（第一性原理）
实测（2026-10-31）：Agent 模式写长文时点「停止」，**这一轮的用户提问和已生成的半篇回答都从界面和库中消失**。
用户的提问是用户自己的数据，已生成的文字是已经花费的结果；「停止」的语义是「不要继续生成」，
不是「撤销这一轮」。根因（check agent 报告，需核实）：`useSidecarAgentRun.cancel()`（~617）设
`cancelledRef` 后跳过持久化（~240 `if (cancelledRef.current) return;`），随后 `handleStop`
（DesktopChatArea ~1560）重新从服务端加载，未落库的这一轮就消失了。

同类问题（复核时报告）：
- Chat 模式点「停止」并不会中止 sidecar 的 `chat.stream`：流继续运行并在之后保存完整回复——停止无效。
- 一条 legacy 的已完成 Agent 回复（任务结束但没有最终结果）显示为完全空白的气泡，没有任何状态说明。

## 目标
1. 停止 = 中止生成 + **保存这一轮**：用户消息照常落库；assistant 消息保存已生成的步骤 / 文字（content 仍由
   text 步骤推导，见 shared `assistantMessageContent`），`agentRun.status = "cancelled"`。这对首轮 / 后续轮、
   新发送 / 重新生成 / 编辑重发都成立（重新生成被停止时：保留已生成的部分作为新回复，不能把旧回复删了又什么都没留）。
   确定 in-flight sync 与 cancel 的竞争处理（现有 ~268 的「undo」逻辑要按新语义重审）。
2. 什么都还没生成就停止：用户消息保留；assistant 消息若无任何内容则不保留空气泡（或显示「已取消」——按
   现有 `chat.agent.cancelled` 渲染选择一致的方案，说明理由）。上个任务的 `stopCleanup.ts` 要与新语义一致，
   不能删除已经保存的部分回复。
3. Chat 模式「停止」真正中止 sidecar `chat.stream`（核实 sidecar 是否有对应的 abort 请求，chat run 的 runId
   是否被桌面记录；不行就补齐协议），并同样保存已生成部分。服务端 chat 流（若仍有路径）同理。
4. 渲染：已完成 / 已取消但没有任何回复内容的 Agent 消息显示明确状态，不显示空白气泡（新文案进 i18n）。
5. 测试：停止后的持久化（有部分内容 / 无内容 / 重新生成 / 编辑重发 / Chat 模式），stopCleanup 新语义。
   桌面 matcher 限 toBe/toBeDefined/toEqual/toHaveLength/toMatchObject。

## 约束
workspace 名导入；桌面无内联中文；sidecar 改动后重编（`pnpm --filter sidecar run compile:tauri:host`）；
Biome。跑 shared / desktop / server / sidecar 测试与 tsc。不改迁移，不写 data/openhorn.db。不提交。

## 验收
Agent / Chat 模式停止后：提问保留、已生成内容保留并标记为已停止、刷新 / 重启后仍在；Chat 停止确实中止生成；
没有空白气泡。

## 实现记录（2026-10-31）

### 核实结论（与 PRD 的差异）
- 根因属实：`cancel()` 置 `cancelledRef` 后 `persistOnce` 直接返回，并且已在途的 sync 还会被「undo」删掉；
  `handleStop` 随后 `loadMessages` + `selectStoppedRunOrphans`，未落库的一轮就从界面消失。另一个漏洞：
  `cancel()` 只认 `runRef`（runAgent 返回后才有），在凭据 / 工作区 / MCP 准备阶段点停止什么也不做，run 照样启动。
- Chat「停止」无效属实，但**不需要改 sidecar 协议**：`chat.stream` 的 runId 已登记在 `state.agentRuns`，
  `agent.cancel` 可直接中止它，`runChatStream` / `runCodexChat` 在 abort 时发 `done`。缺的只是桌面端没记录
  `chatStream()` 返回的 runId、`handleStop` 只调了 `abortStreaming()`（那只中止服务端 SSE）。sidecar 未改动，无需重编。
- 服务端 chat 流（regenerate / edit 仍走服务端 SSE）：客户端中止后 adapter 抛 AbortError，`for await` 之后的
  `update` 永远不执行——停止的重新生成 / 编辑什么都没保存。另外 `createSseStream` 的 `finally` 对已被客户端取消的
  流调用 `close()` 会抛出（每次停止都产生一个未处理的 rejection），一并修复（`utils/sse.ts`）。

### 统一语义（单一规则）
停止 = 中止生成 + 按已生成的程度保存这一轮；任何路径都不删除、不在停止后用服务端数据覆盖在场的副本。
- 有输出：Agent 回复保存全部步骤，`agentRun.status = "cancelled"`，content 仍由 text 步骤推导；Chat 回复保存已流出的文字。
  新发送 / 重新生成 / 编辑重发一致（重新生成时部分输出成为新回复）。
- 无输出：
  - 重新生成：旧回复保留（Agent：恢复本地旧消息、不写库；服务端 Chat：中止且无内容时不覆盖旧行，桌面恢复旧消息）。
    这是「不能把旧回复删了又什么都没留」的直接实现——没有新内容，就没有替换。
  - 新发送 / 编辑重发：提问照常落库（编辑后的问题也保留）；Agent 回复存为空的 cancelled run，渲染沿用现有
    `chat.agent.cancelled`「已取消」——选它而不是不落库，因为一轮保持「问 + 答」成对，用户可在该回复上直接重试，
    且与「已停止」的 run 状态同源；编辑不恢复旧回复，因为问题已变，旧回复不再回答它。
- 竞争处理：每个 run 的 `shouldPersist` 一次性守卫决定 done / error / stop 谁落库；stop 先置 `stopped`，其后该 run
  的所有迟到事件被丢弃；原来的 in-flight「undo」删除逻辑按新语义整体移除（停止从不删除已保存内容）。
  stop 控制柄在 `startRun` 的第一个 await 之前安装，准备阶段的停止也能生效；调用方（发送 / 重试 / 编辑）在自己的准备
  await 期间被停止时，以 `stoppedBeforeStart` 交给 `startRun` 按同一路径落库。一次只跑一个 run：新 run 会先停止上一个，
  上一个照样保存已有输出。
- `stopCleanup.ts`（上个任务）删除：它的职责是停止后删除空回复，新语义下停止不删除任何东西，空回复改为显式状态展示；
  其中仍有用的部分（输出判定、id 复用规则）进入 `lib/stopTurn.ts` 并有测试。

### 渲染
- `resolveRunEndState`：已停止且有输出 → 输出下方「已停止生成」(`chat.agent.stopped`)；已停止且无输出 →「已取消」；
  已完成但无任何输出（含 legacy 无最终结果的任务）→「没有生成回复内容」(`chat.reply.empty`)。
- 没有 run 的空回复（停止于首个 token 前的 Chat 回复、无 run 的 Agent 行）同样显示「没有生成回复内容」。

### 无法统一之处
- Chat 回复没有「已停止」的持久标记：chat 行没有 run 记录（`agentRun` 为空），存一个需要新列（不改迁移的约束下不做）；
  若借用 `agentRun`，`assistantMessageContent` 会改由步骤推导 content，Chat 渲染也会变成 Agent 时间线。
  因此 Chat 停止保存部分文字，但刷新后不显示「已停止」；无内容时显示「没有生成回复内容」。
- 服务端 Chat 编辑重发在请求发出前被停止：请求仍会发出并立即中止（服务端会先保存编辑后的问题，回复存为空），
  因为服务端没有「只改问题不生成」的接口；结果与「编辑后立即停止」一致。

### 测试
- desktop `lib/stopTurn.test.ts`：部分输出 / 无输出 / 重新生成（恢复与替换）/ 编辑（只复用 user id）/ 乐观 id、结束状态。
- desktop `chatStore.agentContent.test.ts`：`markMessageStopped` 保留步骤、标记 cancelled、不动全局流状态、不改已完成 run、不碰 chat。
- desktop `DesktopMessageBubble.test.ts`：空回复显式状态。
- server `messageService.stop.test.ts`（真实库 + mock adapter/channel，按快照规则还原）：Chat 重新生成中途停止保存部分、
  未输出就停止保留旧回复、编辑重发停止保存编辑后的问题与部分回复、Agent 停止轮存 cancelled run 与推导 content。
  前两项 Chat 用例在旧代码上失败。
- Agent hook / ChatArea 的停止编排是 React 状态 + sidecar/服务端 I/O，桌面测试环境没有 mock.module（受限 `bun-test.d.ts`），
  因此把全部决策抽到上述纯函数中测试，编排本身靠 tsc 与人工验收。
