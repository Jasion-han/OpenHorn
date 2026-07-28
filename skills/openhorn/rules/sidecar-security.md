# Sidecar Security Rules

Sidecar 的安全姿态是**分层防御**的。改动任何一层之前先理解全部：

1. **本地端口 + Origin 隔离**：`index.ts` 强制 loopback，WebSocket 只接受 `tauri://localhost` / `localhost:5173` / `127.0.0.1:5173`。此外允许 `Origin` 为 null 的请求（原生/非浏览器客户端不发送 Origin 头），访问仍由 handshake token 把关。并发连接上限 2（webview 一个 + 诊断工具一个），超限 429。5 分钟 idle reaper。
2. **Handshake token**：Tauri 宿主每次 spawn 注入 32 字节 OsRng 随机值，RPC 前必须 `auth.handshake`。
3. **Workspace 边界**：`workspace.ts` 拒绝 `/`、`/etc`、`/usr`、家目录、`~/.ssh` 等敏感根。`resolveWritePathInsideWorkspace`（写操作）用 realpath-of-ancestor 防 symlink 跳出。`fs.ts` 的 `fsWriteText` **必须**用写操作专用函数。
4. **SDK fs 工具走同一套 workspace 校验**：Read 走 lexical，Write/Edit 走 realpath-of-ancestor。SDK 内置检查不能代替这一层。
5. **Shell 风险白名单**：`shell-risk.ts` 默认 `confirm`，只放行确定性无网络命令。复合 shell 一律 `confirm`。
6. **进程隔离靠 SDK 自己，本仓不写 sandbox wrapper**：`apps/sidecar/src` 里**没有**任何 `sandbox-exec` / `bwrap` / `allowUnsandboxedCommands` 调用——隔离完全依赖 Claude Code 二进制的内建行为。而 `claude.ts` 传的是 `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`，即**本仓不在这一层设防**，命令是否放行完全由第 5 层的 `shell-risk.ts` 白名单 + `canUseTool` 回调决定。评估攻击面时不要把这层当成一道防线。
   （本条 2026-07-28 修正：原文写着「macOS 用 sandbox-exec，Linux 用 bwrap，`allowUnsandboxedCommands: false`」——代码里搜不到这三个关键词，属于描述了一个不存在的管控。）
7. **凭据隔离**：绝不写 `process.env.ANTHROPIC_API_KEY`。apiKey 通过 SDK `options.env` per-call 传递。
8. **Checkpoint 归属校验**：`checkpoint.rollback` 必须命中 `ownedRunIds`。Rollback **只覆盖 SDK Write/Edit**，不覆盖 bash。

改 sidecar 代码后，`bun test` 全过不代表安全性没退化——仍需在 `tauri dev` 环境照攻击面清单实测。
