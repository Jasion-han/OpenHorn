# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

(To be filled by the team)

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

<!-- How styles are applied (CSS modules, styled-components, Tailwind, etc.) -->

(To be filled by the team)

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

<!-- Component-related mistakes your team has made -->

### Convention: slash 命令 token 的识别规则只有一份

**What**: `/name` token 的边界判定与识别（面板触发、发送解析、气泡 chip、输入框蓝色高亮、编辑重发）一律调用 `apps/desktop/src/lib/slashToken.ts` 的 `findKnownSlashToken` / `findSlashTokenAtCursor` / `stripSlashToken`，禁止在组件内重新实现正则。token 边界定义：`/` 位于文本开头或任意空白之后，token 为到下一个空白为止的 `\S+`。

**Why**: 2026-07-03 之前该规则散落三处（行首正则各写各的），导致"高亮认、发送不认"（builtin 的 name/id 口径不一致）这类漂移 bug。helper 是纯函数，测试在 `slashToken.test.ts`。

**Related gotchas**:
- 面板选择的就地替换必须在选择时用**最新** input 重新验证记录的 token 区间，失效则从光标重推导，兜底只关面板不动文本——直接用陈旧区间或"整段替换"兜底会吃掉用户文字
- builtin 命令识别必须 name 与 id 双匹配，且与高亮口径一致
- 列表滚动会让条目滑到静止指针下触发合成 mouseEnter/mousemove 抢走键盘选中；hover 更新索引必须做指针坐标门控（见 DesktopComposer `slashPointerRef`）
