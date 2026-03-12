# Channels Editor Unify Design

**Goal:** 将“添加渠道”和“编辑渠道”合并为同一个弹窗与同一套表单逻辑，提升一致性并减少重复实现。

## UX / Rules

- 同一弹窗支持两种模式：`create` / `edit`。
- 字段一致：名称 / Provider / Base URL / 启用 / API Key
- Provider 切换时 **不自动修改 Base URL**（遵循“我改哪里点哪里”）。
- Base URL 旁提供按钮“填入默认”，点击后才覆盖为该 Provider 的默认 Base URL。

### Default Values

- `create`：
  - Provider 默认使用“上次选择的 provider”（localStorage: `channels.lastProvider`）
  - Base URL 默认使用“上次使用的 baseUrl”（localStorage: `channels.lastBaseUrl`），不强制与 Provider 匹配
  - enabled 默认 `true`
  - apiKey 为空（必填）
- `edit`：
  - 所有字段预填当前渠道值
  - apiKey 预填掩码 `********` 表示“已保存”

### API Key Policy

- Web 端不展示已保存 key 明文。
- `create`：
  - apiKey 必填，且不能为 `********`
- `edit`：
  - 保持掩码 `********` 或留空表示“不修改”
  - 输入新 key（非空且不等于掩码）才会更新

## Save Behavior

- `create`：创建成功后自动“同步模型”（`POST /channels/:id/fetch-models`），并展开该渠道卡片。
- `edit`：保存成功后自动“同步模型”，并展开该渠道卡片。
- 同步失败：关闭弹窗，在该渠道卡片内联 notice 显示真实错误（不 fallback、不自动切换）。

## Implementation Notes

- 新增可复用组件 `ChannelEditorModal`：
  - props: `mode`, `channel?`, `opened`, `onClose`, `onSaved(channelId)`
  - 内部完成 diff 构建、update/create 调用、自动 sync models、notice/toast 协调。
- `ChannelSettings` 仅负责：
  - 打开/关闭 modal
  - 渠道列表渲染与 action buttons
  - 存储/显示 `channelNotice`

