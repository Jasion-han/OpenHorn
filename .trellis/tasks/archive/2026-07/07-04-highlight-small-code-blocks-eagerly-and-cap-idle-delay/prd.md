# 消除延迟高亮的可见闪烁：小块同步高亮 + idle 兜底 timeout

## 背景

上一任务（07-04-speed-up-conversation-switch-by-deferring-syntax-highlight）把代码块改成"先纯文本占位、空闲时补高亮"，解决了切换会话卡顿。但引入可见副作用：切到含代码的会话时，代码先是无色纯文本，**约 1 秒后才上色**，包括 1 行的小代码块也闪。

## 根因（已确认，`DesktopMarkdownMessage.tsx`）

1. `scheduleIdle` 用 `requestIdleCallback(run)` **未设 timeout**（`:100`）。idle 回调最低优先级，切换会话时主线程忙于挂载整列消息，回调被拖到 ~1s 才执行。
2. **所有代码块无差别延迟**，包括高亮成本极低的小块（如 1 行 `export ...`），没必要延迟却也闪。

## 方案

### 1. 小代码块同步高亮（首帧即彩色）

- 设阈值（建议按行数，如 `EAGER_HIGHLIGHT_MAX_LINES = 12`；可再叠加字符数上限如 2000 字符防超长单行）。
- `CodeBlock` 内：若 `lineCount <= 阈值`（且字符数不超上限），**初始 `highlighted` 直接为 true**，首帧就渲染 SyntaxHighlighter，不走占位、不调度 idle。
- 只有**大块**（超过阈值）才走现有"占位 → 空闲补高亮"路径。
- 阈值设为模块级常量并加注释说明依据（小块 tokenize 成本可忽略，不值得为它引入闪烁）。

### 2. 给 idle 调度加兜底 timeout

- `scheduleIdle` 里 `requestIdleCallback(run, { timeout: 200 })`，保证即使一直不空闲，最多 ~200ms 也执行高亮；`setTimeout` 兜底分支相应用 200ms（而非 0，避免与同步渲染争抢首帧；也可保留一个较小值，权衡后择一并注释）。
- 目的：大块的"纯文本→高亮"间隔从 ~1s 降到 ≤200ms，几乎不可察觉。

## 约束

- 仅改 `apps/desktop/src/components/chat/DesktopMarkdownMessage.tsx`（如需微调 css 才动 module.css，但不改现有类视觉）；不改 server/sidecar/chatStore。
- 不得回退上一任务的成果：切到**含大量长代码块**的重会话时仍要"先可见、不长时间卡顿"——即大块依旧延迟，只是 timeout 收紧。
- 不得引入布局跳动：小块同步高亮天然无占位、无跳动；大块占位↔高亮的行高/padding/行号 gutter 一致性（上一任务已保证）不得破坏。
- 外观与深浅色跟随不变；深色代码块可读性不回退。
- 遵循桌面端组件规范与测试矩阵（bun test，仅 toBe/toBeDefined/toEqual/toHaveLength/toMatchObject）。

## 验收

- 切到图中这类会话（块都不大）：代码**首帧即彩色**，无纯文本闪烁。
- 切到含超长代码块的会话：整体仍立即可见（大块短暂纯文本后 ≤200ms 上色），无 ~1s 卡顿。
- 无布局跳动；深浅色切换配色正确。
- `pnpm --filter desktop exec tsc --noEmit` 通过；`pnpm --filter desktop exec bun test` 全绿。
