# Coding Standards

## 格式化 / Lint

- **Biome 2**（`biome.json`），2 空格缩进，行宽 100
- 提交前跑一次 `pnpm check`
- **判断格式诊断是不是自己引入的**：把 HEAD 版本写到**项目内**的临时路径再跑 biome 取基线（写到项目外或用 `--stdin-file-path` 会因为配置作用域不同而得到假的 0 诊断）

## TypeScript

- 全量 strict 模式
- 类型检查统一用 `pnpm typecheck`（按 workspace 逐个运行）

## 测试

- **没有 Jest / Vitest** — 所有测试都走 `bun test`
- 桌面端虽然用 Vite 构建，但测试同样走 `bun test`
- 桌面端的 `apps/desktop/src/bun-test.d.ts` 只声明了有限 matcher（`toBe` / `toBeDefined` / `toEqual` / `toHaveLength` / `toMatchObject`）
- **不要**在桌面端测试里用 `.not` / `toBeNull` / `toBeLessThanOrEqual` / `toBeGreaterThan` / `not.toContain` — 会 tsc 挂掉
- 改用 `.toBe(true)` + 显式比较表达式

## Git Commit 习惯

- **精确 stage**：仓库长期有一批未提交的工作区改动，**不要**用 `git add .` / `git add -A`
- 每次 commit 按文件名 `git add <path> <path>...`，避免拖入无关修改
- 根目录偶尔出现 smoke test 截图（`smoke-*.png` / `phaseC-*.png` 等），commit 前删除

## 测试基线

三个 workspace 的基线都是**全绿**（2026-07-28 实测：server 177 / desktop 180 / sidecar 152，均 0 fail）。**任何失败都是真的**，不存在「预期噪音」。

server 端如果出现成片失败，先怀疑 `mock.module` 未还原 —— 见 `references/gotchas.md#server-测试的-mockmodule-污染`。
