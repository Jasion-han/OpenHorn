# Proma Composer (Web) Design

**Date:** 2026-03-13

**Goal:** 让 OpenHorn Web 的 Chat 与 Agent 使用同一套「Proma 风格」消息输入框与底部工具栏（scope 1），做到视觉与交互一致。

**User decision:** 范围选择 **1**（Attach + Model + Context + Send/Stop + 拖拽/粘贴附件）。

## Non-goals

- 不实现 Proma 的 RichTextInput/TipTap（先用 Textarea 模拟结构与质感）。
- 不加入 Thinking/Speech/ToolSelector 等高级工具（后续再扩展）。
- 不引入新的 Settings 入口（Settings 仍只通过左侧栏齿轮进入）。

## Reference (Proma)

- `Proma/apps/electron/src/renderer/components/chat/ChatInput.tsx`

## UX / UI Spec

### Card container

- 统一容器样式（Chat/Agent 相同）：
  - `rounded-[17px]`
  - `border-[0.5px] border-border`
  - `bg-background/70 backdrop-blur-sm`
  - `pt-2`
  - `focus-within:border-foreground/20`
- 支持拖拽文件覆盖态（Proma 同款）：
  - `border-[2px] border-dashed border-[#2ecc71]`
  - `bg-[#2ecc71]/[0.03]`

### Attachments row (optional)

- 当存在附件时显示在输入区上方：
  - `px-[15px] py-[5px]`
  - `flex flex-wrap gap-1`
  - 先用「文件名 chip + remove」替代缩略图（保持结构位置与 Proma 一致）。

### Input area

- Textarea 透明无边框，靠容器提供视觉边界：
  - `border-0 bg-transparent p-0 shadow-none focus-visible:ring-0`
- Enter 发送/运行；Shift+Enter 换行；IME composing 不触发提交。
- 支持粘贴文件/图片自动作为附件加入（不打断正常文本粘贴）。

### Footer toolbar (40px)

- 工具栏固定高度与左右分组（Proma 同款）：
  - `h-[40px] px-2 py-[5px]`
  - `justify-between`
- 左侧（工具）：
  - Attach（Paperclip，tooltip）
  - Model（触发 ModelPickerModal 的轻量按钮）
  - Context（显示 `Context · N`，dropdown 列表 + remove + clear）
- 右侧（动作）：
  - Send（CornerDownLeft icon button；可发送时 `text-primary hover:bg-primary/10`）
  - Stop（Square icon button；`text-destructive hover:bg-destructive/10`）

## Implementation approach

- 抽取共享组件：`apps/web/src/components/composer/PromaComposer.tsx`
  - Chat 与 Agent 只传入各自的状态与回调，确保长期一致。
- Chat：
  - 使用 AbortController 支持 Stop（覆盖 send / edit / retry 三类流式请求）。
  - Model 入口从 header 下移到底部工具栏（避免重复入口与风格偏差）。
- Agent：
  - Composer 结构与 Chat 对齐；Stop/Run 采用 icon-only Proma 形态。
  - Model 入口同样下移到底部工具栏。

## Acceptance criteria

- Chat 与 Agent 的 composer 卡片外观/密度/按钮风格一致。
- 底部工具栏包含 Attach/Model/Context/Send(or Run)/Stop，布局与 Proma 对齐。
- 拖拽文件到 composer、粘贴图片/文件到输入框能添加附件。
- Chat 侧 Stop 能中断正在进行的 stream（send/edit/retry）。

