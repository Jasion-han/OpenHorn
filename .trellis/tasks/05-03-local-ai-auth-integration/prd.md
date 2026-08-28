# 本地 AI 工具认证集成 + 多 Provider 架构优化

## Goal

让 OpenHorn 桌面端能够自动检测用户本地已有的 AI 工具认证（Codex CLI → OpenAI、Claude Code → Anthropic、Gemini CLI → Google），通过独立的认证源管理面板以用户可感知的方式呈现，同时完善多 Provider 接入架构（预设模板、URL 规范化、Google 适配器），为未来更多厂商接入和企业级 Agent 底座演进打下基础。

## 分阶段规划

本 PRD 覆盖**第一阶段**。后续阶段记录在 Out of Scope 中供参考。

### 第一阶段（本任务）— 认证集成 + 基础架构完善
### 第二阶段（下一迭代）— 通用 Runtime 工具集补齐
### 第三阶段（架构演进）— 面向企业 Agent 底座

---

## Research References

- [`research/local-auth-mechanisms.md`](research/local-auth-mechanisms.md) — 三大 CLI 工具的本地认证存储机制
- [`research/sdk-analysis.md`](research/sdk-analysis.md) — Claude Agent SDK 适用性分析，双 Runtime 架构评估
- [`research/adapter-completeness.md`](research/adapter-completeness.md) — 通用适配器 vs Claude SDK 能力差距分析
- [`research/pi-mono-architecture.md`](research/pi-mono-architecture.md) — Pi 三层架构、Provider 注册表、认证机制
- [`research/pi-tools-and-sandbox.md`](research/pi-tools-and-sandbox.md) — Pi 工具系统、沙箱实现、Provider 适配细节
- [`research/agent-infra-architecture.md`](research/agent-infra-architecture.md) — 企业级 Agent 基础架构选型分析

---

## 第一阶段 Requirements

### 1. 认证源管理面板（方案 B — 独立面板）

**位置：** Settings 页面新增"认证来源"（Credential Sources）面板

**核心交互：**
- 面板自动扫描并展示所有已检测到的本地认证来源
- 每个认证来源显示：Provider 名称、来源类型（CLI / 环境变量 / 手动）、状态（✅ 可用 / ⚠️ 已过期 / ⬜ 未检测到）
- 用户可以手动添加 API Key 作为认证来源
- 所有认证来源处于同一层级，无主次之分

**检测的认证来源：**

| 来源 | 检测方式 | Provider | 类型 |
|------|---------|----------|------|
| 环境变量 `OPENAI_API_KEY` | `process.env` | OpenAI | API Key |
| 环境变量 `ANTHROPIC_API_KEY` | `process.env` | Anthropic | API Key |
| 环境变量 `GEMINI_API_KEY` | `process.env` | Google | API Key |
| Codex CLI | 读取 `~/.codex/auth.json` 的 `access_token` | OpenAI | OAuth Token |
| Claude Code | macOS Keychain `security find-generic-password -a "$USER" -w -s "Claude Code-credentials"` | Anthropic | OAuth Token |
| Gemini CLI | 读取 `~/.gemini/oauth_creds.json` 的 `access_token` | Google | OAuth Token |
| 手动输入 | 用户在面板中填写 | 任意 | API Key |

**凭据优先级链（参考 Pi 模式）：**
- Anthropic: `ANTHROPIC_OAUTH_TOKEN` > `ANTHROPIC_API_KEY` > Claude Code Keychain
- OpenAI: `OPENAI_API_KEY` > Codex CLI OAuth
- Google: `GEMINI_API_KEY` > Gemini CLI OAuth

**安全原则：**
- 永远不静默获取凭据，必须告知用户正在使用哪个来源
- Claude Code Keychain 读取会触发 macOS 权限确认框，需要在 UI 上提示用户
- OAuth Token 的自动刷新需要了解各厂商的 refresh 机制（Codex 需要 client_id）
- 检测到的凭据不持久化到数据库，每次启动时重新扫描（环境变量和文件可能变化）

### 2. Channel 创建流程优化

**新流程：**

```
第一步：选择 Provider（下拉列表，含预设 + 自定义）
   → 自动填充 protocol 和 baseUrl
第二步：选择认证来源（手动 API Key / 环境变量 / 本地 CLI 认证）
   → 只显示与该 Provider 匹配的可用认证选项
第三步：获取可用模型列表
   → 使用选定的认证来源调用 API 获取模型
```

**Provider 预设模板：**

```typescript
const PROVIDER_PRESETS = {
  openai:    { protocol: "openai",    baseUrl: "https://api.openai.com/v1" },
  anthropic: { protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  google:    { protocol: "google",    baseUrl: "https://generativelanguage.googleapis.com" },
  deepseek:  { protocol: "openai",    baseUrl: "https://api.deepseek.com/v1" },
  qwen:      { protocol: "openai",    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  kimi:      { protocol: "openai",    baseUrl: "https://api.moonshot.cn/v1" },
  glm:       { protocol: "openai",    baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  doubao:    { protocol: "openai",    baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  ollama:    { protocol: "openai",    baseUrl: "http://localhost:11434/v1" },
  custom:    { protocol: "openai",    baseUrl: "" },  // 用户自填
}
```

**设计原则：** 新增厂商只需在预设表加一行 + 可选的 compat 配置，不需要写新的适配器代码（因为国内厂商基本都兼容 OpenAI 协议）。

### 3. Google 适配器（GoogleAdapter）

**需求：** 新增 `GoogleAdapter` 实现 Gemini API 协议，与现有 `OpenAIAdapter`、`AnthropicAdapter` 同级。

**参考：** Pi 的 `google-shared.ts` 实现
- `functionDeclarations` 格式的工具定义
- 两种模式：`parametersJsonSchema`（Gemini 原生）和 `parameters`（OpenAPI 清洗后的格式）
- 统一事件流转换

**实现要点：**
- 实现 `ToolCallingAdapter` 接口（`runToolCallingTurn` + `runToolCallingTurnStream`）
- 在 `createAdapter()` 工厂中注册 `"google"` 协议
- 扩展 `AdapterProtocol` 类型为 `"openai" | "anthropic" | "google"`

### 4. Bug 修复 & 健壮性

**4.1 Anthropic max_tokens 硬编码修复**

`agent-adapters.ts` L1357 和 L1505 硬编码 `max_tokens: 1024`，会截断复杂的 agent 响应。应改为可配置或使用模型默认值。

**4.2 URL 规范化**

当前 URL 拼接存在隐患：
- 用户填 `https://api.anthropic.com/` → 拼成 `https://api.anthropic.com//v1/messages` ❌
- 用户填含 `/v1` 的代理 URL → 路径重复 ❌

需要在适配器构造函数中做 normalize：
- 去除尾部斜杠
- 检测并处理路径前缀重复（如 `/v1/v1`）

**4.3 Provider compat 配置**

参考 Pi 的 compat 对象模式，集中管理 Provider 特殊行为：

```typescript
const PROVIDER_COMPAT = {
  qwen:     { supportsStrictMode: false, supportsVision: true },
  kimi:     { supportsStrictMode: false, supportsVision: false },
  deepseek: { supportsStrictMode: false, supportsReasoning: true },
  ollama:   { supportsStrictMode: false, supportsStreaming: true },
}
```

---

## Acceptance Criteria

### 认证检测
- [ ] 能检测环境变量 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`
- [ ] 能检测 Codex CLI 认证（`~/.codex/auth.json`）
- [ ] 能检测 Claude Code 认证（macOS Keychain，触发系统权限确认）
- [ ] 能检测 Gemini CLI 认证（`~/.gemini/oauth_creds.json`）
- [ ] 未检测到时不影响现有手动配置流程

### 认证源管理面板
- [ ] Settings 页面有独立的"认证来源"面板
- [ ] 面板显示所有检测到的认证来源及状态
- [ ] 用户可以手动添加 API Key
- [ ] 所有来源同一层级，用户可明确感知正在使用哪个

### Channel 创建优化
- [ ] Provider 下拉选择器包含预设列表（OpenAI / Anthropic / Google / DeepSeek / 千问 / Kimi / GLM / 豆包 / Ollama / 自定义）
- [ ] 选择 Provider 后自动填充 protocol 和 baseUrl
- [ ] 认证来源选择器只显示与选定 Provider 匹配的可用选项
- [ ] 自定义 Provider 时用户可以自由填写 baseUrl

### Google 适配器
- [ ] `GoogleAdapter` 实现 `ToolCallingAdapter` 接口
- [ ] 支持 Gemini API 的消息格式和流式响应
- [ ] 支持工具调用（`functionDeclarations` 格式）
- [ ] 在 `createAdapter("google", apiKey, baseUrl)` 中可用

### Bug 修复
- [ ] Anthropic 适配器 `max_tokens` 不再硬编码为 1024
- [ ] URL 拼接做 normalize，处理尾部斜杠和路径重复
- [ ] 自定义 baseUrl 和任意格式/长度的 API Key 能正常工作

---

## Definition of Done

- Tests added/updated (unit/integration where appropriate)
- Lint / typecheck / CI green
- Docs/notes updated if behavior changes
- 桌面端 UI 手动验证通过

---

## Decision (ADR-lite)

### D1: UI 方案选择

**Context:** 需要决定认证来源如何在 UI 中呈现
**Decision:** 方案 B — 独立认证源管理面板。认证来源是跨 Channel 共享的资源，独立管理更清晰；与未来企业 Agent 底座的凭据管理层对齐。
**Consequences:** 需要新增 Settings 子页面；Channel 创建流程需要改造为引用认证源而非直接填 key。

### D2: 架构方向 — 参考 Pi 自己写，不直接引入

**Context:** 是否直接引入 Pi 的 `pi-ai` / `pi-agent-core` 包
**Decision:** 参考 Pi 的设计思路自己写。原因：
1. Pi 的 Agent 循环与 Claude SDK 的 `sdk.query()` 有根本冲突
2. Pi 是个人项目，维护风险高
3. Pi 的沙箱用的也是 `@anthropic-ai/sandbox-runtime`，不需要通过 Pi 间接使用
4. 工具实现简单（每个几十行），自己写能完全适配现有事件流和审批系统
**Consequences:** 工作量略多，但架构完全自主可控。

### D3: 多 Provider 接入策略 — 三协议 + 预设模板

**Context:** 如何平滑接入国内外各模型厂商
**Decision:** 只维护三个独立适配器（OpenAI / Anthropic / Google），国内厂商（千问/Kimi/GLM/DeepSeek/豆包等）全部走 OpenAI 兼容协议，通过预设模板 + compat 配置接入。新增厂商只需加一行预设，不需要写新适配器。
**Consequences:** 极低的接入成本；但如果某厂商协议不兼容 OpenAI，需要评估是否新增适配器。

### D4: 继续使用双 Runtime 架构

**Context:** Claude Agent SDK 是否仍适合作为 Agent Runtime
**Decision:** 继续保留双 Runtime 架构（Claude SDK + 通用适配器），不切换到其他框架。
- Claude SDK 作为 Anthropic 专属高能力路径（6 工具 + 沙箱 + checkpoint）
- 通用适配器覆盖所有其他 Provider
- 第二阶段补齐通用适配器的工具集和沙箱
**Consequences:** 短期内 OpenAI/Google 的 agent 体验弱于 Claude；第二阶段补齐后趋于一致。

---

## Out of Scope (explicit)

### 本任务不做
- Web 端实现（仅桌面端）
- 通用 Runtime 工具集补齐（第二阶段）
- 沙箱执行（第二阶段）
- 架构重构（Provider 注册表、提取 `packages/agent/`）（第三阶段）
- MCP 工具标准化（第三阶段）

### 第二阶段参考（通用 Runtime 补齐）
- 给通用 Runtime 添加 Read/Write/Edit/Grep/Find/Ls 6 个工具（参考 Pi 的实现）
- 引入 `@anthropic-ai/sandbox-runtime` 做 bash 沙箱
- 添加 `beforeToolCall` 审批钩子（参考 Pi 的扩展模式）
- 工作区边界检查（参考 Sidecar 的 `resolveWritePathInsideWorkspace`）
- Shell 风险评估（复用 Sidecar 的 `classifyBashCommandRisk`）

### 第三阶段参考（企业 Agent 底座）
- 提取 `packages/agent/` 为正式共享包（适配器 + Runtime + 工具）
- Provider 注册表模式（参考 Pi 的 `registerApiProvider()`）
- Provider compat 对象集中管理（参考 Pi 的 `OpenAICompletionsCompat`）
- 三层架构：Model 网关层 → Agent Runtime 层 → 应用层
- MCP 作为标准工具协议
- 可序列化 Context（参考 Pi，支持跨 Provider 对话迁移）
- 可考虑采纳 Vercel AI SDK core 做统一 Provider 流式抽象

---

## Technical Notes

### 关键文件
- Channel schema: `packages/db/src/schema/index.ts` L12-27
- Channel 路由: `apps/server/src/routes/channels.ts`
- Adapter 创建: `apps/server/src/agent-adapters.ts` L1672（`createAdapter()` 工厂）
- OpenAI 适配器: `apps/server/src/agent-adapters.ts` L400-1063
- Anthropic 适配器: `apps/server/src/agent-adapters.ts` L1065-1669
- 通用 Runtime: `apps/server/src/services/genericAgentRuntime.ts`
- Claude SDK 集成: `apps/sidecar/src/agent/claude.ts`
- Sidecar 凭据传递: 通过 SDK `options.env` per-call
- i18n 字典: `apps/desktop/src/lib/i18n/agent.ts`

### 认证文件路径
- Codex: `~/.codex/auth.json`（JSON, 0600 权限）
- Claude Code: macOS Keychain service `"Claude Code-credentials"`
- Gemini: `~/.gemini/oauth_creds.json`（JSON, 0600 权限）+ `~/.gemini/settings.json`

### 约束
- 桌面端和 Web 端是独立组件树，本任务只改桌面端
- 中文 UI 文案必须走 `i18n/agent.ts` 字典
- Channel `apiKey` 字段当前是 `notNull`，如果用本地认证需要考虑如何处理此约束
- 数据库 schema 修改需要 Drizzle schema + bootstrap DDL 两边同步
