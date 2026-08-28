# 安全加固批次一

来源：全项目代码审查（sidecar / server 安全审查）。三个真实可利用的安全问题。

## 问题与目标

### 1. direct 运行时的 fs/bash 工具绕过 workspace 边界（高危）
`apps/sidecar/src/agent/direct.ts:137-198` 的 `read_file/list_dir/write_file/edit_file` 只做 `path.resolve(cwd, path)`，无 workspace 边界、无 symlink 防护。所有 OpenAI 协议模型走 direct，传入 `/etc/passwd` 或 `../../../.ssh/id_rsa` 即可读写 workspace 之外。

**目标**：复用 `workspace.ts` 的 `toWorkspaceRelative` + `resolvePathInsideWorkspace`（读）/ `resolveWritePathInsideWorkspace`（写），使 direct 的文件工具与 claude.ts 的 `checkSdkFsToolPath` 边界一致。绝对路径先归一化，逃逸则返回 Error 字符串（工具错误，不 crash agent）。

### 2. codex 子进程透传整个 process.env（中危）
`apps/sidecar/src/agent/codex.ts:112` `env: process.env`。danger-full-access 的 codex 拿到 `OPENHORN_HANDSHAKE_TOKEN` 和所有 API key。

**目标**：改用最小化白名单 env（参考 claude.ts 的剥离逻辑），至少剔除 `OPENHORN_HANDSHAKE_TOKEN` 及无关凭据。

### 3. JWT 弱默认密钥（高危）
`apps/server/src/services/authService.ts:8` `process.env.JWT_SECRET || "your-secret-key"`。未配置时回退公开字符串，可伪造任意用户 token。

**目标**：像 `utils.ts` 的 `ENCRYPTION_KEY` 一样 fail-fast——缺失即抛错拒绝启动。

## 验收
- direct 工具对绝对路径/`..`/symlink 逃逸返回错误，workspace 内正常读写
- codex 子进程 env 不含握手 token 与无关凭据
- JWT_SECRET 缺失时 server 启动即报错
- `pnpm --filter sidecar exec bun test` 与 server 类型检查通过
- sidecar 改动后需 `compile:tauri:host`
