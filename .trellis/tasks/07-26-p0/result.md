# 修复结果

## 完成项

| 编号 | 问题 | 改动 | 验证 |
|---|---|---|---|
| C2 | Codex delta 只入缓冲不转发 | `codex.ts` text 事件直通 `onEvent`，删除 `finish()` 的 8字符/15ms 补发与 `pendingText` 变量 | 新增 `codex.test.ts` 7 例（此前该文件零测试）。**端到端未验**：本机 codex CLI 上游 502 |
| C3 | codex 分支丢失 conversationHistory | `RunCodexAgentInput` 加字段，`index.ts` 透传，按 direct.ts 同款格式前置拼入 prompt | 类型检查 + 测试通过 |
| C1 | checkpoint 收绝对路径必抛错 → 回滚永久失效 | `claude.ts` 调用前经 `toWorkspaceRelative`；空 catch 改为记录日志 | **端到端实测 + 反向验证**（见下） |
| A1 | server bash 透传 `process.env` | 改用 `sanitizeChildEnv(process.env)`，补 120s timeout | 测试通过 |
| A2 | shellRisk 黑名单默认 allow | 复用 sidecar 的白名单实现（提到 `shared/shell-risk`，两侧 re-export） | server 154 pass 不变 |
| A3/A4 | direct/claude 未用 sanitizeChildEnv | 两处接入；实现提到 `shared/child-env` | 新增 5 例静态断言测试 |
| — | **额外发现**：`chatCodex.ts` 的 `Bun.spawn` 同样裸继承环境 | 一并接入 `sanitizeChildEnv` | 被上述静态断言覆盖 |
| C7 | 默认 workspace `/tmp` 与 deny-list 冲突 | 新增 `resolveDefaultWorkspaceRoot()`（`~/OpenHorn Workspace`，自动创建）；desktop 传空串由 sidecar 决定；移除 `\|\| homedir()` 降级；失败不再静默 | 新增 2 例 workspace 测试 + 1 例 store 测试 |

## C1 的决定性证据

同一脚本，仅切换 `toWorkspaceRelative` 一行：

```
有修复：files tracked in checkpoint: 1  → ["target.txt"]  → PASS
无修复：checkpoint backup failed ... Invalid relative path
        files tracked in checkpoint: 0  → []              → FAIL（回滚为 no-op）
```

真实 Claude Agent SDK 执行文件编辑，走完整 PreToolUse hook。这条同时证明 A4 未破坏 OAuth 登录态。

## 验收状态

- sidecar 136 pass / 0 fail（原 122，新增 14）
- server 154 pass / 0 fail（基线不变）
- desktop 138 pass / 0 fail（原 136，新增 2，改 3）
- `pnpm typecheck` 6/6 通过
- biome：改动文件 0 error；warning 数与改动前一致（既有债）
- sidecar 二进制已重编译

## 第二批（用户指示「挨个去做掉」后补做）

| 项 | 改动 | 验证 |
|---|---|---|
| lint 债 | 删 `Check/Copy` 未使用导入、SVG 补 `aria-hidden`、删除删按钮竞态（加 `deleteInFlight`）、`formatMessageTime` 加 Invalid Date 守卫、清 2 处死变量（`sendMessage`、`attachmentsMeta`） | biome 在这些文件上 0 error；新增 1 例守卫测试 |
| C6 google 协议 | `protocol.ts` 枚举补 "google"；`direct.ts` 新增 `protocol` 字段并在 `buildModel` 走 `google-generative-ai`（框架原生支持）；`index.ts` 透传 | 新增 4 例 |
| C5 direct Skills | `ExecuteToolOptions` 加 `readAllowRoots`，读路径先匹配 skill 目录再落回工作区边界；`buildTools` 接入 `skillDir` | 新增 3 例，含一条「白名单不放宽 /etc/passwd」的负向测试 |
| D1 迁移丢索引 | `ensureDeleteSemanticsForeignKeys` 改为返回 bool；迁移真的执行后重放 `CREATE INDEX` DDL；抽出 `isCreateIndexStatement` | 新增 6 例 |
| D2 并发重复迁移 | `migrateLegacySession` 全流程包进单事务（4 层函数传 `tx`）；`ensureLegacyAgentSessionsMigrated` 加 per-user in-flight 去重 | 新增 3 例；**反向验证**：去掉锁后并发测试立即 2 fail |
| C4 sidecar 崩溃不可恢复 | `start_sidecar_internal` 拿到 port 后把 `rx` 移交后台 task 持续消费，`Terminated` 时清空 state 并删 endpoint 文件；前端既有重连路径会调 `start_sidecar` 自动重新 spawn | `cargo check` 通过 |

**第二批后测试基线**：sidecar 143 / server 163 / desktop 139，全部 0 fail；`pnpm typecheck` 6/6。

未做的判断：`DesktopChatArea.tsx` 的 8 处 `useExhaustiveDependencies` 与 2 处 `noNonNullAssertion` 保留不动——改依赖数组有引入无限循环/过期闭包的风险，收益 < 风险，应在专门重构该组件（P1）时一并处理。

## 未做（PRD 已声明）

**B1/B2 安全文档第 6 层** —— 调查结论已变更前提：

Claude Agent SDK **0.2.71 完整支持** sandbox 配置，`sdk.d.ts:1040` 与 `:2860`：
- `sandbox.enabled`
- `sandbox.autoAllowBashIfSandboxed`
- `sandbox.allowUnsandboxedCommands`
- `sandbox.network.allowedDomains` ← 死函数 `buildNetworkAllowedDomains()` 正好产出这个

所以原报告的"二选一（补齐 or 降级文档）"应改为**建议补齐**：能力真实存在，死代码本就是为它准备的。但开启沙箱会改变 agent 的实际执行边界（现有工作流可能受影响），属行为变更，留待决策。

其余未做项：C4（sidecar 存活检测）、C5、C6、D1、D2 及全部 P1。

## 新增共享模块

- `packages/shared/src/shell-risk.ts` — 命令风险分类唯一真源
- `packages/shared/src/child-env.ts` — 子进程环境净化唯一真源

两者均由 `apps/sidecar` 与 `apps/server` re-export，现有 import 路径未变。
