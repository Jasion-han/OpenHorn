# Research: 开源 ACP（Agent Client Protocol）client 端实现调研

- **Query**: 调研现有 ACP client 端实现的集成方式，作为 OpenHorn sidecar（Bun + TS）实现 ACP client 的参考
- **Scope**: external（GitHub 源码 + 官方协议文档）+ internal（sidecar 现有校验设施）
- **Date**: 2026-08-16

## TL;DR

- 协议现状：v1（整数版本号），JSON-RPC 2.0 over stdio（ndjson 行分帧），官方 TS SDK `@agentclientprotocol/sdk` 1.0 已发布，Bun/TS 直接可用。client 最小面 = 出方向 4 个方法（initialize / session/new / session/prompt / session/cancel）+ 入方向 2 个 handler（session/update 通知、session/request_permission 请求）。fs / terminal / elicitation 全部可以在 initialize 里声明不支持，协议规定 agent **MUST NOT** 调用未声明的能力。
- 最贴近我们形态的参考：**obsidian-agent-client**（Electron/TS，spawn 子进程 + 进程树清理，`fs: false` + `terminal: true` 的真实先例）、**acpx**（headless TS client，session 持久化 + pid 存活检测 + 死进程 respawn→session/load 重连，fs 实现了 root-subtree 校验）、**Zed**（参考实现，fs 反向调用接 worktree 边界校验，越界返回 `resource_not_found`）、**marimo use-acp**（把 ACP 跑在 WebSocket 流上的先例，证明 SDK 与传输无关）。
- 对我们的映射（详见末节）：fs 反向调用接到现有 `workspace.ts` 的 symlink-aware 校验上（acpx/Zed 双先例）；terminal 能力 v1 可先声明不支持（Obsidian 先例），但 shell-risk 评分应挂在 `session/request_permission` 的 `toolCall.rawInput` 上——不管声不声明 terminal，agent 的 execute 类工具调用都会带着命令文本来请求许可。

---

## 0. 协议要点速查（写实现前必读的硬规则）

来源：https://agentclientprotocol.com/protocol/v1/（仓库 `agentclientprotocol/agent-client-protocol` 下 `docs/protocol/v1/*.mdx`，main 分支，2026-08 抓取）

- **initialize**：client 发 `protocolVersion: 1`（整数，仅 MAJOR）、`clientCapabilities`、`clientInfo{name,title,version}`。版本协商：agent 支持就原样返回，不支持则返回它支持的最新版；client 不认 agent 返回的版本时 **SHOULD** 关连接报错。**所有省略的 capability 一律视为不支持**，agent MUST NOT 调用（`fs/read_text_file`、`fs/write_text_file`、`terminal/*` 各自独立开关）。
- **agent 基线**：所有 agent MUST 支持 `session/new`、`session/prompt`、`session/cancel`、`session/update`；prompt 内容基线只有 `text` 和 `resource_link`，image/audio/embeddedContext 都要看 `promptCapabilities`。
- **prompt turn**：`session/prompt` 是一个长请求，期间 agent 用 `session/update` 通知流式推送（`agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan` / `usage_update` / `current_mode_update` / `available_commands_update` 等），最后以 `{stopReason}` 响应结束（`end_turn|max_tokens|max_turn_requests|refusal|cancelled`）。
- **取消的三条硬规则**（`prompt-turn.mdx` Cancellation 节，坑最多的地方）：
  1. client 发出 `session/cancel`（通知，无响应）后 **MUST** 用 `cancelled` outcome 应答所有 pending 的 `session/request_permission`；
  2. agent 收到 cancel 后 MAY 继续发若干 `session/update`，但 **MUST** 保证都发生在 `session/prompt` 响应之前——client **SHOULD** 继续接受 cancel 之后到达的 tool_call_update；
  3. agent MUST 把 abort 异常吞掉并返回 `cancelled` stopReason 而不是 error（否则 client 会把取消当错误弹给用户）。
- **permission**：`session/request_permission` 是 agent→client 的请求，带 `toolCall`（含 `toolCallId/title/kind/rawInput`）和 `options: PermissionOption[]`（`optionId` + `name` + `kind: allow_once|allow_always|reject_once|reject_always`）；响应 `outcome: {outcome:"selected", optionId}` 或 `{outcome:"cancelled"}`。client MAY 按用户设置自动允许/拒绝。
- **fs**（`file-system.mdx`）：`fs/read_text_file{sessionId, path(绝对), line?, limit?}` → `{content}`；`fs/write_text_file{sessionId, path, content}` → `null`，文件不存在 client MUST 创建。设计意图是让 agent 读到**编辑器里未保存的状态**、让 client 跟踪 agent 的改动。
- **terminal**（`terminals.mdx`）：`terminal/create`（含 `outputByteLimit`，截断 MUST 落在字符边界）→ `terminal/output` / `terminal/wait_for_exit` / `terminal/kill` / `terminal/release`。agent MUST 最终 release；kill 后 terminal 仍有效可取输出。
- **session 恢复**：三条路——`session/load`（重放全部历史为 update 流，capability `loadSession`）、`session/resume`（不重放，client 自管历史，capability `sessionCapabilities.resume`，2026 稳定）、`session/list`/`session/fork`（部分 agent 支持）。

---

## 1. 各实现对比

### 1.1 obsidian-agent-client（TS/Electron，★2.3k）— 与我们最同构

来源：https://github.com/RAIT-09/obsidian-agent-client（master 分支）
关键文件：`src/acp/acp-client.ts`（1008 行）、`src/acp/acp-handler.ts`、`src/acp/permission-handler.ts`、`src/acp/terminal-handler.ts`

**spawn/进程管理**（`acp-client.ts:251-349, 635-664`）：
- `spawn(cmd, args, { stdio: ["pipe","pipe","pipe"], detached: !isWin })` —— Unix 用 `detached: true` 建进程组，杀的时候 `process.kill(-pid, "SIGTERM")` 干掉**整棵进程树**；Windows 用 `taskkill /PID x /T /F`。这是防孤儿的核心手段（见 §3 Kiro 孤儿进程案例）。
- 换 agent / 重连前先 `killProcessTree()`；无自动重启，靠上层重新 `initialize()`。
- stderr 单独收进 8KB 滚动缓冲，用于诊断"agent 返回 end_turn 但一条 update 都没发"的静默失败（`sendPrompt` 里 stopReason==end_turn && updateCount==0 时查 stderr 提示）。
- 子进程 stdio 包成 Web Streams 后交给 SDK：`acp.ndJsonStream(input, output)`。

**client 注册面**（`acp-client.ts:388-417`）——SDK 1.0 builder API 的完整用法：

```ts
const app = acp.client({ name: "obsidian-agent-client" })
  .onNotification("session/update", (ctx) => this.handler.sessionUpdate(ctx.params))
  .onRequest("session/request_permission", (ctx) => this.handler.requestPermission(ctx.params))
  .onRequest("fs/read_text_file", (ctx) => this.handler.readTextFile(ctx.params))
  .onRequest("fs/write_text_file", (ctx) => this.handler.writeTextFile(ctx.params))
  .onRequest("terminal/create", ...).onRequest("terminal/output", ...)
  .onRequest("terminal/wait_for_exit", ...).onRequest("terminal/kill", ...)
  .onRequest("terminal/release", ...);
this.connection = app.connect(stream);
await this.connection.agent.request("initialize", {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
  clientInfo: {...},
});
```

**fs 反向调用：声明不支持**。`clientCapabilities.fs` 两项都是 `false`，agent（claude-agent-acp / codex-acp）落到自己进程内的 Read/Write 工具直接写盘。handler 里仍留了 stub（返回空串/空对象）兜底不守规矩的 agent。**这是"fs 声明不支持、让 agent 自己落地文件"路线的最大真实先例。**

**permission UX**（`permission-handler.ts`）：请求进队列（UI 一次只显示一个 active），每个请求生成 requestId 存 pending Map<requestId, resolve>，以 `tool_call` update 的形式携带 `permissionRequest{requestId, options, isActive}` 推给 UI，用户点按钮后 `respond(requestId, optionId)` resolve 挂起的 Promise。`autoAllow` 设置开启时自动选第一个 `allow_once|allow_always` 选项。`cancelAll()` 在 cancel/disconnect 时把所有 pending 以 `{outcome:"cancelled"}` resolve（正是协议 MUST 要求）。**注意其兼容层：agent 不带 option.kind 时按 name 含 "allow" 推断**。

**session 恢复**：实现了全部四种 —— `session/load`（历史经 onSessionUpdate 以 user_message_chunk 等重放）、`session/resume`（unstable，client 自存历史）、`session/list`、`session/fork`。关键细节：**发 load/resume 请求前先把 `currentSessionId` 置好**，否则重放的 update 会被 sessionId 过滤器丢掉（`acp-client.ts:908` 注释）。

### 1.2 acpx（TS headless CLI client，★3.1k）— session 持久化/进程回收的最佳参考

来源：https://github.com/openclaw/acpx（main 分支）
关键文件：`src/acp/client-process.ts`、`src/process-liveness.ts`、`src/runtime/engine/reconnect.ts`、`src/filesystem.ts`、`src/permission-policy.ts`、`conformance/cases/*.json`

**进程管理**：
- `waitForSpawn(child)`：race `spawn` 事件与 `error` 事件，spawn 失败立刻拒绝（不是等超时）。
- `isChildProcessRunning(child)`：`exitCode == null && signalCode == null`。
- `waitForChildExit(child, timeoutMs)`：同时挂 `close` + `exit`，超时返回 false 由上层升级为 SIGKILL。
- 辅助进程统一 `killSignal: "SIGKILL"` + 超时兜底（`runTimedExecFile`，8s 默认）。
- **孤儿回收**（`process-liveness.ts` + `reconnect.ts:456`）：session 记录持久化 agent 的 pid；重连时 `process.kill(pid, 0)` 探活，`saved session pid is dead; respawning agent and attempting session reconnect` —— 死了就重 spawn，再按能力走 `session/resume` → 降级 `session/load` → 都不支持则报 "agent does not support session/resume or session/load"（可配 `resumePolicy: "same-session-only"` 禁止降级建新会话）。resume/load 都包了超时（`withTimeout`）。

**fs 反向调用：实现 + root-subtree 校验**（`src/filesystem.ts:186-194`）：

```ts
private resolvePathWithinRoot(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  if (!isWithinRoot(this.rootDir, resolved)) {
    throw new Error(`Path is outside allowed cwd subtree: ${resolved}`);
  }
  return resolved;
}
```

rootDir = session cwd。**先例：headless client 也不裸转发 agent 的 fs 请求，越界直接抛错**（注意它只做 lexical resolve，没做 realpath/symlink 处理——比我们现有的 workspace.ts 弱）。

**permission**：headless 场景用声明式 policy（`--permission-policy` JSON：`autoApprove` / `autoDeny` / `escalate` 规则列表 + `defaultAction`），escalate 时才落到交互。另有 conformance 用例集（`conformance/cases/001-021`）覆盖 initialize 握手、update 流终止、cancel 在途、permission denied、cancel 后 follow-up 等——**给我们写 client 测试时可以直接抄场景清单**。

**Windows 坑的处理**：拒绝在 win32 上接受裸命令字符串（必须 argv 数组）、拒绝直接执行 .sh、WSL 下自动 `wslpath -w` 翻译 cwd。

### 1.3 Zed（Rust，协议发起者/参考 client）

来源：https://github.com/zed-industries/zed（main 分支）
关键文件：`crates/agent_servers/src/acp.rs`（5138 行）、`crates/acp_thread/src/acp_thread.rs`（10197 行）

**spawn/生命周期**（`acp.rs:849-975, 1528-1533`）：
- ShellBuilder 非交互模式 build 命令，piped stdio，spawn 后**把"连接握手完成"future 和"子进程退出"future 做 select race**——agent 起不来（退出）时立刻用滚动 stderr 缓冲构造 LoadError 展示给用户，而不是傻等握手超时。
- stderr 独立 task 逐行读，进滚动 debug log；`trailing_stderr()` 只取最后一段连续 stderr 作为错误上下文。
- `impl Drop for AcpConnection { child.kill() }` —— 连接对象析构即杀进程；**没有自动重启**，重试 = 重建整个 AcpConnection（issue #60213：SSH 断连后 agent 无法恢复，是这个设计的已知代价）。

**fs 反向调用：接到 project worktree 边界校验**（`acp_thread.rs:4212-4310`）：

```rust
let path = project.project_path_for_absolute_path(&path, cx)
    .ok_or_else(|| acp::Error::resource_not_found(Some(path.display().to_string())))?;
```

- 路径必须落在打开的 worktree 内，否则 `read` 返回 `resource_not_found`、`write` 返回 "invalid path"。
- read/write 都走编辑器 buffer 系统（读到未保存状态；写以 text_diff 生成最小编辑应用到 buffer，尊重 format_on_save），并记入 `action_log`（agent 改动审计，驱动 review/diff UI）。
- 真实代价见 issue #60156（2026-06，open）：Kimi CLI 想读自己 `~/.kimi-code/sessions/` 下的计划文件被拒，`/usage` 直接报 `readTextFile failed ... Resource not found`；社区建议给 agent 配置加 `allowed_paths` 白名单。**给我们的启示：agent 私有目录（~/.claude、~/.codex session 文件）在严格边界下会被误伤，需要预案。**

**permission UX**：`RequestPermissionOutcome::{Selected, Cancelled, InterruptedByFollowUp}` —— 第三种是 Zed 特有语义：用户没答复许可、直接发了新消息，视作对旧请求的 cancel（`acp_thread.rs:3743`）。选项按钮渲染在 tool_call 卡片上，`allow_always` 会被记住。

**macOS 深坑注释**（`acp.rs:930-940`）：连接 future 必须在专用线程上 poll——dev build 下入站消息的 dispatch 链需要 ~0.5MiB 栈，会打爆 GCD worker 固定 512KiB 的栈直接 crash。（Bun/JS 无此问题，但说明入站消息处理链路可能很深。）

### 1.4 marimo `use-acp`（TS React hooks，官方 org 相邻生态）— WebSocket 传输先例

来源：https://github.com/marimo-team/use-acp（main 分支）
关键文件：`src/client/acp-client.ts`、`src/connection/websocket-manager.ts`

- **证明 SDK 与传输无关**：把 `WebSocket` 包成 `ReadableStream/WritableStream` 对喂给 SDK（`createWebSocketReadableStream/WritableStream`），协议层完全复用。官方 typescript-sdk 也自带 `examples/ws-client.ts`、`server-sse.ts`、`http-stream.ts`（v2 草案在标准化 stdio 之外的传输，`docs/protocol/v1/transports.mdx`）。**对我们意义：ACP agent 子进程接 stdio，事件转发到桌面端 loopback WS，两段都能用同一套流抽象。**
- client 实现只有 4 个方法：`sessionUpdate`（转回调）、`requestPermission`（生成 deferredId 挂 Deferred，UI resolve）、`readTextFile`/`writeTextFile`（可选 handler，没提供就 throw）。
- WS 断线重连：指数无、固定 delay（默认 1s×3 次）；`ListeningAgent` 装饰器把每个出方向调用包上 `on_X_start`/`on_X_response` 回调 + JSON-RPC 错误归一化。**注意它没有做重连后的会话状态恢复**（浏览器场景由 server 端保 session）。

### 1.5 官方 TypeScript SDK（`@agentclientprotocol/sdk`）

来源：https://github.com/agentclientprotocol/typescript-sdk（main 分支）
关键文件：`src/examples/client.ts`（最小 client 全文 176 行）、`src/acp.ts`、`src/line-buffer.ts`、`src/protocol-router.ts`

- 最小 client 示例：`acp.client({name}).onRequest(requestPermission).onRequest(fs 两个).connectWith(stream, async ctx => { await ctx.request(initialize); return ctx.buildSession(cwd).withSession(async session => { session.prompt(...); for(;;){ const m = await session.nextUpdate(); if (m.kind==="stop") return m.response; ... } }) })`。
- `ndJsonStream` + `line-buffer.ts` 处理行分帧/跨 chunk 的 UTF-8 边界，**不要自己手写按 \n split**。
- schema 全量 zod 定义（`schema/zod.gen.ts`），`PROTOCOL_VERSION` 常量导出。SDK 1.0（2026）换成了 builder API，旧 `ClientSideConnection` 构造器已废弃（obsidian client 的注释明确说明了迁移路径）。
- 注意 SDK 面向 Node API（`node:stream` 互转），Bun 兼容 node:child_process/streams，但**接入后需在 Bun 下实测 ndJsonStream 与 child stdio 的组合**（未发现 Bun 专属 issue，但也没找到 Bun 生产使用先例）。

### 1.6 要连的 agent 侧（决定我们 client 需要陪跑到什么程度）

- **claude-agent-acp**（https://github.com/agentclientprotocol/claude-agent-acp，官方，包 `@agentclientprotocol/claude-agent-acp`）：Claude Agent SDK → ACP。permission 请求带 `$/cancel_request` 取消信号联动；`_meta["subagent-transcript"]`、`terminal-auth` 等扩展 capability 全部 opt-in，不声明就走兼容降级（flattened transcript）。其源码注释多处印证协议坑（如 permission 请求可能先于对应 tool_call 的流式到达——client 不能假设 `toolCall.toolCallId` 已存在，Obsidian 的 permission-handler 也为此把 toolCallId 做了缺省生成）。
- **codex-acp**（官方 `agentclientprotocol/codex-acp` 与社区 `cola-io/codex-acp`）、gemini-cli 原生支持 ACP。官方 registry：https://github.com/agentclientprotocol/registry。

---

## 2. Client 最小实现面（回答问题 2）

跑通 "prompt → 流式输出" 必须有：

| 方向 | 方法 | 必须? |
|---|---|---|
| client→agent | `initialize` | 必须（版本+能力协商） |
| client→agent | `session/new` | 必须 |
| client→agent | `session/prompt` | 必须（长请求，响应即 turn 结束） |
| client→agent (通知) | `session/cancel` | 必须（没有它无法安全打断） |
| agent→client (通知) | `session/update` | 必须处理（至少 `agent_message_chunk`、`tool_call`、`tool_call_update`；未知类型忽略） |
| agent→client (请求) | `session/request_permission` | 必须应答（哪怕是自动策略；不答 turn 会卡死——Zed #62015 就是 sub-agent 许可无人应答导致挂起） |
| client→agent | `authenticate` | 半必须：initialize 返回 `authMethods` 非空且未登录的 agent 会在 session/new 时报 auth_required |

**可以先声明不支持（initialize 里省略即为不支持，协议保证 agent 不会调）**：
- `fs.readTextFile` / `fs.writeTextFile` —— Obsidian 先例：全 false 也完全可用，agent 自己读写盘；
- `terminal` —— 不声明则 agent 用自己进程内的 shell 工具；
- `elicitation`、`session.configOptions.boolean` —— 省略即可；
- agent 侧能力（`loadSession`/`resume`/`list`/`fork`、image/audio prompt）按 initialize 响应探测后再用，MUST NOT 盲调。

## 3. 常见坑（回答问题 3，全部有 issue/源码实证）

1. **孤儿/僵尸进程**：kirodotdev/Kiro #6050 —— SIGTERM 只杀了 `kiro-cli acp` 外壳，其子进程 `kiro-cli-chat` + 它拉起的所有 MCP server 变孤儿（PPID→1）常驻。**每个 ACP agent 都可能再 spawn 子进程/MCP server，必须按进程组杀**（Obsidian 的 `detached:true` + `kill(-pid)` / Windows `taskkill /T` 是标准答案）；acpx 另加 pid 探活防"记录里的进程早死了"。CodeCompanion #3274：容器化 agent 被 SIGKILL 直接杀导致容器不优雅退出——先 SIGTERM 给宽限期再升级。
2. **事件竞态/乱序**：CodeCompanion #3214 —— 带首条消息新建聊天时两条代码路径都去建连接，产生**重复 initialize + session/new**，`session/update` 挂到错误的会话上，间歇性空回复。教训：连接建立要单飞（single-flight promise）。claude-agent-acp 源码注释：**permission 请求可能先于其 tool_call update 到达**，client 不能假设 toolCallId 已知。协议规定 cancel 后仍可能收 update，client SHOULD 照收（obsidian #326 permission 按钮残留就是 cancel 清理不彻底）。
3. **取消语义被错报为 error**：协议文档专门加了 Warning——agent abort 时底层库抛异常会变成 error response，client 会当错误弹窗；同时 client 忘记对 pending permission 回 `cancelled` 会让 agent 侧 await 永远挂起。CodeCompanion #2824（打断不生效）同类。
4. **静默空响应**：obsidian `sendPrompt` 的经验——agent 缺 API key 等配置错误时可能返回 `end_turn` 且 0 条 update，错误只在 stderr 里。需要滚动 stderr 缓冲 + "end_turn 但无 update" 检测。
5. **workspace 边界误伤 agent 私有目录**：Zed #60156——agent 要读自己 `~/.kimi-code/sessions/...` 被 client 的 fs 校验拒绝，功能直接报错。
6. **恢复链路脆弱**：Zed #60213（SSH 断连无法恢复 agent）；acpx 文档明确 resume→load→新会话的降级链 + `same-session-only` 策略；obsidian #320（重开保存的会话，最后一条回复被截断——历史重放的完整性问题）。协议侧 `session/resume` 2026 年才稳定（announcements/session-resume-stabilized），老 agent 只有 `session/load` 或什么都没有，**必须按 capability 探测降级**。
7. **Windows/编码类**：acpx 直接禁掉 win32 裸命令字符串与 .sh 直启；obsidian 为 Electron PATH 缺失、WSL 环境变量穿透（WSLENV，#312）做了大量补丁。行分帧要用 SDK 的 line-buffer（跨 chunk UTF-8 边界、`outputByteLimit` 截断 MUST 落在字符边界是协议明文）。
8. **协议方言**：agent 不带 `option.kind`（obsidian 按 name 兜底推断）、agentInfo 名不副实（codex-acp 包迁移后 bin 名未变）、`sessionCapabilities.resume` 语义早期含混（协议 repo #1378/#1104）。初期按"宽进严出"处理：未知 update 类型忽略，缺字段给缺省。

## 4. 映射到 OpenHorn sidecar 的建议（回答问题 4）

现有设施（internal 实测）：
- `apps/sidecar/src/workspace.ts` —— `resolvePathInsideWorkspace` / `assertExistingPathInsideWorkspace`：realpath 最深已存在祖先 + 终端组件 O_NOFOLLOW，明确处理 symlink TOCTOU（比 acpx 的纯 lexical 校验强，与 Zed worktree 校验同级）。
- `apps/sidecar/src/fs.ts` —— `fsReadText` / `fsWriteText` 已存在。
- `apps/sidecar/src/shell-risk.ts` → `shared/shell-risk` 的 `classifyBashCommandRisk`。
- `apps/sidecar/src/checkpoints.ts` —— 改动审计（对应 Zed 的 action_log 角色）。

**建议 A（fs）：声明 `fs: {readTextFile: true, writeTextFile: true}`，handler 直接接 `resolvePathInsideWorkspace`/`assertExistingPathInsideWorkspace` + fsReadText/fsWriteText。**
- 先例：acpx `resolvePathWithinRoot`（越界抛错）、Zed `project_path_for_absolute_path`（越界 `resource_not_found`）。两个最严肃的 client 都实现了 fs 且都接边界校验，没有一个裸转发。
- 收益：agent 写文件走我们的管道 → checkpoints 审计天然生效；错误码用 `resource_not_found`（Zed 同款）而不是泛化 Error，agent 能优雅降级到自己的工具。
- 必须带的预案（Zed #60156 教训）：agent 自己 home 下的会话/计划文件读取会被拒。两个选项：只对 read 放行一个显式白名单（如 `~/.claude`、`~/.codex` 的只读子集），或接受该报错让 agent 降级用自己的 Read 工具（fs 越界失败 ≠ turn 失败）。倾向后者起步，观察真实报错再加白名单。
- 保守替代：v1 直接 `fs: false`（Obsidian 先例，完全可用），代价是 agent 改动不进我们的 fs 管道、checkpoints 看不到 agent 写盘。**不推荐**——我们的校验设施已经现成，接上成本很低。

**建议 B（terminal）：v1 声明不支持（省略 `terminal`）。**
- 先例：Obsidian 是唯一完整实现 terminal 五方法的 TS client（281 行 terminal-handler），实现面不小（outputByteLimit 字符边界截断、kill 后仍可取输出、必须 release 的生命周期）；marimo/acpx 都没实现。
- 关键认知：**声明 terminal:false 并不能阻止命令执行**——agent（claude/codex CLI）会用自己进程内的 Bash 工具执行，命令根本不经过我们。所以 shell-risk 评分的正确挂点不是 terminal handler，而是 **`session/request_permission` handler**：`toolCall.kind === "execute"` 时从 `toolCall.rawInput` 取命令文本过 `classifyBashCommandRisk`，据此决定自动放行/升级人工确认/自动拒绝。acpx 的 permission-policy（autoApprove/autoDeny/escalate + defaultAction）就是这个模式的声明式版本，可直接借鉴其规则形状。
- 后续若要收编执行权（让命令真正跑在我们的沙箱里），再补 terminal:true + 接 shell-risk 于 `terminal/create`——那是把执行面从 agent 进程搬进 sidecar 的第二阶段。

**建议 C（进程生命周期）**：spawn 用 `detached: true`（进程组）+ 退出时 `kill(-pid, SIGTERM)` → 超时（acpx: waitForChildExit）→ SIGKILL；握手 race 子进程退出（Zed 模式）快速失败并带 trailing stderr；stderr 滚动缓冲 + "end_turn 无 update" 静默失败检测（Obsidian 模式）；连接建立 single-flight（CodeCompanion #3214 反例）。

**建议 D（session 恢复）**：持久化 `{acpSessionId, pid, cwd, agentCommand}`；重连时 pid 探活（`process.kill(pid,0)`）→ 活着直接复用连接，死了 respawn 后按 capability 走 `session/resume` → `session/load`（重放进 UI）→ 建新会话，逐级降级并明确告知用户（acpx reconnect.ts 全套先例）。

## Caveats / Not Found

- JetBrains 的 ACP client 实现未找到公开仓库（只有官方 kotlin-sdk）；avante.nvim 的 ACP 支持未单独调研（CodeCompanion 的 issue 已覆盖 Neovim 侧坑位）。
- claude-agent-acp 内部"client 声明 fs 后是否把 SDK 的 Read/Write 工具替换为 client fs 调用"的具体开关点没有完全定位（5305 行处有 client fs 代理，但路由条件在 SDK query options 深处）；不影响结论——协议保证不声明就不会被调。
- SDK 在 Bun 运行时下与 child_process stdio 组合未见公开先例，实现时需первым实测（`ndJsonStream` 依赖 Web Streams，Bun 支持，但需验证背压行为）。
- 所有 GitHub 内容为 2026-08-16 抓取的 main/master 分支状态；ACP v2 已有 draft（`docs/announcements/acp-v2-draft.mdx`），v1 仍是稳定目标。
