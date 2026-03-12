# Channel Manager Modal Design

**Date:** 2026-03-12

## Goal

将「设置 -> 渠道」里的“渠道编辑器”从单列表单升级为更专业、更一致的“分栏渠道管理器（Modal）”，解决：

- 编辑/新增交互不直观、模式切换显得累赘
- 信息密度低、视觉不够优雅
- 长文本（Base URL/错误信息/渠道名）挤压布局，影响可读性

## Constraints / Non-Goals

- 不在 Web 端展示已保存的 API Key 明文，不提供“查看原值”的能力（只显示掩码）。
- 错误直出：同步模型失败不做自动 fallback（不自动尝试其他模型或渠道）。
- “我改哪里点哪里”：切换 Provider 不自动修改 Base URL，仅提供“填入默认”按钮让用户显式覆盖。
- 不更改现有后端数据结构与安全边界；本次仅调整 Web 端 UI/交互与复用逻辑。

## UX Summary (Approved)

### Entry

- Settings -> Channels 顶部保留单入口按钮（例如“渠道管理”）打开 Modal。
- 不再在卡片上提供第二入口（如铅笔按钮），避免入口分裂。

### Layout

**Desktop (>= sm):** Modal 内两栏：

- 左栏（约 35%）：渠道列表 + 搜索 + “+ 新建”
- 右栏（约 65%）：表单详情（编辑或新建共用一套表单）
- 右侧表单区域可滚动；底部操作栏（取消/保存）sticky 固定在底部

**Mobile (< sm):** 单栏：

- 顶部：可搜索的渠道选择 `Select` + “新建”按钮
- 下方：表单全宽
- 底部操作栏依旧 sticky

### Left List (Desktop)

- 展示启用与禁用渠道：
  - 禁用渠道置底、视觉弱化（灰色/Disabled badge）
  - 仍允许点进编辑
- 排序规则：
  - 默认渠道置顶
  - 启用渠道优先于禁用渠道
  - 同类按名称排序
- 列表项内容：
  - 主文本：`name`（单行截断）
  - 辅助：`provider` badge
  - 状态：`默认`、`已禁用` 等小标签

### Right Form (Create / Edit)

**Create defaults:**

- Provider：localStorage `channels.lastProvider`（默认 openai）
- Base URL：localStorage `channels.lastBaseUrl`（默认 OpenAI baseUrl），不强制与 Provider 匹配
- Enabled：true
- API Key：空（必填）

**Edit prefill:**

- 名称 / Provider / Base URL / Enabled：预填当前值
- API Key：预填 `********` 表示“已保存”
  - 保持掩码或留空表示“不修改”
  - 输入新 key（非空且不等于掩码）才更新

### Save Behavior

- Create:
  1. `POST /channels` 创建
  2. 自动 `POST /channels/:id/fetch-models` 同步模型
  3. 同步失败：关闭 Modal，并在渠道卡片内联 notice 显示真实错误
- Edit:
  1. 仅提交 diff 字段 `PUT /channels/:id`（未改不动；API Key 仅在输入新值时提交）
  2. 自动同步模型（同上）
  3. 同步失败：同上（错误直出，不 fallback）

## Visual / Polish Guidelines

- 所有可能很长的文本（渠道名、Base URL、错误原因）：
  - 列表项/标题处做单行截断（ellipsis）
  - 详情/错误文案处使用 `word-break: break-word` 或 `overflow-wrap: anywhere`，避免撑爆布局
- 表单间距克制，避免“大段说明文字”占垂直空间：
  - 使用小标题/Divider 分区
  - 描述文案保持短句
- 风格与 `ModelPickerModal` 保持一致（Badge/Group/ScrollArea 的密度与层级）。

## Acceptance Criteria

- 只有一个入口打开“渠道管理器”，在同一 Modal 内完成新增/编辑。
- Desktop 显示左列表右表单，Mobile 显示 Select + 表单；两端操作栏固定在底部。
- 禁用渠道可见可编辑但视觉弱化；默认渠道清晰标识。
- Provider 切换不改 Base URL；Base URL 有“填入默认”按钮。
- API Key 永远不展示明文；编辑时仅显示掩码并遵循“不改不动”。
- 保存后自动同步模型；同步失败错误直出，无 fallback。

