# Project Rules

## 包管理

- 包管理器为 **pnpm**（见 `package.json` 的 `packageManager` 字段），锁文件只有 `pnpm-lock.yaml`
- server / sidecar 的**运行时**是 Bun，测试也走 `bun test`，但依赖安装一律用 pnpm
- 通过 workspace 名称导入共享包（`import { users } from "db";`），**不要使用相对路径**；`shared`、`ui` 同理
- `packages/shared/src/types` 是 server 与前端共享 DTO 类型的唯一来源

## 数据库同步

**每张表都定义了两份**，修改数据模型时**两边都要改**：

1. **Drizzle schema**：`packages/db/src/schema/index.ts` — 用于类型安全查询及 `drizzle-kit`
2. **Bootstrap DDL**：`apps/server/src/db/bootstrap.ts` — 真正的运行时迁移路径，每次 server 启动执行 `CREATE TABLE IF NOT EXISTS`

对全新部署而言，bootstrap DDL 才是权威。

只需对每个数据库执行一次的**数据**迁移（回填、存量修正）追加到 `bootstrap.ts` 的 `ONE_TIME_MIGRATIONS` 末尾，每条带固定 `id`：执行后按 id 记入 `schema_migrations` 表（不再用 `PRAGMA user_version` 计数，旧库的 user_version 在首次启动时一次性折算成记录），只能追加，id 不能改。Schema 变更仍写成幂等的 `ensure*` 步骤。

**迁移前自动备份**：bootstrap 在第一个会删行 / 覆盖已有值 / 重建表的步骤之前，用 `VACUUM INTO` 把库快照到 `<库所在目录>/backups/`（文件名含时间戳和迁移前已应用的迁移数，保留最近 5 份）；快照失败则拒绝迁移、启动失败。待执行的 `ONE_TIME_MIGRATIONS` 和 `rebuildTables` 自动走这道闸；新写的破坏性 `ensure*` 步骤必须先 `backup.ensure(...)`。只加表 / 加列 / 加索引、给刚加的列填值的步骤不备份，所以无事可做的启动不拷贝。`bun test`（NODE_ENV=test）、内存库、远程库不备份。

**重建表**一律用 `rebuildTables`：按 SCHEMA_DDL 的建表语句、**按列名**拷贝、单事务、事后重放索引 DDL。禁止手写固定列清单或 `INSERT ... SELECT *`——旧库列数 / 列序不同会失败或错位（2026-07 旧库启动即失败、users 被清空的根因）。

## Agent Runtime

- Agent runtime 的选择由 `channelAgentCheckService.resolveAgentRuntime()` 根据 channel 协议及端点探测结果决定
- 新增 provider 适配器时，请同时实现 `ToolCallingAdapter.runToolCallingTurn`，以便通用 runtime 用户也能用 agent 模式

## 文案与数据真实性

- **不要硬编码显示给用户的文案**
- 中文用户面文案走 `apps/desktop/src/lib/i18n/agent.ts` 字典取值，这是**唯一允许出现中文用户文案的源头**
- 禁止在组件里内联中文字符串；字典查不到时返回 `null`，调用方显式降级（不渲染），**禁止用 fallback 字符串**
- 错误展示走结构化 `errorCode` / `runtimeIssue` 查字典，不做字符串匹配翻译
- server 绝不编造 `message.content`：有 agentRun 的 assistant 消息 content 一律由 `shared/message-text` 的 `assistantMessageContent` 从 text 步骤推导；服务端不再执行 Agent 回合（旧任务型回合仅由 bootstrap 一次性回填处理），没有 text 步骤的 run content 为空字符串
- Process 行 / 状态机字面量 / 工具名一律保留英文（`Bash` / `Search` / `Approved` 等）

## 环境变量

执行 `cp .env.example .env`，至少需设置 `DATABASE_URL`、`JWT_SECRET`、`ENCRYPTION_KEY`。Provider 密钥（`OPENAI_API_KEY` 等）可选——也可通过 UI 按用户配置。

## Tauri Sidecar 生命周期

改 `apps/sidecar/src/` 后要 `pnpm --filter sidecar run compile:tauri:host` 重新生成二进制，否则 `cargo check` 会失败。该目录在 `.gitignore` 里，不进仓库。
