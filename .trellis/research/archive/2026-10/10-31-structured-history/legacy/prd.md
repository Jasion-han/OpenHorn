# Claude / 直连运行时用真实多轮消息传历史

## 问题
`apps/sidecar/src/agent/claude.ts`（约 518-526 行）和 `direct.ts`（约 872-879 行）把
`conversationHistory` 拼成 `User: ...\n\nAssistant: ...\n\n---\n\nUser: <prompt>` 一段文本，
作为唯一一条 user 消息发出。实测 Claude Sonnet 4.6 有一次把上一轮回答原样重复在开头
（它把这段文本当成要续写的对话记录）。

## 目标
- claude.ts：历史作为 Anthropic `messages` 数组中真正交替的 user / assistant 消息，当前提问
  （含附件文本、图片块）是最后一条 user 消息。
- direct.ts：如果其使用的 agent 库（pi agent，见 `agent.prompt`）支持预置历史消息，则同样处理；
  不支持则保持原样，并在 PRD 末尾记录原因。
- codex.ts / acp.ts 只接受单段文本，**不改**。

## 约束
- 新增一个纯函数（建议放 `agent/context.ts`）把 truncateHistory 结果转为合法消息序列：
  去掉空内容；合并相邻同角色消息（用 `\n\n` 连接）；首条必须是 user（开头的 assistant 丢弃
  或并入，`[N earlier messages omitted]` 那条 user 是 user 所以通常没问题）；若最后一条历史是
  user，则与当前提问合并，保证交替。
- 截断逻辑、token 预算、工具循环、abort 行为不变。
- 测试用 bun test，覆盖：普通交替、相邻同角色合并、开头 assistant、末尾 user 与当前提问合并、
  空历史、带图片的当前提问仍为多块内容。
- 改完 `apps/sidecar/src/` 后运行 `pnpm --filter sidecar run compile:tauri:host`。
- Biome 2 空格 / 100 列；`pnpm --filter sidecar exec tsc --noEmit` 与 sidecar 测试全绿。

## 验收
- 新单测通过；sidecar 全部测试、类型检查、biome 通过；sidecar 二进制已重编。

## 实现记录
- direct.ts 已改：pi agent（`@earendil-works/pi-agent-core`）的 `Agent` 支持
  `initialState.messages` 预置会话记录。历史经 `toPiHistoryMessages` 转为 pi 的
  `UserMessage` / `AssistantMessage`（assistant 合成为 `stopReason: "stop"`、usage 归零、
  归属当前 model，pi 的 transformMessages 按普通文本回放），当前提问仍经 `agent.prompt`
  作为最后一条 user 消息发送（含图片）。

## 追加（实测发现的真正根因）
桌面端实测三轮对话，第三轮仍然先重复「蓝鲸42」再回答。查库发现：Agent 模式的回复只存在
`messages.agent_run` 的 `steps[]` 里（`{type:"text", content}`，chatStore.applyStreamEvent
有意把 delta 写成 text 步骤），`messages.content` 为空字符串。而所有组装历史的地方都只读
`content` 且 `if (!text) continue`，于是 Agent 回复全部被丢掉，模型只看到用户连续几条提问，
把前面的问题当成未回答再答一遍。旧的拼文本方式同样受影响。

### 追加目标
1. 在 `packages/shared` 新增纯函数（如 `messageText({ content, agentRun })`）：`content` 非空
   用 content；否则拼接 `agentRun.steps` 中 `type === "text"` 的 content（`\n\n` 连接，trim）。
   不收 reasoning / thinking / tool 步骤。`agentRun` 可能是对象或 JSON 字符串（服务端行），两者都处理。
2. 桌面端历史组装全部改用它：`DesktopChatArea.tsx` 三处（~1015、~1290、~1465，最好抽成一个
   函数复用）和 `lib/backgroundTaskRunner.ts` 的 `loadConversationHistory`。
3. 复制按钮：`DesktopMessageBubble.tsx` 的 `copyValue` 在 displayContent 为空时用 Agent 回复正文。
4. 服务端 `apps/server/src/services/messageService.ts` 中传给 `buildChatMessages` 的会话消息：
   Agent 消息 content 为空时用同一函数取正文（混合模式会话切到 Chat 模式也能看到 Agent 回复）。
5. 测试：shared 函数单测；桌面端历史组装单测（matcher 仅 toBe/toBeDefined/toEqual/toHaveLength/toMatchObject）；
   服务端如有合适位置加一条。
