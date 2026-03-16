# Proma 风格全端迁移（Web + Desktop）设计稿

**日期：** 2026-03-13  
**目标项目：** `OpenHorn`（本仓库）  
**对标项目：** `Proma`（`/Users/han/Project/Proma`）

## 1. 背景与动机

当前 `OpenHorn` 的 UI 技术栈与风格存在分裂：

- `apps/web` 以 Tailwind +（shadcn 风格）Radix 组件为主，但 **Agent 页面仍使用 Mantine**，导致页面间风格跳变。
- `apps/desktop`（Tauri + Vite）整体基于 **Mantine**，与 Web 风格不一致。
- `packages/ui` 目前为空壳/不完整（存在 Mantine theme，但缺少组件实现），未形成可复用的统一 UI 基座。

目标是将 Web 与 Desktop 统一迁移到与 `Proma` 接近的 UI 风格与组件体系，形成长期可维护的“单一来源”（Single Source of Truth）。

## 2. 目标（Goals）

1. **全端统一风格**：`apps/web` 与 `apps/desktop` 在视觉语言与交互细节上保持一致（与 `Proma` 接近）。
2. **统一组件体系**：移除 Mantine，使用 `Tailwind + shadcn/ui(new-york) + CSS Variables 主题` 作为基础。
3. **暗色优先（Dark-first）**：默认以暗色主题启动（Web / Desktop 均默认 `dark`）。
4. **可持续迭代**：将 UI 组件、样式工具类、tokens 抽到共享包，避免两端重复维护导致漂移。

## 3. 非目标（Non-goals）

- 不追求 100% 像素级复刻 `Proma`（允许业务差异与信息架构差异）。
- 不在本阶段实现完整的主题切换面板（light/system 切换可作为后续增强）。
- 不引入复杂的设计系统平台（如 Storybook/Chromatic）作为本次必选项。

## 4. 迁移范围（Scope）

### 4.1 必改范围

- Web：`apps/web`
  - 将 `apps/web/src/app/(app)/agent/page.tsx` 从 Mantine 迁移到 shadcn + Tailwind
  - 统一 Shell / 导航 / Chat 视觉到 Proma 风格
  - Dark-first 默认启动
- Desktop：`apps/desktop`
  - 移除 MantineProvider 与 Mantine 组件，迁移到 shadcn + Tailwind
  - Dark-first 默认启动
- Shared：`packages/ui`
  - 作为 **唯一权威** 的 UI 组件与样式基座（组件、cn/utils、共享 CSS、tailwind preset）

### 4.2 允许延后范围

- 主题切换 UI 与持久化（light/dark/system）
- 更复杂的动效体系（除 Proma 已用到的少量 keyframes）
- 视觉回归测试自动化（可后续补）

## 5. Proma 风格锚点（Truth Anchors）

以 `Proma/apps/electron` 为基准，风格锚点包括：

1. **shadcn/ui 配置**：style=`new-york`、baseColor=`neutral`、cssVariables=`true`。
2. **透明叠色 hover/active**：大量使用 `foreground/[0.04~0.08]` 做交互反馈，减少“硬边框”。
3. **暗色优先**：整体在暗色环境下对比度与可读性表现优先保证。
4. **布局氛围**：背景渐变（light/dark 双版本）+ 内层卡片面板（圆角、柔阴影、轻边框、backdrop blur）。
5. **关键尺寸**：
   - 列表项：`rounded-[10px]`、`text-[13px]`、紧凑但可点按
   - 输入区容器：`rounded-[17px]`、`border-[0.5px]`、`bg-background/70 backdrop-blur-sm`

## 6. 目标技术栈（Target Tech Stack）

- React（Web：Next.js 15；Desktop：Vite + Tauri）
- Tailwind CSS（两端一致）
- shadcn/ui（Radix UI primitives + cva + CSS variables）
- `lucide-react`（统一图标语言）
- `clsx` + `tailwind-merge`（统一 class 合并）

## 7. 共享 UI 基座设计（packages/ui）

`packages/ui` 将承担以下职责：

1. **组件（shadcn/ui）**：`src/components/ui/*`  
   以 OpenHorn Web 现有 shadcn 组件为起点，补齐 Proma 常用组件（tabs/sheet/slider/alert/…）。
2. **工具函数**：`src/lib/cn.ts` 等（提供 `cn()`）。
3. **共享样式**：`styles/globals.css`
   - CSS variables tokens（:root/.dark）
   - Proma 质感工具类：`shadow-minimal`、`mask-fade-y`、scrollbar、spinner 等
4. **Tailwind 预设（可选但推荐）**：`tailwind/preset.ts`
   - 统一 colors 映射（`--background` / `--foreground` / `--border` 等）
   - 统一 keyframes/animation（如 Proma 的 `slide-in/out`）

应用侧（Web/Desktop）只保留最小配置与少量应用级覆盖，避免 tokens 分叉。

## 8. Dark-first 策略

### 8.1 Web
- 在 `apps/web/src/app/layout.tsx` 默认给 `<html>` 添加 `className="dark"`。
- 将 `ui/styles/globals.css` 作为全局样式入口（由 root layout import）。

### 8.2 Desktop
- 在 `apps/desktop/index.html` 默认 `<html class="dark">`。
- 在 `apps/desktop/src/main.tsx` import `ui/styles/globals.css`。

> 后续若要支持切换：再引入 “读取设置 → 应用到 DOM” 的初始化器（参考 Proma 的 theme initializer 思路，但本次不强制实现）。

## 9. 迁移策略（Phased Migration）

1. **先共享基座**：搭建 `packages/ui` 与共享 styles/preset，保证两端引用一致。
2. **Web 去 Mantine**：优先消除 Web 端的风格跳变（Agent 页面）。
3. **Desktop 去 Mantine**：引入 Tailwind + shadcn 后逐个组件迁移。
4. **最后清理依赖**：移除 `@mantine/*` 与 `@tabler/icons-react`，确保仓库干净。

## 10. 风险与应对（Risks & Mitigations）

1. **Desktop(Vite) 消费 workspace 包的 TS/CSS 可能有构建/热更新问题**
   - 预案：短期复制最小组件到 `apps/desktop/src/components/ui/*` 兜底，跑通后再回收至 `packages/ui`。
2. **Tailwind content 扫描范围不足导致 class 被 purge**
   - 方案：两端 `tailwind.config.*` 都包含 `../../packages/ui/src/**/*.{ts,tsx}` 等路径。
3. **全局 base 样式影响 Monaco**
   - 方案：Monaco 容器明确背景/边框，必要时局部 reset。

## 11. 成功标准（Success Criteria）

- `apps/web` 与 `apps/desktop` 启动后默认暗色，UI 风格一致且接近 Proma。
- 仓库内不再有 `@mantine/*` 的运行时代码依赖（允许 lockfile 历史残留但建议清理）。
- 基础组件与 tokens 以 `packages/ui` 为单一来源，避免“复制粘贴分叉”。

