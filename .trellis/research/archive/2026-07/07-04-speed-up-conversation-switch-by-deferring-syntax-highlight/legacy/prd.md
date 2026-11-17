# 加速会话切换：延迟语法高亮 + memo 化 markdown 消息

## 问题

从一个会话切到另一个会话时，目标会话消息多且含大量长代码块（如 SDK 文档类会话）时，画面"半天才显示"。

## 根因（已确认）

1. `apps/desktop/src/components/chat/DesktopMarkdownMessage.tsx` 每个代码块都用 `react-syntax-highlighter` 的 Prism **同步高亮**（`:158`），长代码块 tokenize 吃 CPU 且阻塞主线程。
2. `DesktopMarkdownMessage` **未 memo 化**（`export function` 直接导出）。
3. 切换时（缓存未命中路径，`chatStore.selectConversation`）一次性挂载**全部**消息，每条同步跑 markdown 解析 + 代码高亮 → 主线程阻塞。
（消息列表虚拟化不在本次范围，作为后续可选项。）

## 方案（本次只做 1+2，不做虚拟化）

### 1. 延迟语法高亮（核心）

让会话内容**先立刻可见**，语法高亮在挂载后于空闲时补上：

- 代码块首帧渲染一个**轻量占位**：用与高亮后布局一致的容器 + `<pre><code>` 纯文本（保留现有 codeHeader / 行号槽 / CopyButton / 配色边框，避免高亮补上时的布局跳动）。
- 挂载后用 `startTransition` + `requestIdleCallback`（无则 `setTimeout(0)` 兜底）将该代码块切换为 `SyntaxHighlighter` 高亮版本。
- 结果：切换会话时消息秒显示为纯文本代码，随后逐块点亮高亮，不再阻塞首帧。
- 保持深色/浅色主题跟随（现有 `isDark` + `THEME_MODE_CHANGE_EVENT` 逻辑不变）。

### 2. memo 化

- 用 `React.memo` 包裹 `DesktopMarkdownMessage`（比较 `content`），避免父组件无关重渲染时重复解析/高亮（对流式、滚动同样有益）。
- 代码块高亮组件可拆成独立子组件承载"占位→高亮"的本地状态，便于按块延迟且各自 memo。

## 约束

- 仅桌面端；不改 server/sidecar/chatStore 的数据流。
- 不改变最终渲染外观：高亮补上后与当前视觉一致（配色、行号、CopyButton、边框、滚动条）。
- 纯文本占位与高亮版的**内边距/行高/字体**必须一致，杜绝点亮时的跳动。
- 遵循桌面端组件规范与测试矩阵（bun test，仅 toBe/toBeDefined/toEqual/toHaveLength/toMatchObject）。
- 深色模式代码块可读性（前序修复）不得回退。

## 验收

- 切到含多个长代码块的会话：消息**立即显示**（纯文本代码先出），随后高亮点亮，无长时间白屏/卡顿。
- 高亮补上后外观与现状一致，无布局跳动。
- 单条消息重复渲染（如流式）不重复整体解析。
- 深浅色切换下代码块配色仍正确跟随。
- `pnpm --filter desktop exec tsc --noEmit` 通过；`pnpm --filter desktop exec bun test` 全绿。
