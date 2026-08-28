# 用户消息中的 skill 标签与文字同行、同字号、蓝色展示

## Goal

用户消息气泡中，开头的 slash command 标签（如 `/baoyu-design`）目前渲染为正文上方独立一行的灰色小字（`text-[11px] text-primary/70`）。改为与用户正文同一行内联展示，字体大小与正文一致（`text-sm`），并使用蓝色效果，使 skill 调用视觉上成为消息的一部分。

## What I already know

* 渲染位置：`apps/desktop/src/components/chat/DesktopChatArea.tsx` `MessageBubbleImpl` 内非 assistant 分支（约 872–899 行）
* `splitLeadingCommand()` 已把 `message.content` 拆成 `{ command, body }`，仅当 command 命中已知 skill/MCP 列表时才拆
* 当前结构：`flex flex-col` → command chip（Sparkles 图标 + 11px 小字）在上，`<p className="text-sm">` 正文在下
* 正文使用 `whiteSpace: pre-wrap` + `overflowWrap: anywhere` 保多行换行

## Requirements

* command 标签与正文在同一行（正文首行前缀），正文换行时自然折行
* 标签字号与正文一致（`text-sm`）
* 标签使用蓝色（Tailwind `text-blue-500`，深浅主题下均可读）
* 保留 Sparkles 图标，尺寸随字号放大到与 `text-sm` 匹配（14px），同为蓝色
* 仅有 command 无正文时，只展示蓝色标签本身
* 不改动 `splitLeadingCommand` 的识别逻辑与存储格式

## Acceptance Criteria

* [ ] 发送 `/baoyu-design 请整理成html给我查看`：气泡内 `✦ /baoyu-design` 与「请整理成html给我查看」同行，标签为蓝色 text-sm
* [ ] 多行正文时标签只出现在首行开头，折行正常
* [ ] 仅发送 `/baoyu-design`（无正文）时正常显示蓝色标签
* [ ] 普通以 `/` 开头但非已知命令的文本不受影响
* [ ] `pnpm --filter desktop exec tsc` 通过（沿用现有 typecheck 方式），bun test 无新增失败

## Definition of Done

* typecheck / biome 无新增问题
* 桌面端实际运行验证渲染效果

## Out of Scope

* Composer 输入框内的 slash 面板样式
* assistant 消息的任何样式
* Web 端（组件树独立）

## Technical Approach

把原来的 `flex-col`（chip 一行 + `<p>` 一行）改为单个 `<p className="text-sm">`：command 作为行内 `<span className="text-blue-500">`（含 inline Sparkles 14px 图标）置于正文文本之前，正文文本跟随其后，保留 pre-wrap/anywhere 换行样式。

## Technical Notes

* 无 Chinese UI 文案变更，不涉及 i18n 字典
* 该文件已有未提交改动，注意只做最小 diff
