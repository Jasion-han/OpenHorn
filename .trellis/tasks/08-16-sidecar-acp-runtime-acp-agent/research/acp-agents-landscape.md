# Research: ACP 生态可接入 Agent 清单与接入方式（2026-08）

- **Query**: 调研 ACP（Agent Client Protocol）生态里可被 client 接入的 agent 清单与各自接入方式
- **Scope**: external（GitHub README / 官方文档 / npm registry / npm tarball 反编译验证）
- **Date**: 2026-08-16
- **时效说明**: 所有 npm 版本号/发布时间取自 registry.npmjs.org 实时数据（claude-agent-acp 0.69.0 发布于 2026-08-16 当天）；官方 agent 清单取自 agentclientprotocol.com 实时页面。

## 0. 协议现状速览（先读这个）

- ACP v1 是当前稳定版；官方文档已出现 **v2**（含 migration guide），但本文调研的主流 adapter 仍在 `initialize` 里返回 `protocolVersion: 1`（claude-agent-acp 0.69.0 实测 bundle 如此）。
- TypeScript SDK：**`@agentclientprotocol/sdk` 1.3.0**（2026-07-21 发布，前身是 `@zed-industries/agent-client-protocol`）。OpenHorn 做 client 应直接用它。
- 官方两个 agent 目录页：
  - 全量清单（含未进 registry 的）：https://agentclientprotocol.com/get-started/agents.md
  - ACP Registry（curated，只收支持 authentication 的）：https://agentclientprotocol.com/get-started/registry.md ，仓库 https://github.com/agentclientprotocol/registry
- 关键组织变更：Zed 把两个官方 adapter 移交给了 **agentclientprotocol** GitHub org：
  - `@zed-industries/claude-code-acp`（末版 0.16.2，2026-02-17）→ **`@agentclientprotocol/claude-agent-acp`**
  - `zed-industries/codex-acp` → **`@agentclientprotocol/codex-acp`**（旧仓库 README 顶部有 IMPORTANT 迁移声明）

## 1. Gemini CLI

来源：
- ACP 模式官方文档：https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md
- 源码：`packages/cli/src/acp/`（acpRpcDispatcher.ts / acpSession.ts / acpSessionManager.ts 等）
- Registry 收录版本：0.55.1

### 启动命令

```bash
gemini --acp            # 当前推荐
gemini --experimental-acp   # 仍可用，但已标记 deprecated："use --acp instead"（config.ts L363-371）
gemini --acp --debug    # 调试日志
```

stdio 上跑 JSON-RPC 2.0，标准 ACP 子进程模型。

### 认证（initialize 返回的 authMethods，源码 acpRpcDispatcher.ts L47-79）

| method id | 说明 |
|---|---|
| `LOGIN_WITH_GOOGLE`（oauth-personal） | Google 账号 OAuth 登录 |
| `USE_GEMINI` | Gemini Developer API key；支持通过 `authenticate` 请求的 `_meta['api-key']` 由 client 直接传 key（`_meta: {'api-key': {provider:'google'}}`） |
| `USE_VERTEX_AI` | Vertex AI GenAI API key |
| `GATEWAY` | 自定义 AI API Gateway（`_meta.gateway.protocol='google'`） |

环境变量 `GEMINI_API_KEY` 缺失时 acpSessionManager.ts 会报 "Gemini API key is missing or not configured."

### 能力

- `agentCapabilities`：`loadSession: true`；prompt 支持 image / audio / embeddedContext；`mcpCapabilities: { http: true, sse: true }`
- 方法：`initialize` / `authenticate` / `newSession` / `loadSession` / `prompt` / `cancel` / `setSessionMode`（切审批级别，如 auto-approve）/ `unstable_setSessionModel`（会话内换模型，注意 unstable 前缀）
- 文件系统走 client 代理（ACP file system proxy），tool call + permission request 走标准协议
- client 的 MCP server 在 `session/new` 时传入，Gemini 会连接并把工具暴露给模型

### Token 用量

有上报，但是**非标准扩展**：通过 session update 的 `_meta` 携带（acpSession.ts L352-448）：

```
_meta: { token_count: { input_tokens, output_tokens }, model_usage: [{ model, token_count }] }
```

数据来自 Gemini API 的 `usageMetadata.promptTokenCount` 等。client 要专门解析这个 `_meta` 形状。

### 已知限制

- 会话内切模型是 `unstable_` 方法；ACP 模式无 TUI 特性（checkpointing/rewind 等归 TUI）
- token 用量不走任何 RFD 标准形状，与 claude/codex adapter 不互通

## 2. Claude Code ACP 适配器（claude-code-acp → claude-agent-acp）

来源：
- 新仓库：https://github.com/agentclientprotocol/claude-agent-acp （README）
- npm：https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp （0.69.0，2026-08-16 发布）
- 旧包：https://www.npmjs.com/package/@zed-industries/claude-code-acp （0.16.2，2026-02-17，已停更）
- 实测：下载 0.69.0 tarball grep `dist/acp-agent.js` 验证能力

### 安装 / 启动

```bash
npm install -g @agentclientprotocol/claude-agent-acp
claude-agent-acp                      # bin 名
# 或旧包（不建议新装）：
ANTHROPIC_API_KEY=sk-... npx @zed-industries/claude-code-acp
```

依赖链：`@anthropic-ai/claude-agent-sdk` 0.3.232 + `@agentclientprotocol/sdk` 1.3.0（即它就是官方 Claude Agent SDK 外面套一层 ACP 翻译）。

### 认证（bundle 实测）

- **终端登录**：advertise terminal auth methods（走 `claude` 登录流，需要 client 支持 terminal auth 能力/`_meta` terminal auth）
- **Gateway auth**：含标准 gateway 与 Bedrock 变体（client 声明 gateway capability 时才 advertise）
- **环境变量透传**：`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX`、`ANTHROPIC_VERTEX_*`、`AWS_REGION` 等白名单直传 SDK
- 支持 `auth.logout`

### 能力（initialize 实测返回）

- `loadSession: true` + `sessionCapabilities: { additionalDirectories, close, delete, fork, list, resume }` —— session 管理是全家桶
- prompt：image、embeddedContext；`mcpCapabilities: { http, sse }`（client MCP server 透传）
- `providers: {}`：client 管理的 LLM 路由（`providers/list` / `providers/set` / `providers/disable`）—— 可由 client 切换后端
- 扩展：`_meta.steering`（运行中注入 follow-up）、goal extension（长时目标）、session failure extension、nested subagent transcripts（client 声明 `_meta["subagent-transcript"]=true` 才开）、promptQueueing
- README 列举：@-mentions、images、tool calls with permission、edit review、TODO、交互/后台 terminal、自定义 slash commands

### Token 用量

**有**：emit `sessionUpdate: "usage_update"`，字段 `{ used, size }`（上下文占用 token 数 / 模型窗口大小），与 Session Context Size and Cost RFD 形状一致；compaction 后会重算 used。

### 与直接用 @anthropic-ai/claude-agent-sdk 的差异

| 维度 | claude-agent-acp | 直接 SDK |
|---|---|---|
| 事件形状 | 标准 ACP session/update（跨 agent 统一） | SDK 私有事件流，需自己映射 |
| 权限 | 标准 `session/request_permission`，client 统一 UI | 自己实现 canUseTool 回调与 UI |
| 文件/终端 | 走 client 代理（编辑以 native diff 呈现、未保存内容可见） | agent 直接本地读写 |
| MCP | client 在 session/new 声明即透传 | 自己配 SDK mcpServers |
| 深度定制 | hooks / 自定义 in-process tools / system prompt 完整控制面不暴露 | SDK 全量能力 |
| 多 agent 统一 | 换 agent 只换子进程命令 | 每家 SDK 各写一套 |

结论：接 ACP 是"一次实现、多 agent 复用"；SDK 直连仅在需要 hooks/自定义工具注入等深度控制时占优。

## 3. 其他 ACP Agent 盘点

### Codex：有官方 adapter

- **`@agentclientprotocol/codex-acp` 1.4.0**（https://github.com/agentclientprotocol/codex-acp ，从 zed-industries 迁来）
- 启动：`npx -y @agentclientprotocol/codex-acp`（npm 包自带兼容版 `@openai/codex` 依赖；`CODEX_PATH` 可指定外部二进制）；stdio ACP server，内部起 Codex App Server 做翻译
- 认证：ChatGPT 登录（`NO_BROWSER=1` 可隐藏）/ `CODEX_API_KEY` / `OPENAI_API_KEY` / client 提供的自定义 OpenAI 兼容 gateway
- 能力：模型/reasoning effort/审批/sandbox 模式配置；shell、文件变更、permission、MCP tool call、terminal output、reasoning、plan、web search、图像生成、**token usage 事件**、review 事件；subagent 以标准 tool call 呈现（`_meta.codex.subagent`）；client MCP（stdio + HTTP）；slash commands（/status /review /compact /logout 等）
- 运行时环境变量：`CODEX_CONFIG`（JSON 合入 session config）、`MODEL_PROVIDER`、`INITIAL_AGENT_MODE`（read-only / agent / agent-full-access）、`APP_SERVER_LOGS`
- 成熟度：官方共管（OpenAI+ACP org pooling maintenance），生产可用

### Goose（Block）：原生支持

- 文档：https://goose-docs.ai/docs/guides/acp-clients （旧 block.github.io 已 404 迁移；goose 已并入 Agentic AI Foundation）
- 启动：client 直接跑 **`goose acp`**，stdio JSON-RPC；自动加载 client 配置的 MCP server；支持多并发 session、会话内切模型/模式、client 代理文件与终端；session 落到 goose 本地历史
- 成熟度：官方标注 **Experimental Feature**；registry 版本 1.46.0；vscode-goose 是参考 client

### Mistral Vibe：原生支持

- https://github.com/mistralai/mistral-vibe/blob/main/docs/acp-setup.md
- 自带 **`vibe-acp`** 命令（随 vibe 安装）；认证复用 vibe 已配好的 API key；Zed/JetBrains/Neovim 均给了配置示例；registry 版本 2.24.1。成熟度：官方产品级

### 其他（一句话，均来自官方 agents 页 + registry，标注 registry 版本）

| Agent | 接入 | 成熟度一句话 |
|---|---|---|
| GitHub Copilot CLI 1.0.80 | 原生 ACP，2026-01-28 起 public preview（https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/） | 官方 preview |
| Cursor CLI 2026.08.11 | 原生 ACP（https://cursor.com/docs/cli/acp） | 官方正式文档 |
| Cline 3.0.55 | 原生 CLI ACP | 官方 |
| OpenCode 1.18.18 | 原生 | 官方，社区活跃 |
| Qwen Code 0.21.12 | 原生（gemini-cli fork，同 `--acp` 系） | 官方 |
| Kimi CLI 1.49.0 (Moonshot) | 原生 | 官方 |
| GLM Agent 1.5.0 (Zhipu) | 社区 adapter（stefandevo/glm-acp-agent），支持 load/fork/resume | 社区，功能全 |
| Junie 2783.5.0 (JetBrains) | 原生 | 官方 |
| Devin CLI (Cognition) | 原生 | 官方 |
| Factory Droid 0.197.0 | 原生 | 官方 |
| Amp 0.9.0 | 社区 wrapper（tao12345666333/amp-acp） | 社区 |
| goose / Auggie / Grok Build / Kilo / Poolside / Stakpak / VT Code / fast-agent / Codebuddy / Cortex Code 等 | 见 registry | 详见 registry 页 |

## 4. 进程模型共性

- **全部是 stdio 子进程**：client spawn agent 进程，stdin/stdout 跑 JSON-RPC 2.0（协议 transports 文档确认 stdio 是基线；HTTP/WebSocket transport 目前只是 RFD：https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md）
- **cwd 是会话级参数，不是进程 cwd**：`session/new` / `session/load` / `session/resume` 的 `params.cwd`（https://agentclientprotocol.com/protocol/v1/session-setup.md）。同一 agent 进程可多 session 各自不同 cwd（goose 明确支持并发 session）。额外目录走 `additionalDirectories` 扩展（claude-agent-acp 已支持）
- **MCP 配置可透传**：`session/new.params.mcpServers`，stdio 型为 `{name, command, args, env}`；HTTP/SSE 型需 agent 在 `agentCapabilities.mcpCapabilities` 声明（gemini：http+sse；claude-agent-acp：http+sse；codex-acp：stdio+HTTP）
- **client 反向提供能力**：文件系统读写代理（agent 看得到未保存 buffer）、terminal 执行、`session/request_permission` 审批 —— client 在 initialize 的 clientCapabilities 里声明
- **会话恢复**：`loadSession`（回放全部历史 update）与 `resume`（不回放，直接续）两条路径；gemini 支持 load，claude-agent-acp 支持 load+resume+fork+list+delete

## 5. Token 用量上报对比

协议层：v1 **没有**稳定标准字段，两个 RFD 均为 Draft：
- End-Turn Token Usage（`PromptResponse.usage`：totalTokens/input/output/thought/cachedRead/cachedWrite）https://agentclientprotocol.com/rfds/end-turn-token-usage.md
- Session Context Size and Cost（`session/update` 的 `usage_update`）https://agentclientprotocol.com/rfds/session-usage.md

各 agent 实况：

| Agent | 上报？ | 形状 |
|---|---|---|
| claude-agent-acp 0.69.0 | 是（tarball 实测） | `usage_update { used, size }`（上下文占用/窗口） |
| codex-acp 1.4.0 | 是（README 明列 token usage 事件） | 具体字段未逐行验证 |
| Gemini CLI | 是，但私有 | update `_meta.token_count {input_tokens, output_tokens}` + `model_usage` 按模型分桶 |
| Goose / Mistral Vibe / 其他 | 未验证 | — |

**对 OpenHorn 的含义**：sidecar 若做通用 ACP runtime，token 用量需要 per-agent 解析器（usage_update 标准形 + gemini `_meta` 私有形），协议统一要等 RFD 落地。

## Caveats / Not Found

- 未逐个验证 registry 里全部 40+ agent 的启动命令，只深挖了任务点名的 Gemini / Claude / Codex / Goose / Mistral 五家
- codex-acp 的 token usage 事件具体 JSON 字段未反编译验证（README 声明存在）
- Goose / Mistral Vibe 是否上报 token 用量未验证
- GitHub code search API 需鉴权，Gemini 结论均来自 raw file 直抓，文件内容以 main 分支 2026-08-16 快照为准
- ACP v2 的 usage 语义（idle state_update 携带 usage）仍在 RFD 阶段，未见 adapter 实装

## Sources

- https://agentclientprotocol.com/llms.txt （文档索引）
- https://agentclientprotocol.com/get-started/agents.md
- https://agentclientprotocol.com/get-started/registry.md
- https://agentclientprotocol.com/protocol/v1/session-setup.md
- https://agentclientprotocol.com/rfds/end-turn-token-usage.md / rfds/session-usage.md
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md + packages/cli/src/acp/*.ts + packages/cli/src/config/config.ts
- https://github.com/agentclientprotocol/claude-agent-acp + npm @agentclientprotocol/claude-agent-acp 0.69.0（tarball 实测）
- https://github.com/agentclientprotocol/codex-acp + 旧 https://github.com/zed-industries/codex-acp
- https://www.npmjs.com/package/@zed-industries/claude-code-acp
- https://goose-docs.ai/docs/guides/acp-clients
- https://github.com/mistralai/mistral-vibe/blob/main/docs/acp-setup.md
