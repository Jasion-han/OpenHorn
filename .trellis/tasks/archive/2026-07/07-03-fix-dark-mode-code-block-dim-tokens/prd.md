# 修复深色模式下代码块语法高亮文字过暗不可读

## 问题

用户反馈：晚上（系统自动切换到深色模式后）聊天消息里的代码块文字几乎不可见——普通标识符/字符串呈深灰色叠在深色背景上，只有关键字等彩色 token 勉强可见。

## 根因

- `DesktopMarkdownMessage` 根据 `document.documentElement` 是否含 `dark` class 选择 oneDark / oneLight 语法主题，但只通过监听 `THEME_MODE_CHANGE_EVENT` 事件来刷新该状态。
- `ThemeListener`（`apps/desktop/src/components/theme/ThemeListener.tsx`）在两个路径下更新了 `dark` class 但**没有派发** `THEME_MODE_CHANGE_EVENT`：
  1. 系统 `prefers-color-scheme` media change（主题模式为 system 时，晚上 macOS 自动切深色即此路径）
  2. 跨窗口 `storage` 事件
- 结果：界面随 `.dark` class 变深色，但已挂载的代码块仍用 oneLight（浅色主题深灰文字）渲染 → 不可读。
- 首屏无此问题：`apps/desktop/index.html` 内联脚本在 React 挂载前已设置 class，组件 mount 时 `compute()` 读取正确。

## 修复方案

在 `ThemeListener` 的 `onMedia` 与 `onStorage` 处理器中，`applyThemeMode` 之后补发 `window.dispatchEvent(new Event(THEME_MODE_CHANGE_EVENT))`。

- 不会死循环：`onCustom`（监听同事件）只调用 `applyFromStorage`，不再派发。
- `setThemeMode`（设置页手动切换）本就派发事件，该路径不变。

## 验收

- 主题模式为 system 时，模拟系统深/浅色切换，代码块语法主题跟随切换（oneDark ↔ oneLight）。
- 设置页手动切换 light/dark 仍正常。
- `pnpm --filter desktop exec bun test` 与 desktop tsc 通过。
