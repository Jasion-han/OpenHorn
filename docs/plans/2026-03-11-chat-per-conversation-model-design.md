# Chat Per-Conversation Model (Proma-like) Design

日期: 2026-03-11

## 背景与目标

当前 OpenHorn Web 已有 AppShell 与 Chat/Agent/Settings 的统一壳子，但 Chat 仍偏 demo：会话侧栏能力弱、交互提示分散（`alert/confirm/console`）、模型选择仅“全局默认”且缺少对话级覆盖。

本设计目标是对标 Proma 的使用体验，在不推翻现有技术栈（Next.js + Mantine + Zustand）的前提下，补齐 Chat 主链路的关键交互，并引入“全局默认 + 按对话覆盖”的模型选择与持久化。

## 范围

### In Scope (本轮)

1. 模型选择策略: 混合模式 (C)
   - 全局默认渠道/模型: Settings 配置，作为新对话的默认与兜底
   - 对话级覆盖: 每个对话可选择 `channelId + modelId` 并持久化到该对话
2. ChatAside 对标 Proma 的结构与信息组织
   - 新对话（无需先输入标题）
   - 搜索
   - 置顶区（可折叠）
   - 列表按 `今天/昨天/更早` 分组（以 `updatedAt`）
   - 会话项菜单: 重命名、置顶/取消置顶、删除（UI 确认）
3. ChatHeader
   - 标题 + 当前生效模型 Badge（继承/覆盖）
   - 点击打开模型选择弹窗（按渠道分组 + 搜索）
4. 统一反馈与错误处理
   - 删除确认使用 Mantine Modal/Confirm
   - 成功/失败提示使用 Mantine Notifications（替换 `alert/confirm/console.error` 的用户面）
   - 不把错误文本写入 assistant 气泡（气泡只显示正常输出）

### Out of Scope (本轮)

- 完整复刻 Proma 的 RichText 输入框、工具栏、拖拽附件等全套输入体验
- Agent Teams、Memory、Prompt 系统等更大功能
- 多端（Electron）一致性

## 用户体验与交互规范

### 1) 生效模型的展示与选择

- ChatHeader 右侧显示 `ModelBadge`:
  - 若对话已设置 `channelId + modelId`，显示该组合
  - 否则显示 “继承默认: {default provider · model}”
  - 若全局默认不存在，显示 “未配置默认模型”，点击跳转 Settings
- 点击 `ModelBadge` 打开 `ModelPickerModal`:
  - 顶部搜索框（按渠道名/模型名过滤）
  - 列表按渠道分组展示:
    - 仅展示 `enabled=true` 的渠道
    - 仅展示 `enabled=true` 的模型
  - 选择项后:
    - 立即写入对话（持久化）
    - 关闭弹窗

### 2) 失败与回退策略

后端解析优先级（发送/流式）：
1. 若对话设置了 `channelId/modelId`:
   - 校验该渠道属于用户且启用
   - 校验该模型属于该渠道且启用
   - 成立则使用该模型
2. 否则或校验失败:
   - 回退到全局默认渠道与默认模型（当前 `getResolvedChannelForUser(userId, null)`）
3. 若仍无可用模型:
   - 返回明确错误（例如 `No channel configured`）
   - 前端以通知提示，并引导去 Settings 配置

对话级覆盖被禁用/删除后的表现:
- 不阻塞 UI 打开对话
- 发送时自动回退并提示 “已回退到默认模型”

### 3) ChatAside（对标 Proma 的信息架构）

- 顶部:
  - `新对话` 按钮（primary），点击即创建
  - 搜索框
- 置顶对话:
  - 可折叠
  - 置顶项在上方独立展示
- 对话列表:
  - 按 `updatedAt` 分组 `今天/昨天/更早`
  - 会话项：
    - 标题（单行省略）
    - 右侧菜单按钮（...）
    - streaming 时可显示轻量状态（可选）
- 会话菜单:
  - 重命名（inline 或 modal）
  - 置顶/取消置顶
  - 删除（确认弹窗）

## 数据模型与 API 设计

### 1) 数据库

在 `conversations` 表新增:
- `modelId TEXT NULL`

规则:
- `channelId` 与 `modelId` 必须保持一致性:
  - 都为空: 继承全局默认
  - 都不为空: 对话级覆盖

### 2) Server API

复用现有 endpoints，做向后兼容扩展:

- `POST /conversations`
  - input: `{ title: string; channelId?: string; modelId?: string }`
  - 行为:
    - 若传了 `channelId/modelId`，写入对话
    - 否则存空（继承全局默认）

- `PUT /conversations/:id`
  - 允许更新:
    - `title`
    - `systemPrompt`
    - `contextLength`
    - `isPinned`
    - `channelId` + `modelId`（模型覆盖）

### 3) Server 解析逻辑

在 `messageService.sendMessage/streamMessage` 中，在调用 adapter 前解析 `resolvedChannel`:
- 优先使用对话内 `channelId`（且额外校验 `modelId`）
- 否则回退默认

需要补充一个服务方法（建议在 `channelService` 内）:
- `getResolvedChannelForConversation(userId, conversation)`
  - 如果 conversation 有 `channelId/modelId`：
    - 加载该渠道（owned + enabled）
    - 校验模型是否存在且 enabled
    - 生成运行时 baseUrl + 解密 apiKey
  - 否则调用现有 `getResolvedChannelForUser(userId, null)`

## 前端组件与状态

### 1) Store 调整 (Zustand)

- `Conversation` 增加:
  - `modelId?: string`
- 增加对话级模型选择 helpers（避免重复实现）:
  - `getEffectiveModelForConversation(conversation, channels)`
  - `setConversationModel(conversationId, channelId, modelId)`:
    - 乐观更新 store
    - 调用 `api.conversations.update`
    - 失败回滚 + notification

### 2) 组件拆分建议

- `ChatHeader`（新）
  - title
  - `ModelBadge`（按钮样式）
  - `ModelPickerModal`
- `ChatAside`（改造）
  - `NewConversationButton`
  - `PinnedSection`
  - `ConversationGroupList`
  - `ConversationRow` + `ConversationRowMenu`

### 3) Notifications/Modals

建议接入 Mantine 官方:
- `@mantine/notifications`
- `@mantine/modals`

在 root layout 注入 providers，提供:
- `notifySuccess/notifyError` 工具函数（轻封装，统一文案风格）

## 错误处理规范

- 用户可恢复的错误（网络失败、模型不可用）:
  - 通知提示
  - 保持 UI 可操作，必要时提供 “去设置” CTA
- 系统错误（未登录）:
  - 由 AuthBootstrap 负责重定向
- 不把错误文本写进 assistant bubble（避免污染对话）

## 验证与测试

本仓库当前未见专门 E2E 测试框架，本轮以以下方式验证:
- Server:
  - 创建对话后更新 `channelId/modelId`，验证落库
  - 发送消息时优先走对话模型；禁用后回退默认
- Web:
  - ModelPickerModal 可正常列出渠道/模型、搜索、选择后持久化
  - ChatAside: 置顶折叠、分组、菜单操作均可用
  - 所有 confirm/alert 替换为 UI modal/notification

