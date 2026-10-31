# sidecar 进程在应用退出后残留

## 现象

实机：正常 Cmd+Q 退出桌面端后，`openhorn-sidecar` 进程仍在；一天下来累积 4 个（每个是一个 bun 进程，
占内存，还各自监听 loopback 端口）。

## 根因

1. `apps/desktop/src-tauri/src/lib.rs` 只在 `WindowEvent::CloseRequested` 时 kill sidecar。macOS 上 Cmd+Q /
   菜单「退出」走 `RunEvent::ExitRequested` / `RunEvent::Exit`，不触发窗口 CloseRequested，于是不清理。
2. 父进程被强杀（崩溃、`tauri dev` 改 Rust 后重启、kill -9）时 Rust 无机会清理；sidecar 不感知父进程消失。

## Requirements

* Rust：改用 `.build(ctx)?.run(|app, event| …)`，在 `RunEvent::Exit`（必要时也在 `ExitRequested`）里执行与
  CloseRequested 相同的清理（kill 子进程 + remove_endpoint_file）；把清理抽成一个函数复用。保留 CloseRequested 分支。
* sidecar：父进程看门狗 —— 启动时记录 `process.ppid`，定时（如 2s，`unref()` 不阻止退出）检查；ppid 变化
  （被 launchd/init 收养，macOS 上变为 1）即优雅退出（走已有的 exit 清理：drainMcpPool 等）。若 Tauri 以管道接管
  stdin，也可监听 stdin `end`/`close` 作为第二信号 —— 先确认 tauri-plugin-shell 的 sidecar spawn 是否保持 stdin 管道，
  不确定就只做 ppid 看门狗。看门狗只在由 Tauri 启动时启用（例如有握手 token / 特定环境变量），单独 `bun run` 调试时不应误退出 ——
  按现有启动参数判断。
* 遵守 `skills/openhorn/rules/sidecar-security.md`。
* 单测：看门狗判定逻辑抽成纯函数测试；Rust 侧清理函数如可测则测。
* 改完重编 sidecar：`pnpm --filter sidecar run compile:tauri:host`；`cargo check`/`cargo test --no-default-features` 通过。

## Acceptance Criteria

* [ ] Cmd+Q 后无 openhorn-sidecar 残留
* [ ] kill -9 应用主进程后，sidecar 在几秒内自行退出
* [ ] 正常使用中 sidecar 不会误退出
