# Agent Channel Agent-Check Design

**Goal:** 在「设置 -> 渠道配置」中为每个渠道提供一个“Agent 兼容性检查”，允许用户选择某个 `modelId` 进行一次真实的 Claude Agent SDK 探测，以判断该渠道（含中转）是否能跑 Agent。

## Constraints

- 只做“检查”，不做任何自动修复、不自动切换 Provider/模型、不自动 fallback 到其他渠道或模型。
- 失败必须把真实错误原样返回给用户（在 UI 内联提示），不要用“开始运行/已连接”等无意义文本刷屏。
- 不泄露敏感信息：不能把 `apiKey` 写入日志/响应/前端状态。

## UX

入口位置：`设置 -> 渠道配置` 每个渠道卡片右上角 actions 增加一个按钮 `Agent 检查`。

点击后弹窗：

- 选择模型：优先从该渠道已同步的模型列表中选择 `modelId`。
- 当该渠道尚未同步模型或模型列表为空：允许“手动输入 modelId”，以便用户仍可验证 relay 的可用性。
- 操作结果：
  - 成功：toast `Agent 兼容`，并清掉该渠道之前的 notice（如果有）。
  - 失败：将错误写入该渠道的内联 notice（沿用现有 `channelNotice[channelId]` 展示卡），错误文案直接使用后端返回的 `error`。

## API

新增 endpoint：

- `POST /channels/:id/agent-check`

Request body：

- `{ modelId: string }`

Response：

- `{ success: true }`
- `{ success: false, error: string }`

## Server Behavior

核心逻辑：对指定渠道 + 指定 `modelId` 做一次 **最小化** Claude Agent SDK 探测。

- 解析渠道（复用现有 `channelService` 的解密与 baseUrl runtime 归一化逻辑）：
  - 获取渠道 `apiKey`（解密）
  - 获取 `baseUrl`（用 runtime baseUrl 规则归一化，尤其是 anthropic 的 `/v1` 与根路径差异）
- Probe 运行参数（尽量低成本且无副作用）：
  - `permissionMode: 'plan'`（禁止执行工具）
  - `maxTurns: 1`
  - `prompt` 使用短文本（例如“只回复 OK”）
  - `timeout`: 12-15 秒（无输出则 abort）
  - 不设置 `fallbackModel`（避免隐式切换）
- 判定：
  - 收到任何非 `meta` 的 `text` 输出，即判定 `success: true`。
  - 收到 `error`（含 SDK result error 转换），返回 `success: false` 且错误直出。
  - 超时返回 `success: false`，错误文案指向“长时间无响应，可能 relay 不兼容 Claude Agent SDK”。

## Edge Cases

- 渠道被禁用：仍允许检查（因为“检查”是诊断工具），但 UI 层可提示“该渠道已禁用”。
- 渠道缺少 baseUrl：直接失败并提示补全。
- 用户传入的 `modelId` 不存在于已同步列表：允许（因为 relay 可能不支持列模型，但仍可跑某个模型）。

## Testing

- Server 单测覆盖：
  - `agent-check` 在 provider/baseUrl 异常时返回 `{ success:false, error }`。
  - 超时路径（模拟 abort）返回明确错误。
- Web：
  - Typecheck
  - 手动回归：对一个确定可用的 anthropic 渠道检查成功；对不兼容 relay 检查失败并展示真实错误。

