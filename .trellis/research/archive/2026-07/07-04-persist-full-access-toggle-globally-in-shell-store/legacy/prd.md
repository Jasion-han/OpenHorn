# 需求：Full Access 开关全局持久化

## 现状

Agent 模式 composer 的 "Full Access" 开关状态是 `DesktopChatArea.tsx` 里的本地 `useState(false)`（约第 1000 行，`onToggleFullAccess={() => setFullAccessEnabled((v) => !v)}` 约第 2330 行）。组件一重挂载（切换会话、重启应用）就重置为 false，不持久化。

## 用户期望

选中 Full Access 后**全局生效并持久保留**：切换会话、新建会话、重启应用都保持开启，只有再次**手动点击该开关**才关闭。

## 方案

把 Full Access 状态从 `DesktopChatArea` 本地 state 提升到 `desktopShellStore`（`apps/desktop/src/stores/desktopShellStore.ts`），复用其已有的 zustand `persist`（localStorage）模式：

- `DesktopShellState` 新增 `fullAccessEnabled: boolean`（初始 false）和 `toggleFullAccess: () => void`（或 `setFullAccessEnabled`）。
- 加入 `partialize`，使其与 `sidebarCollapsed`/`settingsTab` 一样持久化到 `openhorn.desktop.shell`。
- `INITIAL_STATE` 补 `fullAccessEnabled: false`。
- `DesktopChatArea.tsx`：删除本地 `useState`，改为从 `useDesktopShellStore` 读取 `fullAccessEnabled`，`onToggleFullAccess` 改调 store 的 toggle。三处 `permissionMode: fullAccessEnabled ? "full-access" : "default"` 的读取逻辑不变。

## 约束

- 仅桌面端；不改 server/sidecar。
- 现有 `forceWebSearch`（按会话存储，走 updateConversation）行为不变——Full Access 是全局，不要错误地做成按会话。
- 遵循桌面端组件/store 规范与测试矩阵（bun test，仅 toBe/toBeDefined/toEqual/toHaveLength/toMatchObject）。

## 验收

- 打开 Full Access → 切换到其他会话 → 切回 / 新建会话 → 仍为开启。
- 重启桌面应用后 Full Access 仍为开启（localStorage 持久）。
- 再次手动点击 → 关闭，且关闭状态同样持久。
- `pnpm --filter desktop exec tsc --noEmit` 通过；`pnpm --filter desktop exec bun test` 全绿。
