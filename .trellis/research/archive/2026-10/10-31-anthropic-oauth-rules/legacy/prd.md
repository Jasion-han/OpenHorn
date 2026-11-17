# Anthropic OAuth 请求规则单一来源

## 背景（第一性原理）
「Claude Code」渠道使用 Claude CLI 登录得到的 OAuth token（`sk-ant-oat…`）。对这类 token，
Anthropic Messages API 有三条规则（见 `apps/sidecar/src/agent/claude.ts` ~400-470 的长注释）：
1. 认证用 `Authorization: Bearer`，不用 `x-api-key`；
2. 模型 id 去掉日期后缀（`-\d{8}$`）；
3. `system` 第一块必须是单独的计费标记 `x-anthropic-billing-header: cc_version=…; cc_entrypoint=sdk-cli;`，
   真正的系统提示放第二块（合并会导致整段系统提示被丢弃；缺少标记时 Sonnet/Opus 返回 429 rate_limit_error）。

这三条只完整实现在 Agent 运行时 `runClaudeAgent`（`buildOAuthBillingHeader` / `buildClaudeSystem`）。
Chat 模式走 sidecar `chat.stream` → `agent/chat.ts` `runChatStream` → `packages/adapters` 的 Anthropic 适配器
（`adapters.ts` ~1240，只实现了规则 1）→ 没有计费标记 → 429。这就是 Chat 模式 Claude Code 渠道 429 的根因：
同一协议的规则有两份实现，只有一份完整。

## 目标
1. OAuth 规则只有一个来源。建议放在 `packages/adapters`（server 与 sidecar 都依赖它）：导出
   `isAnthropicOAuthToken`、模型 id 规范化、system 块构造（标记单独成块）；Anthropic 适配器在 OAuth token 下
   自动应用三条规则（chat 与 chatStream 都要）。计费标记字符串由调用方注入或由适配器内置
   ——注意 `cc_version` 来自本机 `claude --version`（仅 sidecar 环境可执行），设计时决定：适配器接受
   可选 `billingMarker`，缺省时用已验证常量；sidecar 注入探测到的版本。不要在两处各写一份。
2. `claude.ts` 改为使用这份共享实现（`buildClaudeSystem` / 模型规范化 / token 判断），删除重复。
   `buildOAuthBillingHeader`（版本探测）可留在 sidecar，作为注入值的来源。
3. 排查所有会用到 Anthropic 协议 + 渠道 key 的调用方（sidecar chat、server 侧 chat / 自动标题 /
   摘要 / 记忆 / 定时任务等走 `createAdapter("anthropic", …)` 的地方），确保都自动获得同样行为
   （适配器层统一处理即可覆盖）。
4. 测试：适配器在 OAuth token 下的请求体（system 两块、模型去日期、Bearer 头），非 OAuth 不变；
   `buildClaudeSystem` 现有测试迁移。
5. 改了 sidecar 源码后重编：`pnpm --filter sidecar run compile:tauri:host`。

## 约束
workspace 名导入；Biome；跑 adapters / sidecar / server / desktop 测试与 tsc。不提交。

## 验收
Chat 模式下 Claude Code 渠道（claude-sonnet-4-6）正常回答不再 429；Agent 模式行为不变；
OAuth 规则在仓库中只有一处实现。

## 实现备注（与 PRD 对照的证据）
- 单一来源：`packages/adapters/src/anthropic-oauth.ts`（`isAnthropicOAuthToken` / `anthropicAuthHeaders` /
  `normalizeAnthropicModelId(model, isOAuth)` / `buildAnthropicBillingMarker` / `buildAnthropicSystem`，
  原 claude.ts 的长注释迁移至此）。`normalizeAnthropicModelId` 接收 `isOAuth` 而非 key，因为适配器有意不保存 key。
- `AnthropicAdapter(apiKey, baseUrl, { billingMarker? })` 在 OAuth 下对 `chat` / `chatStream` / `runToolCallingTurn`
  三个方法都应用三条规则（无系统提示时也单独发送标记块）；`createAdapter` 新增可选第 4 参数
  `{ anthropic: { billingMarker } }`。非 OAuth 保持原样（`x-api-key`、模型不变、`system` 仍为字符串，
  避免部分 Anthropic 兼容网关不接受数组形式）。
- 版本探测从 claude.ts 移到 `apps/sidecar/src/agent/anthropic-billing.ts`（`resolveClaudeBillingMarker`），
  Agent（claude.ts）与 Chat（chat.ts）共用；`buildClaudeSystem` / `buildOAuthBillingHeader` 已删除。
  claude.ts 仍通过 Anthropic SDK 的 `authToken` 走 Bearer（SDK 配置，无重复规则）。
- 调用方排查：server 的 messageService / autoTitle / summary / welcomeSuggestion / liveRouteClassifier /
  channelAgentCheckService / routes/credentials 全部经 `createAdapter`，自动获得 OAuth 行为（缺省使用已验证常量）。
  实际上 OAuth token 只在 sidecar 内由 `detectCredentialForProtocol` 解析得到，server 收到的是
  `__sidecar_auto__:*` 占位符，因此 server 侧主要是防御性覆盖。
- 未纳入：server `anthropicProbe.ts` 与 `channelService.ts` 的模型探测 / 模型列表直接 fetch 并写死 `x-api-key`，
  不经适配器；它们收不到 OAuth token（同上），故未改动，如需可后续改用 `anthropicAuthHeaders`。
