# Agent Streaming Placeholder Design

**Goal:** 修复 Agent 在第二轮及之后运行时，等待气泡出现在错误位置的问题，让等待态和当前轮次的 assistant 回复绑定，而不是以全局浮动节点插入时间线。

## Problem

当前 Agent 页面把“等待中”渲染成事件列表外的一个全局 `TypingIndicator`：

- 当本轮尚未收到任何 `text` 事件时，页面直接在列表尾部额外渲染一个 indicator。
- 时间线里同时存在上一轮 assistant 文本和本轮 user 事件时，这个 indicator 不知道自己属于哪一轮，只会按容器布局落在一个“视觉上不稳定”的位置。

Chat 页面没有这个问题，因为它的等待态是绑定到当前 assistant 消息占位节点上的。

## Approach

把 Agent 也改成 Chat 的模式：

- 一旦本轮 user 事件已经写入本地时间线，就立即追加一个本地 `text` 占位事件，代表“当前轮 assistant 正在回复”。
- 后续流式 `text` delta 继续复用现有 `addEvent` 合并逻辑，直接把内容拼到这条占位事件上。
- 删掉页面级的全局 `TypingIndicator` fallback。

## Rendering

- `AgentEventCard` 在 `event.type === 'text'` 且 `isStreaming === true` 且 `content` 为空时，不渲染空白文本气泡，只渲染一个等待指示器。
- 当首个 delta 到达后，占位事件自动变成真实文本消息，并继续在消息下方显示流式指示器。

## Constraints

- 不改服务端事件格式。
- 不引入新的事件类型，继续复用本地 `text` 事件即可。
- 保持现有工具事件、错误事件和重试逻辑不变。

## Verification

- 第二轮发送消息后，等待气泡应紧跟在第二轮 user 消息之后。
- 收到首个文本后，占位节点应平滑变成真实 assistant 消息。
- web typecheck 通过。
