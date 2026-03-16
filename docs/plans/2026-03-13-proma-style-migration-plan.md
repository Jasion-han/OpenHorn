# Proma 风格全端迁移（Web + Desktop）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 `apps/web` 与 `apps/desktop` 统一迁移到 Proma 近似风格：`Tailwind + shadcn/ui(new-york, neutral, CSS variables)`，移除 Mantine，并默认暗色（dark-first）。

**Architecture:** 以 `packages/ui` 作为 UI 单一来源（组件、tokens、共享 CSS、tailwind preset）。Web 保持现有导入路径，通过 wrapper re-export 渐进迁移；Desktop 直接消费 `packages/ui`（必要时短期 fallback 复制最小组件以避免阻塞）。

**Tech Stack:** Next.js 15, Vite, Tauri, React 19, Tailwind CSS, Radix UI, shadcn/ui, class-variance-authority, lucide-react, clsx, tailwind-merge.

---

## Task 1: 建立 `packages/ui` 的最小可用骨架（去 Mantine）

**Files:**
- Modify: `packages/ui/package.json`
- Modify: `packages/ui/src/index.ts`
- Delete/Replace: `packages/ui/src/theme/index.ts`
- Create: `packages/ui/src/lib/cn.ts`
- Create: `packages/ui/src/components/ui/button.tsx`
- Create: `packages/ui/src/components/ui/input.tsx`
- Create: `packages/ui/src/components/ui/textarea.tsx`

**Step 1: 更新 `packages/ui/package.json`（移除 Mantine，补齐 shadcn 依赖）**

- Remove: `@mantine/core`
- Add dependencies (minimum):
  - `@radix-ui/react-slot`
  - `class-variance-authority`
  - `clsx`
  - `tailwind-merge`
- Add peerDependencies:
  - `react`
  - `react-dom`（如果 Desktop 也要直接消费）

Run: `pnpm -C packages/ui install`
Expected: install succeeds.

**Step 2: 新增 `packages/ui/src/lib/cn.ts`**

参考 Web 现有实现：`apps/web/src/lib/utils.ts`。

Run: `pnpm -C packages/ui run typecheck`（如无脚本则 `pnpm typecheck`）
Expected: no TS errors.

**Step 3: 迁入最小组件（Button/Input/Textarea）**

来源参考：`apps/web/src/components/ui/button.tsx`、`apps/web/src/components/ui/input.tsx`、`apps/web/src/components/ui/textarea.tsx`。
注意：将 `@/lib/utils` 改为 `packages/ui` 内部相对导入（指向 `src/lib/cn.ts`）。

Run: `pnpm typecheck`
Expected: no TS errors.

**Step 4:（可选）Commit**

```bash
git add packages/ui
git commit -m "refactor(ui): bootstrap shadcn base components in packages/ui"
```

---

## Task 2: 抽共享样式到 `packages/ui`（tokens + utilities）

**Files:**
- Create: `packages/ui/styles/globals.css`

**Step 1: 创建 `packages/ui/styles/globals.css`**

内容合并来源：
- tokens：`apps/web/src/app/globals.css`（`:root` + `.dark`）
- utilities：`Proma/apps/electron/src/renderer/styles/globals.css`（`shadow-minimal`、scrollbar、`mask-fade-y`、spinner 等）

要求：
- 包含 `@tailwind base; @tailwind components; @tailwind utilities;`
- 保留 `.titlebar-drag-region`/`.titlebar-no-drag`（Desktop 可用，Web 不影响）

**Step 2:（可选）Commit**

```bash
git add packages/ui/styles/globals.css
git commit -m "feat(ui): add shared globals.css (tokens + utilities)"
```

---

## Task 3: 统一 Tailwind 配置（扫描路径 + animation 扩展）

**Files:**
- Modify: `apps/web/tailwind.config.ts`
- Create: `apps/desktop/tailwind.config.ts`
- Create: `apps/desktop/postcss.config.js`

**Step 1: Web Tailwind 扫描包含 `packages/ui`**

Modify `apps/web/tailwind.config.ts`:
- Add content globs for shared UI:
  - `../../packages/ui/src/**/*.{js,ts,jsx,tsx}`
- Add Proma 的 `keyframes/animation`（如 `slide-in-from-top` 等）以保证两端一致

Run: `pnpm --filter web dev`
Expected: styles still load, no missing classes.

**Step 2: Desktop 新增 Tailwind/PostCSS 配置**

Create `apps/desktop/postcss.config.js`:
- plugins: `tailwindcss`, `autoprefixer`

Create `apps/desktop/tailwind.config.ts`:
- `darkMode: 'class'`
- content 包含：
  - `./src/**/*.{ts,tsx}`
  - `../../packages/ui/src/**/*.{ts,tsx}`
- 颜色映射与 plugins 与 Web 对齐（`@tailwindcss/typography`, `tailwindcss-animate` 如需要）

Run: `pnpm --filter desktop dev:ui`
Expected: Tailwind classes take effect (inspect a test div class).

---

## Task 4: Dark-first（Web + Desktop 默认暗色）与引入共享 CSS

**Files:**
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/desktop/index.html`
- Modify: `apps/desktop/src/main.tsx`

**Step 1: Web 默认 dark + 使用共享 CSS**

Modify `apps/web/src/app/layout.tsx`:
- set `<html className="dark" ...>`
- import shared CSS once（推荐在这里 import）：
  - `import 'ui/styles/globals.css'`

Then simplify `apps/web/src/app/globals.css`：
- 若已由 `ui/styles/globals.css` 提供 `@tailwind` 与 tokens，则将本文件改为“仅应用级覆盖”或直接移除引用（保持最小）。

Run: `pnpm --filter web dev`
Expected: app boots in dark theme by default.

**Step 2: Desktop 默认 dark + 使用共享 CSS**

Modify `apps/desktop/index.html`:
- `<html lang="en" class="dark">`

Modify `apps/desktop/src/main.tsx`:
- remove Mantine imports
- import `ui/styles/globals.css`

Run: `pnpm --filter desktop dev:ui`
Expected: desktop UI renders without MantineProvider; dark tokens applied.

---

## Task 5: Web 端 UI 组件逐步 re-export 到 `packages/ui`

**Files:**
- Modify: `apps/web/src/components/ui/button.tsx`
- Modify: `apps/web/src/components/ui/input.tsx`
- Modify: `apps/web/src/components/ui/textarea.tsx`
- (Repeat for other components as needed)

**Step 1: 将 Web 本地组件改为 wrapper**

例如 `apps/web/src/components/ui/button.tsx`：
- 从“本地实现”改为 `export * from 'ui/components/ui/button'`
- 保持现有命名导出不变（避免业务侧改 import）

Run: `pnpm --filter web typecheck`
Expected: no TS errors, runtime unchanged.

**Step 2: 扩展到其余 shadcn 组件**

按使用频率迁移：
- `dialog`, `dropdown-menu`, `scroll-area`, `select`, `tabs`, `tooltip`, `sonner`, `alert-dialog`, `sheet`, `slider` 等

Run: `pnpm --filter web dev`
Expected: no missing component errors.

---

## Task 6: Web Agent 页面移除 Mantine（核心风格统一点）

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`
- (Optional) Create: `apps/web/src/components/ui/card.tsx`（若需要 Card 语义组件）

**Step 1: 先删除 Mantine 依赖用法（保留功能）**

将页面拆分为：
- 顶部工具栏（buttons / model picker / settings link）
- 左侧会话列表（若存在）
- 右侧事件流（ScrollArea）
- 底部输入区（Textarea + buttons）

替换映射：
- `@mantine/core` → shadcn + Tailwind（Input/Textarea/Button/ScrollArea/Badge/Alert）
- `@mantine/modals` confirm → `AlertDialog`
- `@tabler/icons-react` → `lucide-react`

Run: `pnpm --filter web typecheck`
Expected: `@mantine/*` import 为 0（见 Task 10 的 grep 验证）。

**Step 2: Proma 化布局与交互细节**

将列表 item / hover / active 改为 Proma 透明叠色风格：
- `rounded-[10px] text-[13px]`
- `hover:bg-foreground/[0.04] active:bg-foreground/[0.08]`

Manual check: `/agent` 页面与 `/chat` 不再跳风格。

---

## Task 7: Desktop 移除 Mantine 依赖并引入 shadcn 组件

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/main.tsx`

**Step 1: 更新 Desktop 依赖**

In `apps/desktop/package.json`:
- Remove: `@mantine/core`, `@mantine/hooks`, `@tabler/icons-react`（如不再使用）
- Add (minimum):
  - `tailwindcss`, `postcss`, `autoprefixer`
  - `lucide-react`
  - 依赖由 `packages/ui` 提供的 Radix/cva/clsx/tailwind-merge（尽量不要在 desktop 重复装）

Run: `pnpm -C apps/desktop install`
Expected: installs cleanly.

**Step 2: main.tsx 去 MantineProvider**

Modify `apps/desktop/src/main.tsx`:
- remove `MantineProvider`
- import shared CSS `ui/styles/globals.css`

Run: `pnpm --filter desktop dev:ui`
Expected: UI 仍可启动。

---

## Task 8: Desktop AppShell 重写为 Proma 风格三栏布局

**Files:**
- Modify: `apps/desktop/src/App.tsx`

**Step 1: 用 Tailwind 取代 Mantine AppShell**

目标结构：
- 顶部 header：品牌 + sidecar 状态 + workspace path 输入 + Load/Reload
- 主体：`flex` 三栏
  - left: FileTree（宽 280~320）
  - center: EditorPane（flex-1）
  - right: AgentPane（宽 380~460）

背景：Proma 同款 gradient（dark 版本为主）。
面板：内层容器用 `rounded-2xl`、`border border-border/50`、`bg-background/70`、`backdrop-blur`、`shadow-minimal`。

Run: `pnpm --filter desktop dev:ui`
Expected: layout renders, no console errors.

---

## Task 9: Desktop FileTree 迁移（Mantine → shadcn/Tailwind）

**Files:**
- Modify: `apps/desktop/src/components/FileTree.tsx`

**Step 1: 替换图标与按钮**

- `@tabler/icons-react` → `lucide-react`
- `ActionIcon` → shadcn `Button`（`variant="ghost"` + `size="icon-sm"`）

**Step 2: 列表项对齐 Proma**

- row class: `rounded-[10px] text-[13px]`
- hover: `hover:bg-foreground/[0.04]`
- active: 未来可加（若有选中态）

Run: `pnpm --filter desktop dev:ui`
Expected: file navigation still works.

---

## Task 10: Desktop EditorPane 迁移（Tabs + actions）

**Files:**
- Modify: `apps/desktop/src/components/EditorPane.tsx`

**Step 1: Tabs 替换**

方案优先级：
1) 用 shadcn `Tabs`（与 Web/Proma 一致）
2) 若实现成本过高，先用“水平滚动 tabs + 当前选中态”自绘（保持风格一致，后续再替换）

**Step 2: 保存/关闭按钮统一为 shadcn**

Run: `pnpm --filter desktop dev:ui`
Expected: editor still renders Monaco; switching tabs works.

---

## Task 11: Desktop AgentPane 迁移（表单 + Dialog + ScrollArea）

**Files:**
- Modify: `apps/desktop/src/components/AgentPane.tsx`

**Step 1: 表单控件替换**

- `PasswordInput` → `Input type="password"`
- `Textarea/TextInput` → shadcn `Textarea/Input`
- Buttons → shadcn `Button`

**Step 2: Approval Modal 替换**

- Mantine `Modal` → shadcn `Dialog`（或 `AlertDialog`）
- JSON code block 使用 `pre` + Tailwind（并可复用 `packages/ui` 的 code styles）

Run: `pnpm --filter desktop dev:ui`
Expected: approval dialog opens and can Allow/Deny.

---

## Task 12: 清理与验证（Web + Desktop）

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/desktop/package.json`
- (Optional) Modify: root `package.json` if needed

**Step 1: 确认仓库无 Mantine 引用**

Run:
- `rg -n \"@mantine\" apps packages --hidden --glob '!**/node_modules/**'`
Expected: no matches.

**Step 2: 构建/类型检查**

Run:
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build:web`
- `pnpm --filter desktop build:ui`（或 `pnpm --filter desktop build`，按实际脚本）

Expected: all succeed.

**Step 3:（可选）Commit**

```bash
git add .
git commit -m "refactor(ui): migrate web+desktop to Proma shadcn style (dark-first)"
```

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-03-13-proma-style-migration-plan.md`.

Two execution options:
1) Subagent-Driven (this session) — fresh subagent per task, review between tasks
2) Parallel Session — new session running task-by-task execution

