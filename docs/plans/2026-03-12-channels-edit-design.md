# Channels Edit Design

**Goal:** 在「设置 -> 渠道配置」中支持编辑已有渠道（name/provider/baseUrl/enabled/apiKey），用于用户自助验证不同 Provider/Base URL 的组合，并在保存后自动同步模型列表。

## Constraints

- **安全边界：** 不在 Web 端展示已保存的 API Key 明文，不提供“直接查看原值”的能力。
- **不改的不动：** 编辑弹窗默认预填当前值；提交时只发送发生变化的字段。`apiKey` 只有在用户输入新值时才提交。
- **保存后自动同步模型：** 更新渠道成功后自动执行一次“同步模型”，并复用现有内联 notice 展示同步结果（错误直出，不自动 fallback）。

## UX

入口：

- 在每个渠道卡片右上角 actions 增加“编辑”（铅笔）按钮。

编辑弹窗（预填）：

- 名称：预填
- Provider：预填；切换 Provider 时 **Base URL 不自动变化**
- Base URL：预填；提供一个小按钮“填入默认 Base URL”（点击后才覆盖）
- 启用：Checkbox 预填
- API Key：预填掩码（例如 `********`）表示“已保存”。提示文案：保持掩码/留空表示不修改；输入新 key 会替换旧 key。

保存行为：

- 点击“保存”：
  1. 调用 `PUT /channels/:id` 更新渠道（只提交 diff 字段；`apiKey` 仅在输入新值时提交）
  2. 调用 `POST /channels/:id/fetch-models` 自动同步模型列表
  3. 刷新渠道列表并展开当前渠道卡片

错误展示：

- 更新失败：toast 直出错误，编辑弹窗保持打开。
- 更新成功但同步失败：关闭弹窗，在该渠道卡片内联 notice 展示失败原因（与现有“同步模型”一致）。

## Notes

- Mantine 的 `PasswordInput` 只用于显示/隐藏用户当前输入（掩码或新 key），不会显示后端真实 key。
- 若用户尝试禁用默认渠道，后端会拒绝；前端保持直出错误即可。

