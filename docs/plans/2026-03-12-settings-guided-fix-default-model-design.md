# Settings Guided Fix For Default Model (Channels)

**Problem**
当账号未完成“默认渠道 + 默认模型”的配置，或默认渠道缺失默认模型时，用户在 Chat/Agent/Header 里点击“去设置默认模型”只能进入 Settings 页面，但需要自己找 tab、找渠道、展开模型列表，修复路径不够直接。

**Goals**
- 点击 “去设置默认模型 / Set default model / 去设置” 后：
  - 自动切到 `Settings -> Channels` tab
  - 自动展开“最该修复”的渠道
  - 如果没有任何渠道，自动打开“添加渠道”弹窗
- “添加渠道”弹窗保持上次选择的 Provider（以及 Base URL 输入），减少重复输入。
- 引导行为只执行一次（通过 URL 参数触发，执行后清理 URL，避免刷新反复弹窗/展开）。

**Non-goals**
- 不自动替用户修改 Provider 或设置默认模型（仍由用户手动确认点击）。
- 不引入复杂的全局引导状态机（保持简单、可复用、可分享链接）。

## Approach

**URL 参数驱动（推荐）**
- 跳转链接统一使用：
  - `/settings?tab=channels&focus=default`
- `Settings` 页面读取 `tab` 参数，Tabs 改为受控，自动选中 `channels`。
- `ChannelSettings` 读取 `focus` 参数并执行引导：
  - `focus=default`：
    - 若存在“默认渠道（启用）”，展开它
    - 否则展开“最近更新的启用渠道”
    - 若一个渠道都没有，自动打开“添加渠道”弹窗
  - `focus=<channelId>`：优先展开该渠道（找不到则回退到上面规则）
- 执行完成后用 `router.replace()` 移除 `focus/action` 参数，避免重复执行。

## UX Details
- 展开渠道时，自动 `scrollIntoView`，让用户立刻看到模型区。
- 若默认渠道缺少默认模型，可在渠道标题区显示一个橙色 `Badge`（例如：`缺少默认模型`）。

## Verification
- 在未配置默认模型时，从 Header/Chat/Agent 点击“去设置默认模型”，会自动定位到 Channels 并展开目标渠道。
- 如果没有任何渠道，会直接弹出“添加渠道”弹窗，并且 Provider 记住上次选择。

