# Agent 模式 Claude Code process exited with code 1 排查修复

## 结论（2026-09-08 归档）
根因：`useSidecarAgentRun` 常驻挂载，启动时 ACP 预连接拿到的 session id 存在 hook 状态里，
后续 Anthropic 渠道的回合把它当作 `resume` 传给 Claude CLI，CLI 找不到该会话直接退出 1，
没有 stderr。修复见 commit 5cc46d2（session id 带协议 + 会话标签，不匹配不 resume）。

排查手段：给 SDK `query` 传 `stderr` 回调 + `DEBUG_CLAUDE_AGENT_SDK=1`，并把 queryOptions
dump 成 JSON，`resume` 字段一眼可见。真机验证：Anthropic 回合恢复正常（pwd 回合成功）。
