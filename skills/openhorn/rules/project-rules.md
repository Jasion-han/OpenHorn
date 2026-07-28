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

## Agent Runtime

- Agent runtime 的选择由 `channelAgentCheckService.resolveAgentRuntime()` 根据 channel 协议及端点探测结果决定
- 新增 provider 适配器时，请同时实现 `ToolCallingAdapter.runToolCallingTurn`，以便通用 runtime 用户也能用 agent 模式

## 文案与数据真实性

- **不要硬编码显示给用户的文案**
- 中文用户面文案走 `apps/desktop/src/lib/i18n/agent.ts` 字典取值，这是**唯一允许出现中文用户文案的源头**
- 禁止在组件里内联中文字符串；字典查不到时返回 `null`，调用方显式降级（不渲染），**禁止用 fallback 字符串**
- 错误展示走结构化 `errorCode` / `runtimeIssue` 查字典，不做字符串匹配翻译
- server 绝不编造 `message.content`：`buildTaskMessageSummary` 在无真数据时返回空字符串
- Process 行 / 状态机字面量 / 工具名一律保留英文（`Bash` / `Search` / `Approved` 等）

## 环境变量

执行 `cp .env.example .env`，至少需设置 `DATABASE_URL`、`JWT_SECRET`、`ENCRYPTION_KEY`。Provider 密钥（`OPENAI_API_KEY` 等）可选——也可通过 UI 按用户配置。

## Tauri Sidecar 生命周期

改 `apps/sidecar/src/` 后要 `pnpm --filter sidecar run compile:tauri:host` 重新生成二进制，否则 `cargo check` 会失败。该目录在 `.gitignore` 里，不进仓库。
