# 修复非英文输入法下 Enter 键直接发送消息的 IME 组合问题

## 问题
非英文输入法（如中文拼音）下输入英文字符后按 Enter，消息被直接发送，而不是先将 IME 候选词提交到输入框。

## 根因
欢迎页输入框和消息编辑框的 `onKeyDown` 未检查 `isComposing` 状态。主聊天输入框已有正确守卫。

## 修复范围
1. `apps/desktop/src/components/chat/DesktopWelcomeScreen.tsx:249-254` — 添加 `isComposing` 守卫
2. `apps/desktop/src/components/chat/DesktopChatArea.tsx:1527-1535` — 添加 `isComposing` 守卫

## 修复模式
复用主聊天输入框已有的守卫逻辑：
```typescript
const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
if (composing) return;
```

## 验收标准
- 中文输入法下按 Enter 先提交候选词，不触发发送
- 英文直接输入按 Enter 正常发送
- Shift+Enter 换行不受影响
