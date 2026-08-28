# 修复审查发现的 P0 安全与功能缺陷

来源：`docs/code-review-2026-07-26.md`（2026-07-26 全库审查）

## 目标

修复审查中「立刻（本周）」优先级的缺陷。全部为已实测确认的真实 bug 或安全问题，不含新功能。

## 范围（做什么）

按执行顺序：

| 编号 | 问题 | 文件 | 验收标准 |
|---|---|---|---|
| C2 | Codex delta 只累加进 `pendingText`，从不 `onEvent` 转发，导致流式文本不显示 | `apps/sidecar/src/agent/codex.ts:273` | delta 实时转发；删除 `finish()` 里 8字符/15ms 补发 trickle |
| C3 | codex 分支丢失 `conversationHistory`/`systemPrompt` 等参数，Codex 无上下文记忆 | `apps/sidecar/src/index.ts:465` | 参数完整透传 |
| C1 | checkpoint 收到绝对路径 → `normalizeRelPath` 抛错 → 空 catch 吞掉 → manifest 从不写入，回滚功能完全失效 | `apps/sidecar/src/agent/claude.ts:215`、`checkpoints.ts` | 绝对路径先转 workspace 相对路径；测试改用绝对路径输入 |
| A1 | `env: process.env` 把 ENCRYPTION_KEY/JWT_SECRET 透传给模型生成的命令 | `apps/server/src/services/bashToolExecutor.ts:48` | 改用 env 白名单；补 timeout |
| A2 | `classifyBashCommandRisk` 是黑名单默认 `allow`，危险命令不触发审批 | `apps/server/src/utils/shellRisk.ts:36` | 反转为默认 `confirm` + 只读命令白名单 |
| A3/A4 | sidecar 的 direct/claude 路径未用 `sanitizeChildEnv`，握手令牌与 API key 泄漏给子进程 | `apps/sidecar/src/agent/direct.ts:250`、`claude.ts:189` | 统一走 `sanitizeChildEnv`；补跨路径回归测试 |
| C7 | 默认 workspace `/tmp` 与 deny-list 冲突 → setWorkspace 必失败 → 静默降级到用户家目录 | `apps/desktop/src/stores/sidecarStore.ts:212,293`、`apps/sidecar/src/index.ts:378` | 默认值改为允许目录；失败不再静默；移除 `|| homedir()` 降级 |

## 不做什么

- B1/B2（安全文档第 6 层 sandbox）：需先调查 Claude Agent SDK 是否真支持相关参数，且开启 sandbox 会改变 agent 实际能力边界，属产品决策 → **本任务只做调查并给出推荐，不擅自改行为**
- C4（sidecar 进程存活检测）、C5、C6、D1、D2：留待下一批
- 任何 P1 / 性能 / 重构项
- 不碰当前 6 个未提交文件的改动

## 验收

1. `pnpm --filter server exec bun test` 保持 154 pass / 0 fail（不得引入新失败）
2. `pnpm --filter sidecar exec bun test` 不得引入新失败
3. `pnpm typecheck` 通过
4. `pnpm check`（biome）在改动文件上无新增错误
5. 改 sidecar 后执行 `pnpm --filter sidecar run compile:tauri:host`
6. Codex 流式：桌面端实测确认文字边生成边显示
