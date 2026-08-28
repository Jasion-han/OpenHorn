# 修复：sidecar 重新生成时新旧 run 输出逐字交错污染消息内容

## 问题

用户在 agent（sidecar 本地）模式下点"重新生成"后，助手消息内容出现两股文本逐字交错（DB 实证：`max_tokens=102我4,` / `用 \`context    messages=[` 这种交替拼接）。markdown 代码围栏因此配对错乱，UI 出现：代码块显示为 Plain text 无高亮、` ```ts ` 标记跑进代码块内部、部分代码脱离代码块按正文渲染。污染内容被原样持久化，无法恢复。

## 根因（已确认）

1. `apps/desktop/src/components/chat/DesktopChatArea.tsx` `handleRetryMessage`：重试复用同一个 `assistantMessageId`，清空内容后启动新 run。
2. `apps/desktop/src/hooks/useSidecarAgentRun.ts` `startRun`：对旧 run 仅 best-effort `client.cancelRun`，不等待、不拦截；旧 run 在途/后续事件仍会到达旧的 `onEvent` 闭包。
3. `apps/desktop/src/stores/chatStore.ts` `applyStreamEvent`/`appendMessageDelta`：仅按 messageId 纯字符串拼接，无 run 所有权校验 → 新旧两个 run 的 delta 交替追加进同一条消息。
4. 次要：`useSidecarAgentRun` 的 `persistedRef` 是 hook 级共享 ref，新 run 启动时重置为 false，旧 run 的 done/error 回调可再次触发 `persistOnce`，可能用旧/污染内容覆盖持久化结果。

## 修复方案

在 `useSidecarAgentRun.ts` 内实现"run 所有权"机制：

- 维护 module 级（或 hook 级 ref）`Map<assistantMessageId, ownerToken>`；每次 `startRun` 生成新 token 并登记为该消息的当前所有者。
- 该 run 的 `onEvent` / `onError` / `onDone` / `persistOnce` / `persistFailure` 全部先校验自己仍是该消息的所有者，不是则直接丢弃（不 applyStreamEvent、不持久化、不改 UI 状态）。
- `persistedRef` 改为每 run 独立（随 token/闭包创建），而不是 hook 级共享。
- 保留现有 `cancelRun` best-effort 调用；所有权校验是兜底，不依赖 cancel 成功。

约束：

- 不改 server 端行为；不改 chatStore 的 append 语义（改动收敛在 hook 层）。
- 正常单 run 流程（无重试）行为不得变化。
- 遵循 desktop 测试矩阵限制（bun test，仅 toBe/toBeDefined/toEqual/toHaveLength/toMatchObject）。

## 验收

- 新增/更新 bun 测试：模拟旧 run 在新 run 启动后继续发 delta/done，断言旧事件被丢弃、消息内容只含新 run 的文本、persist 只发生一次（以新 run 内容为准）。
- `pnpm --filter desktop exec bun test` 全绿；`pnpm --filter desktop exec tsc --noEmit` 通过。
- 手工回归：agent 模式发消息 → 流式中点"重新生成"→ 最终消息内容干净、无交错。
