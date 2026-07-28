# Gotchas

## 双份 Schema

**Symptom:** 新增字段后，运行时表里没有该列，或 Drizzle 类型推导缺失
**Cause:** 数据库表定义在两处：`packages/db/src/schema/index.ts`（Drizzle）和 `apps/server/src/db/bootstrap.ts`（DDL），只改了一边
**Fix:** 两边同时改
**Prevent:** 提交前搜索两个文件确认一致

## 桌面端测试 Matcher

**Symptom:** `tsc --noEmit` 在桌面端测试文件上报类型错误
**Cause:** `apps/desktop/src/bun-test.d.ts` 只声明了 `toBe` / `toBeDefined` / `toEqual` / `toHaveLength` / `toMatchObject`，不支持 `.not` / `toBeNull` / `toBeLessThanOrEqual` 等
**Fix:** 改用 `.toBe(true)` + 显式比较表达式（如 `expect(x === null).toBe(true)`）
**Prevent:** 桌面端测试代码审查时检查 matcher 是否在白名单内

## Server 测试的 mock.module 污染

**Symptom:** 单跑某个测试文件是绿的，全量 `bun test` 时它后面的一批文件成片失败（`db.delete is not a function` / `Export named 'getChannels' not found`）
**Cause:** Bun 的 `mock.module()` 是**进程全局**且无法反注册。任何 mock 了 `../db` 的测试如果不还原，同进程后面所有测试都拿到被替换的模块
**Fix:** 在求值时快照真实模块（`{...realDbNs}`），`afterAll` 里还原。参考 `channelService.agent-check-baseurl.test.ts`
**Prevent:** server 基线是 **177 pass / 0 fail**（2026-07-28 实测）——**任何**失败都是真的，不存在「预期噪音」。这条以前写着「总有 ~15 个失败，无需修复」，那个基线早就修好了，照着忽略会把真 bug 放过去

## Sidecar 编译

**Symptom:** `cargo check` 报 `externalBin` 指向的文件不存在
**Cause:** 改了 `apps/sidecar/src/` 但没重新编译
**Fix:** `pnpm --filter sidecar run compile:tauri:host`
**Prevent:** 改 sidecar 代码后立即执行编译命令

## Agent 每轮吃掉几万 token

**Symptom:** 一句「用一句话解释 X」的 agent 回合，prompt 就有 2-3 万 token；每开一个 MCP server 还会涨
**Cause:** 两层，第二层最容易漏
1. Claude Agent SDK 的 `options.tools` 是**内置工具白名单**。`apps/sidecar/src/agent/claude.ts` 里那份清单如果没有 `ToolSearch`，就等于关掉了 Claude Code 的延迟加载，所有 MCP 的工具 schema 全量进 prompt 前缀，而且 agent loop 每轮重发一次
2. 加了 `ToolSearch` 只降一点点的话，看 CLI 版本。`pathToClaudeCodeExecutable` 曾经走 `which claude` 指向宿主机上碰巧装的那个 —— **2.1.x 只延迟内置工具，2.2.0 才连 MCP schema 一起延迟**

实测（同一句话，6 个 MCP server）：

| CLI | 无 ToolSearch | 有 ToolSearch |
|---|---|---|
| 宿主 2.1.212 | 16,820 | 9,827 |
| SDK 自带 2.2.0 | 20,118 | **2,233** |

**Fix:** `tools` 里带上 `ToolSearch`；CLI 用 `@anthropic-ai/claude-agent-sdk/embed`（打包时把 cli.js 嵌进 $bunfs，运行时解压），不要依赖 PATH
**Prevent:** 排查此类问题不要靠猜——用 SDK 直接搭个台架，把 OpenHorn 的 queryOptions 逐项加进去二分。当时 hooks / canUseTool / includePartialMessages / env / 模型名逐个试过都是 2,233，唯一变量是 CLI 版本
**Note:** Claude Code 自己在两种情况下会**静默关掉**延迟加载：模型不支持 `tool_reference` block，或 `ANTHROPIC_BASE_URL` 指向非 `api.anthropic.com` 的中转（可用 `ENABLE_TOOL_SEARCH=true` 强开，前提是中转能透传 `tool_reference`）。不认识的工具名会被忽略而不是报错，所以加 `ToolSearch` 对旧 binary 是安全降级

## macOS 窗口拖不动

**Symptom:** 窗口只有某一小块能拖动，其余地方按住没反应
**Cause:** macOS 走 `TitleBarStyle::Overlay`（`apps/desktop/src-tauri/src/lib.rs`），没有原生标题栏，**拖拽区必须前端逐块声明** `data-tauri-drag-region`。哪块没声明哪块就拖不动，而且没有任何报错
**Fix:** 给该区域顶部补一条 32px 的 `data-tauri-drag-region`；交通灯所在的那一列还要加 `titlebar-traffic-light-inset`（左缩进 80px 让开按钮）
**Prevent:** 新增顶部布局分支时同步问一句「这块的顶部谁负责拖拽」。侧栏展开/收起这类互斥分支尤其容易只做一半——历史上就是收起有、展开没有

## Git 精确 Stage

**Symptom:** 提交了不相关的工作区文件
**Cause:** 仓库长期有未提交的改动文件，用 `git add .` 会全部拖入
**Fix:** 只用 `git add <path> <path>...` 精确 stage
**Prevent:** 永远不用 `git add .` / `git add -A`
