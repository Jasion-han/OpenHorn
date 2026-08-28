# sidecar 新增 ACP runtime，接入 ACP 生态 agent

## Goal

在 sidecar 现有三条 runtime（claude / codex_cli / direct）之外新增第四条 `acp` runtime：spawn 任意实现了 ACP（Agent Client Protocol）的 agent 二进制（Gemini CLI、claude-code-acp 等），把 ACP 的 `session/update` 事件流映射为现有 `AgentEvent`，用一份映射代码换取整个 ACP 生态的 agent 接入能力。不改动现有三条 runtime 和 AgentEvent 主链路。

## What I already know

* sidecar 的 runtime 分发在 `apps/sidecar/src/index.ts` ~L478-560，按 run 请求里的 `protocol` 字段分支：`codex_cli` → runCodexAgent，`anthropic` → runClaudeAgent（带 checkpoint、approval、skills、mcpServers），其余 → runDirectAgent。
* `AgentEvent`（`apps/sidecar/src/agent/events.ts`）只有 9 种变体：text / final_text / thinking / tool_start / tool_result / user_message / usage / done / error。
* Claude 分支已有的基础设施可复用：`initRun` + guard、checkpoint 会话（按 runId 键控快照目录）、approval 请求走 WS `approval.request` 双向流、`agent.session` 回传 sdkSessionId。
* Server 侧 runtime 选择在 `channelAgentCheckService.resolveAgentRuntime()`，desktop → server → sidecar 全链路要认识新 protocol 值。
* 三个 runtime 均已上报 token 用量（usage 事件），ACP runtime 需对齐。
* Skills 机制面向 claude + direct，codex_cli 不在范围 —— ACP runtime 的 skills 支持需要决策。
* Sidecar 安全模型：loopback WS + 握手 token、workspace 边界 + symlink 校验、shell-risk；ACP agent 是外部进程，文件操作模型（agent 自己读写 vs 反向调用 client fs 方法）与现有边界的关系需要调研确认。

## Assumptions (temporary)

* ACP agent 二进制由用户自行安装（如 `gemini` / `claude-code-acp`），OpenHorn 不负责分发；sidecar 只负责 spawn + 通信。
* 传输层用 ACP 参考实现的 stdio JSON-RPC，sidecar 内做 stdio ↔ AgentEvent 转换，不改桌面端 WS 协议。
* MVP 先接一个标杆 agent（Gemini CLI）打通，再泛化配置。

## Decision (ADR-lite)

**Context**: ACP agent 是本地二进制、无标准 API key，与现有"渠道+key+模型探测"体系不同构；且 runtime 通用性 vs 标杆选择、client capability 范围都存在多个可行方案。

**Decision**（用户 2026-08-16 拍板）:
1. **产品建模**：新渠道 protocol 类型 `acp`。渠道配置存 agent 命令 + args + env，复用 codex_cli 的"无标准 API key 渠道"UI 先例；env 中的 key 走现有渠道加密存储。
2. **MVP 标杆**：官方适配器 `@agentclientprotocol/claude-agent-acp`（主，行为最规范：标准 usage_update + session 全家桶）与 `@agentclientprotocol/codex-acp`（对照）。runtime 本身通用，任何 stdio ACP agent 均可配置。
3. **capability 范围**：推荐组合——fs 代理接 workspace 校验、terminal 不声明、shell-risk 挂 permission 审批、进程组杀、会话内进程常驻。

**Consequences**: 渠道的"模型列表"概念对 ACP 弱化（模型由 agent 自管，MVP 不做会话内切模型）；token 用量需 per-agent 解析（标准 usage_update + 私有 _meta 两条路）；跨 app 重启的会话恢复留待后续。

## Research References

* [`research/acp-protocol-and-ts-lib.md`](research/acp-protocol-and-ts-lib.md) — ACP v1 生命周期/事件全集/capability 矩阵；TS 库用 `@agentclientprotocol/sdk` ^1.x（旧 zed 包已 deprecated），锁 protocolVersion 1 即稳定面；逐 turn token 细分无标准字段。
* [`research/acp-agents-landscape.md`](research/acp-agents-landscape.md) — 生态 40+ agent 全是 stdio 子进程 + 会话级 cwd + mcpServers 透传；Gemini CLI 用 `gemini --acp`（GEMINI_API_KEY 认证最简）；Claude/Codex 官方适配器已迁到 `@agentclientprotocol` org；token 上报三家形状互不相同，需 per-agent 解析。
* [`research/acp-client-implementations.md`](research/acp-client-implementations.md) — client 最小面 = 4 出方向方法 + 2 入方向 handler；fs 反向调用应接现有 symlink-aware workspace 校验（acpx/Zed 双先例）；terminal v1 声明不支持，shell-risk 挂 `session/request_permission` 的 `rawInput`；进程按进程组杀（detached + kill(-pid)）；8 类实证坑清单可直接当测试用例。

## Feasible Approaches

### 决策点 1：产品建模（ACP agent 在 UI 里怎么呈现）

**A. 新渠道 protocol 类型 `acp`**（推荐）
* 渠道配置存 agent 命令 + args + env（含 API key 类环境变量），复用 codex_cli 已有的"无标准 API key 渠道"UI 先例
* Pros：改动面最小，`resolveAgentRuntime` / 模型选择 / 设置页全部沿现有轨道；env 里的 key 走现有渠道加密存储
* Cons：ACP agent 没有"模型列表探测"，渠道的模型概念要弱化（模型切换靠 agent 自己的 unstable 方法，MVP 不做）

**B. 独立"本地 Agent"配置面板**
* Pros：语义更准确（本地二进制 ≠ 云端渠道）
* Cons：desktop 设置页、server 渠道体系、会话入口三处都要开新轨道，改动面大数倍

### 决策点 2：MVP 标杆 agent

* **Gemini CLI**（推荐）：`gemini --acp` + `GEMINI_API_KEY`，认证最简单；且补足 OpenHorn 现在没有的 Google agent 能力（claude/codex 已有原生 runtime，ACP 接它们只是重复）
* 备选：`@agentclientprotocol/codex-acp` / `claude-agent-acp`（官方、行为最规范，但与现有 runtime 重复）

### 决策点 3：client capability 范围（研究建议 A/B/C/D 组合，推荐）

* fs：声明 `readTextFile/writeTextFile: true`，handler 接 `workspace.ts` 的 symlink-aware 校验 + `fs.ts` 读写 → checkpoints 审计对 agent 写盘天然生效；越界返回 `resource_not_found` 让 agent 降级用自带工具（Zed #60156 误伤预案：先接受报错，观察后再加白名单）
* terminal：MVP 声明不支持（省略）。关键认知：这挡不住 agent 用自己进程内的 shell——所以 shell-risk 评分挂在 `session/request_permission` handler 上（`kind === "execute"` 时取 `rawInput` 过 `classifyBashCommandRisk`），接入现有 approval.request WS 双向流
* 进程：`detached: true` 进程组 + 退出 `kill(-pid, SIGTERM)` → 超时 SIGKILL；握手 race 子进程退出快速失败；stderr 滚动缓冲 + "end_turn 但 0 update"静默失败检测
* 多轮会话：ACP 进程按会话常驻（keyed by conversationId），复用 sessionId 续 turn；进程死了按 capability 走 resume → load → 新建降级链。跨 app 重启的会话恢复不进 MVP

## Requirements

* sidecar 新增 `apps/sidecar/src/agent/acp.ts` runtime：依赖 `@agentclientprotocol/sdk` ^1.x（fluent client API，protocolVersion 1），spawn agent 子进程（`detached: true` 进程组），完成 initialize → (authenticate) → session/new → session/prompt 生命周期
* `session/update` → `AgentEvent` 映射：agent_message_chunk→final_text、agent_thought_chunk→thinking、tool_call/tool_call_update→tool_start/tool_result、usage_update→usage（另留 gemini `_meta.token_count` 私有解析口）、stopReason→done/error；未知 update 类型忽略（宽进严出）
* client capability：`fs.readTextFile/writeTextFile: true` 接 `workspace.ts` symlink-aware 校验 + `fs.ts` 读写，越界回 `resource_not_found`；terminal 不声明；`session/request_permission` 接现有 approval.request WS 双向流，`kind==="execute"` 时 `rawInput` 过 `classifyBashCommandRisk`
* 取消链路：AbortController → session/cancel 通知 + pending permission 全部以 cancelled outcome 应答 + `cancelled` stopReason 不当 error；进程退出 `kill(-pid, SIGTERM)` → 超时 SIGKILL
* 多轮：ACP 进程按会话常驻（keyed by conversationId），复用 sessionId 续 turn；进程死亡按 resume → load → 新建降级
* 静默失败检测：stderr 滚动缓冲（8KB）+ "end_turn 但 0 update" 时用 stderr 提示
* 渠道体系：shared 类型 + `packages/db` schema 与 `apps/server/src/db/bootstrap.ts` 双定义同步（如需新字段）+ `resolveAgentRuntime` 对 acp 渠道旁路探测 + ChannelEditorModal 增加 acp 配置 UI（命令/args/env），中文文案走 i18n 字典
* checkpoint 复用 claude 分支模式（按 runId 键控快照目录）

## Acceptance Criteria

* [x] 配置 claude-agent-acp 渠道后，通过 UI 发消息能看到流式回复（2026-08-16 实测：Chrome@5173 真实前端 + 注入 sidecar 连接，完整链路 UI→useSidecarAgentRun→sidecarClient→sidecar→runAcpAgent→claude-agent-acp，回复入库 model=claude-agent-acp，UI 显示 34k tokens）
* [ ] execute 类工具调用触发审批弹窗，shell-risk 高危命令被标记（代码已接 approval.request 流，未实测触发）
* [ ] agent 写盘的文件落在 workspace 内且 checkpoints 能回滚（fs handler 已接 workspace 校验 + checkpoint backup，未实测回滚）
* [x] 中断后 agent 进程树被回收（bench 实测：abort 8s 内返回、无孤儿；修复了 cancel 宽限强杀导致 connection.closed rejection 炸循环的竞态）
* [x] token 用量上报（bench + UI 双实测：usage_update used=32905/34k 显示）
* [x] 多轮会话复用（bench 实测：同 sessionId 续 turn，无历史重放下正确记忆前文）
* [ ] codex-acp 作为第二 agent 冒烟（未跑）
* [x] 现有三条 runtime 回归无变化（server 177 / desktop 199 / sidecar 180 全绿，biome + typecheck 干净）
* [x] `@agentclientprotocol/sdk` 1.3.0 在 Bun + child stdio 组合下冒烟通过（acp.smoke.test.ts，常驻回归测试）

## Definition of Done (team quality bar)

* bun test 单测覆盖 ACP → AgentEvent 映射（对齐 codex.test.ts 的模式）
* typecheck / biome 绿
* sidecar 改动后重编 `compile:tauri:host` 通过
* 文档：skills/openhorn/ 相关 rules 更新

## Implementation Plan (分批)

* **批次 1 — sidecar ACP client 核心**：Bun+SDK 冒烟台架 → `agent/acp.ts`（spawn/握手/prompt/cancel/进程组杀）→ `session/update` 映射 + 单测（对照 codex.test.ts 模式，用 acpx conformance 场景清单）→ `compile:tauri:host` 重编
* **批次 2 — 渠道体系打通**：shared 类型 + db schema 双定义 + server resolveAgentRuntime 旁路 + desktop ChannelEditorModal UI + i18n
* **批次 3 — 风控与收尾**：permission↔approval.request 接线 + shell-risk + fs 代理 + checkpoints + usage per-agent 解析 + 真实 agent turn UI 验证 + 文档（skills/openhorn rules 更新）

## Out of Scope (explicit)

* 不重写现有三条 runtime，不改 AgentEvent 主链路语义
* 不做 OpenHorn 反向输出 ACP server（让 Zed 等调用 OpenHorn）
* 不负责 ACP agent 二进制的安装/分发

## Technical Notes

* 已核查文件：`apps/sidecar/src/index.ts`（分发块 ~L478-560）、`apps/sidecar/src/agent/events.ts`、`apps/sidecar/package.json`（仅依赖 @anthropic-ai/claude-agent-sdk 0.2.71）
* 全链路 protocol 触点：
  * `apps/server/src/services/channelAgentCheckService.ts:625` `resolveAgentRuntime()` — 渠道探测式选择，ACP 需要旁路或新渠道类型
  * `apps/desktop/src/lib/sidecarClient.ts` — `protocol` 是普通 string 透传，无需扩类型
  * `apps/desktop/src/components/settings/ChannelEditorModal.tsx`、`DesktopCredentialSourcesPanel.tsx` — codex_cli 已有"无 API key 渠道"的 UI 先例，可参考其接入方式
* 研究产出见 research/ 目录
