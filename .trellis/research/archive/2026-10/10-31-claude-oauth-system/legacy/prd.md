# Claude OAuth 渠道系统提示丢失

## Goal

默认的「Claude Code」渠道（anthropic 协议，`sk-ant-oat…` OAuth token，sidecar `runClaudeAgent`）上，模型自称
「没有任何系统提示」「我是 Claude」：OpenHorn agent 提示、生成式 UI 提示全部不生效。其他渠道（OpenRouter）正常。

## 假设（待验证）

`apps/sidecar/src/agent/claude.ts` 在 OAuth 时把 `x-anthropic-billing-header: cc_version=…; cc_entrypoint=sdk-cli;`
与其余系统提示用 `\n\n` 拼成**一个字符串**作为 `system`。服务端识别计费标记的那个 system 块，很可能把整个块当成
计费元数据处理掉 → 模型收不到任何系统提示。Claude Code 本身把计费标记作为独立的第一个 system 文本块发送。

## Requirements

* OAuth 时 `system` 改为文本块数组：第一块只含计费标记，第二块为其余系统提示（agent 提示 + ReAct + 用户/genUI 提示 + intent）。
  非 OAuth 行为不变（可仍用字符串，或同样的数组去掉计费块）。
* 抽成纯函数并加单测（OAuth → 两块且第一块恰为标记；非 OAuth → 不含标记）。
* 检查 sidecar 其他发往 Anthropic 的调用（如标题生成、compact 等）是否有同样拼接；有则一并修。
* 改完重新编译 sidecar：`pnpm --filter sidecar run compile:tauri:host`。
* 实机：Claude Code 渠道上问「你的系统提示里有没有 openui-lang 的说明？复述 Slider 签名」应能答出；
  生成式 UI 房贷计算器能渲染组件。

## Out of Scope

* Chat 模式（服务端）该渠道返回 429 的问题 —— 单独记录。
