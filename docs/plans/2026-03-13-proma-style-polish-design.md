# Proma Style Polish Design

**Goal:** 在不改动页面结构/路由/信息架构的前提下，让 OpenHorn 的 UI 细节更贴近 Proma 的“质感”（density / rounding / border / shadow / focus / hover / overlay）。

**Non-goals:**
- 不新增功能、不改交互路径（例如 Settings 入口仍然只有左侧栏齿轮）。
- 不重构页面布局（不做 “Proma AppShell” 大改造）。
- 不强制全量中文化文案；保留关键术语英文以提升可读性。

## Approach

采用“两层推进”：
1) **组件级 polish（优先）**：先统一复用组件的视觉与交互细节，一次改动覆盖全站（Web + Desktop）。
2) **页面级 polish（随后）**：只在少量页面补齐间距与视觉层级，避免出现“这里像 Proma、那里不像”的割裂感。

## Component-level scope (Wave 1)

### 1) Dialog
- Overlay / Content 增加 `titlebar-no-drag` 以对齐 Proma 的桌面端弹层行为（避免触发窗口拖拽/误触）。
- 不改弹层结构与 API，仅调整 class。

### 2) DropdownMenu
- Content / SubContent 增加 transform-origin（`origin-[--radix-dropdown-menu-content-transform-origin]`）以对齐 Proma 的展开动效与定位稳定性。
- 增加 max-height + `overflow-y-auto`，防止长菜单溢出。
- 不引入新配色，仅使用现有 token（`bg-popover`, `text-popover-foreground`, `border`, `shadow-md` 等）。

### 3) Select
- Content 使用 `bg-card text-card-foreground`（Proma 做法）以减少 popover 与 card 的割裂感。
- Content 增加 transform-origin（`origin-[--radix-select-content-transform-origin]`）与 `titlebar-no-drag`（桌面端一致性）。

### 4) Tooltip / Separator / ScrollArea (minor)
- 小幅对齐：密度、边框透明度与阴影统一走 token；不改 API 与交互行为。

## Page-level scope (Wave 2)
- Web：Login 卡片、移动端侧栏阴影/遮罩、空状态/告警条的间距与字阶做一致性微调（只改 Tailwind class，不改布局）。
- Chat/Agent：提示条/空状态/小标签统一字号、间距和层级。

## Acceptance criteria
- 所有弹窗/下拉/选择器在 Desktop 端不再触发窗口拖拽；动效更稳定。
- 长列表 dropdown/select 不溢出，滚动表现一致。
- Web 与 Desktop 同类控件（弹窗、下拉、选择器）视觉与交互细节一致。

