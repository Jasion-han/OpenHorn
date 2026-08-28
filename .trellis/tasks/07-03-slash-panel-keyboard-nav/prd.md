# 斜杠面板键盘导航滚动跟随 + 选中项蓝色高亮

## Goal

Composer 的斜杠（/）命令面板（技能 / MCP / 内置命令统一列表）存在两个体验问题：
1. 用上下箭头把选中项移出可视区域后，列表不自动滚动跟随，选中项看不见
2. 选中项样式只是 `bg-accent` 浅灰，与 hover 几乎无差别，不够醒目

## Root Cause

`apps/desktop/src/components/chat/DesktopComposer.tsx` 256-298 行：
- 滚动容器 `max-h-[280px] overflow-y-auto`（261 行），但组件对 `slashIndex` 变化没有任何 scrollIntoView 副作用
- active 样式（280-282 行）为 `bg-accent text-foreground`，与非选中 hover 的 `bg-accent/60` 对比过弱

键盘索引更新逻辑本身正常（在 ChatArea 的 onKeyDown 里维护 `slashIndex`），仅视口不跟随，因此修复完全收敛在 DesktopComposer.tsx。

## Requirements

1. `slashIndex` 变化（且 `slashOpen`）时，让选中项滚动到可视区内：`scrollIntoView({ block: "nearest" })`，向上/向下都要覆盖；面板刚打开时也要保证初始选中项可见
2. 选中项用蓝色系高亮，与已有的命令高亮色一致（输入框 backdrop 用的是 `text-blue-500 dark:text-blue-400`）：如 `bg-blue-500/10 text-blue-600 dark:text-blue-400`，图标同步变蓝；具体色值与项目现有风格协调即可，但必须与未选中/hover 态有明显区分
3. 鼠标 hover 引起的 `onSlashHover` 索引变化**不得**触发滚动（否则鼠标滑过会导致列表跳动）——只有键盘导航需要跟随；实现上可用「最近一次索引变化来源」区分，或对 hover 造成的变化跳过 scrollIntoView（`block: "nearest"` 在 hover 项本就可见时是 no-op，天然满足，但需确认）
4. 对所有 item 类型（skill / mcp / command）一视同仁——它们在同一个列表里渲染，本就统一
5. 只改 `apps/desktop/src/components/chat/DesktopComposer.tsx`，不碰 DesktopChatArea.tsx（另一任务正在改它，避免冲突）

## 追加缺陷（round 2，用户实测发现）

从第一项按 ↑ 回绕时，选中跳到了"当前视角里的最后一项"而非全局最后一项。已诊断：ChatArea 的回绕计算正确（`(i - 1 + len) % len`），但回绕触发 scrollIntoView 使列表在静止的鼠标指针下滑动，浏览器对指针下的新条目重新 hit-test 触发 `mouseEnter` → `onSlashHover` 把索引改写为指针所在项。修复：hover 改为只响应真实鼠标位移——用 `onMouseMove` + 记录上次 `clientX/clientY`，坐标未变化（滚动引起的合成事件）不触发 `onSlashHover`。注意 Chrome 在滚动后会重派合成 mousemove，必须用坐标比较判定，不能只换事件名。

## Acceptance Criteria

* [ ] 输入 `/` 打开面板，一路按 ↓ 越过可视区最后一项，列表自动滚动，选中项始终可见
* [ ] 一路按 ↑ 回到顶部同样跟随
* [ ] 选中项为蓝色高亮，与 hover 态肉眼可区分
* [ ] 鼠标在列表上滑动不会引起列表自行滚动跳位
* [ ] `npx tsc --noEmit`（desktop）通过；`pnpm --filter desktop exec bun test` 全过
* [ ] biome 对该文件无新增报错

## Out of Scope

* ChatArea 里的 slashIndex 维护逻辑（循环/边界行为保持现状）
* 面板分组、排序、搜索逻辑
* Web 端

## Technical Notes

* 项目规则：不写解释性注释；2 空格缩进 100 行宽；无中文 UI 文案变更
* 该文件当前 git 有未提交改动，保持最小 diff
