---
name: openhorn
version: "1.0"
description: >
  This skill should be used when the user asks to "fix a bug in OpenHorn",
  "add a feature", "modify server/desktop/sidecar code", "update the database schema",
  or "work on the agent runtime". Activate when the task involves any code change,
  architecture question, or debugging within the OpenHorn monorepo.
primary: true
---

# OpenHorn

AI-native 聊天与 Agent 平台，基于 Turborepo + pnpm monorepo 构建。

## Always Read

这些文件适用于每个任务，优先阅读：
1. `rules/project-rules.md` — 项目约束、数据库同步规则、包管理
2. `rules/coding-standards.md` — 编码规范、测试约定、Git 习惯

## Common Tasks

每条列出需要读的精确文件，不要读未列出的文件：

- 修复 Server bug → 读 `rules/project-rules.md` + `references/architecture.md` § Server；按 `workflows/fix-bug.md` 执行
- 修复桌面端 bug → 读 `rules/project-rules.md` + `rules/desktop-rules.md` + `references/architecture.md` § 桌面应用；按 `workflows/fix-bug.md` 执行
- 修改 Agent runtime / 适配器 → 读 `rules/project-rules.md` + `references/architecture.md` § Server + § 数据流；按 `workflows/fix-bug.md` 执行
- 修改数据库 schema → 读 `rules/project-rules.md` § 数据库同步；参考 `references/architecture.md` § 数据库
- 修改 Sidecar → 读 `rules/project-rules.md` + `rules/sidecar-security.md`；参考 `references/architecture.md` § Sidecar
- 添加新功能 → 读 `rules/project-rules.md` + 对应领域的 `rules/*.md`；参考 `references/architecture.md`
- **其他 / 未列出的任务** → 读 `rules/project-rules.md` + `rules/coding-standards.md`，然后按 `workflows/` 中最匹配的文件名执行

## Known Gotchas

- bootstrap.ts DDL 和 Drizzle schema 必须同步更新 — 见 `references/gotchas.md#双份-schema`
- 桌面端 bun-test.d.ts 只声明了有限 matcher，不要用 `.not` 等 — 见 `references/gotchas.md#桌面端测试-matcher`
- Server 测试基线是全绿，任何失败都是真的；成片失败多为 `mock.module` 未还原 — 见 `references/gotchas.md#server-测试的-mockmodule-污染`
- 改 sidecar 代码后必须 `compile:tauri:host` 重新编译 — 见 `references/gotchas.md#sidecar-编译`
- SDK 的 `tools` 是白名单，漏掉 `ToolSearch` 会让 MCP schema 全量进 prompt — 见 `references/gotchas.md#agent-每轮吃掉几万-token`
- macOS 无原生标题栏，拖拽区要逐块声明 `data-tauri-drag-region` — 见 `references/gotchas.md#macos-窗口拖不动`

## Rule Priority
1. `CLAUDE.md` — 仓库根目录，**唯一入库的那份**，与本目录冲突时以它为准
2. `skills/openhorn/SKILL.md`
3. `skills/openhorn/rules/`
4. `skills/openhorn/workflows/`
5. `skills/openhorn/references/`
6. 根目录 `README.md`

## Project Boundaries
- 本项目覆盖 `apps/server`、`apps/desktop`、`apps/sidecar` 及 `packages/*`（`adapters` / `db` / `shared` / `ui`）
- 历史上的 `apps/web` 与 `packages/agent` **均已删除**，文档里再出现即为过期
- 不覆盖外部依赖的上游 bug（Claude Agent SDK、Tauri、Drizzle 等）
