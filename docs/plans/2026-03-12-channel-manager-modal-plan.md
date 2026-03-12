# Channel Manager Modal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 `ChannelEditorModal` 升级为“分栏渠道管理器（Modal）”：左侧渠道列表（含禁用项）+ 右侧表单（新增/编辑同一套），移动端降级为 Select 切换；底部保存栏固定；保存后自动同步模型且错误直出、不 fallback。

**Architecture:** 仅改 Web 端 `ChannelEditorModal`（必要时微调 `ChannelSettings` 传参/打开逻辑）。复用既有 `applyFetchModelsOutcome` 作为“同步模型结果 -> notice”唯一入口，避免重复实现。

**Tech Stack:** Next.js (app router) + Mantine 7 + Tabler icons + localStorage（`channels.lastProvider`/`channels.lastBaseUrl`）+ 现有 `api.channels.create/update/fetchModels`。

---

### Task 1: 统一“当前编辑对象”状态模型（去掉 SegmentedControl 模式切换）

**Files:**
- Modify: `apps/web/src/components/settings/ChannelEditorModal.tsx`

**Step 1: 引入单一 source of truth 的 active key**

用一个常量 key 表示“新建草稿”：

```ts
const NEW_CHANNEL_KEY = '__new__';
type ActiveKey = string | typeof NEW_CHANNEL_KEY;
```

并用 `activeKey` 取代 `mode + selectedChannelId`：

```ts
const [activeKey, setActiveKey] = useState<ActiveKey>(NEW_CHANNEL_KEY);
const isCreate = activeKey === NEW_CHANNEL_KEY;
const activeChannel = isCreate ? null : channels.find((c) => c.id === activeKey) || null;
```

**Step 2: onOpen 初始化选中项**

- 若 `channels.length === 0`：`setActiveKey(NEW_CHANNEL_KEY)` + `prefillCreateDefaults()`
- 否则：优先默认渠道，其次启用最新更新，否则最新更新；`setActiveKey(id)` + `prefillFromChannel(...)`

保留现有 `pickDefaultChannelId()`，但返回值用于设置 `activeKey`。

**Step 3: 运行 typecheck**

Run: `pnpm --filter web typecheck`

Expected: PASS

**Step 4: Commit**

```bash
git add apps/web/src/components/settings/ChannelEditorModal.tsx
git commit -m "refactor(web): simplify channel editor active selection"
```

---

### Task 2: Desktop 分栏布局（左列表 + 右表单）与 Mobile 降级

**Files:**
- Modify: `apps/web/src/components/settings/ChannelEditorModal.tsx`

**Step 1: 加入响应式判断**

使用 Mantine hooks：

```ts
import { useMediaQuery } from '@mantine/hooks';
const isMobile = useMediaQuery('(max-width: 48em)');
```

**Step 2: Modal body 采用 flex 容器**

目标结构（示意，按 Mantine 组件实现）：

- `Group`/`div` 外层 `display:flex; gap:12; height: min(72vh, 720px)`
- 左栏固定宽度比例（`flex: 0 0 35%`，并设 `minWidth`）
- 右栏 `flex: 1`，内部 `ScrollArea` 滚动表单

移动端：

- 不渲染左栏列表
- 顶部渲染 `Select`（可搜索）用于切换 `activeKey`
- 同时提供 `新建` 按钮把 `activeKey` 切到 `NEW_CHANNEL_KEY`

**Step 3: 左栏列表（Desktop）**

元素：
- 顶部：`Text fw={600}` 标题 + 搜索框（`TextInput leftSection IconSearch`）+ `ActionIcon`/`Button` 新建
- 列表：`ScrollArea` + `Stack`，列表项使用 `Paper` 或 `UnstyledButton`，支持：
  - 单行截断：`Text lineClamp={1}` / `style={{ minWidth: 0 }}`
  - 状态 badge：默认/已禁用
  - 选中态：背景高亮（轻量）

排序规则：
- 默认置顶
- 启用优先于禁用
- 名称排序

禁用渠道“可编辑但视觉弱化”（例如降低 opacity，仍可点击）。

**Step 4: Commit**

```bash
git add apps/web/src/components/settings/ChannelEditorModal.tsx
git commit -m "feat(web): channel manager modal split layout"
```

---

### Task 3: 右侧表单滚动 + 底部操作栏 sticky（始终可见）

**Files:**
- Modify: `apps/web/src/components/settings/ChannelEditorModal.tsx`

**Step 1: 表单区滚动**

把表单内容放入右侧 `ScrollArea`（或 `div` overflowY），避免 Modal 整体高度撑爆页面。

**Step 2: Sticky footer**

在右侧表单容器内新增底部操作栏：

- `position: sticky; bottom: 0;`
- 设背景色（避免滚动内容透出）
- 左侧可放轻量说明（例如“保存后自动同步模型”），右侧放 `取消/保存`

**Step 3: 键盘与可用性**

- 保持 `saving` 时禁用重复提交
- 点击保存失败：toast 直出错误，保持 Modal 打开

**Step 4: Commit**

```bash
git add apps/web/src/components/settings/ChannelEditorModal.tsx
git commit -m "chore(web): sticky footer + scrollable form in channel manager modal"
```

---

### Task 4: 新建/编辑提交逻辑适配 activeKey（复用既有规则，不改行为）

**Files:**
- Modify: `apps/web/src/components/settings/ChannelEditorModal.tsx`

**Step 1: canSubmit 规则**

- create：必须 `name` + `apiKey`（且 `apiKey !== '********'`）
- edit：必须有 `activeChannel` 且 `name` 非空

**Step 2: 保存 payload 仍只提交 diff**

沿用现有 diff 构建逻辑，但将比较对象改为 `activeChannel`。

`apiKey` 规则保持：
- 非空且不等于掩码才提交

**Step 3: 保存后自动同步模型**

仍然：
- `api.channels.fetchModels(id)`
- 调用 `applyFetchModelsOutcome(id, sync)`
- `notifySuccess(...)`：同步失败也不 fallback，仅提示“结果请看渠道提示”

**Step 4: Commit**

```bash
git add apps/web/src/components/settings/ChannelEditorModal.tsx
git commit -m "refactor(web): align submit logic with activeKey channel manager"
```

---

### Task 5: 视觉一致性与长文本处理（优雅但克制）

**Files:**
- Modify: `apps/web/src/components/settings/ChannelEditorModal.tsx`

**Step 1: 文本截断与换行**

- 左侧列表：名称/URL 单行截断（避免把布局撑开）
- 右侧 Base URL / 说明文案：允许 `overflow-wrap:anywhere`，避免长 URL 破坏布局

**Step 2: 与 ModelPickerModal 风格对齐**

对齐点：
- Badge 密度
- `Stack gap` 更紧凑（减少空白）
- 说明文案更短

**Step 3: Lint + Typecheck**

Run:
- `pnpm --filter web lint`
- `pnpm --filter web typecheck`

Expected: PASS

**Step 4: Manual verification**

1. 打开 `http://localhost:3001/settings?tab=channels`
2. 点“渠道管理”打开 Modal
3. Desktop：确认分栏布局；左侧可搜索；禁用渠道可见可编辑
4. 点“+ 新建”：右侧表单切换到空白草稿；Provider/Base URL 走 localStorage 默认
5. 编辑任一渠道保存：不改 key 时不应更新 key；保存后自动同步模型；同步失败错误在渠道卡片 notice 直出
6. 缩窄窗口到移动端：确认左栏隐藏，顶部 Select 可切换渠道，保存栏仍固定

**Step 5: Commit**

```bash
git add apps/web/src/components/settings/ChannelEditorModal.tsx
git commit -m "chore(web): polish channel manager modal ui"
```

---

### Task 6: Push

```bash
git push
```

