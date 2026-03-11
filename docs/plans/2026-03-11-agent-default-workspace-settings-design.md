---
date: 2026-03-11
feature: agent-default-workspace-settings
status: approved
---

# Agent 默认 Workspace（账号级全局设置）设计

## 背景与目标

当前 Agent 页面运行任务依赖 Workspace（cwd）配置，但 Workspace 选择只能在 Settings 页面完成，且不具备“跟账号走”的全局默认能力，导致使用链路割裂、验证成本高。

**目标：**
- 提供“账号级全局默认 Workspace”，在 Agent 页面切换后立即生效并自动保存
- 换设备/换浏览器登录可继承默认 Workspace
- 服务端兜底：即使客户端未显式传递 workspaceId，也能使用默认 Workspace（可选增强）

## 范围（In Scope）

- 新增 Settings 读写 API（按 userId 隔离）
- 约定一个 settings key：`agent.defaultWorkspaceId`
- Web 端：
  - Agent 页内可选择 Workspace（并自动保存）
  - 当 setting 指向不存在的 workspace 时自动修正为第一个可用 workspace（并写回）

## 非目标（Out of Scope）

- “按 session 级别绑定 workspace” 的覆盖机制（后续可加）
- 多 key 批量编辑 UI（先满足最小闭环）

## 方案对比

### 方案 A（采用）：settings 表 + /settings API
- 以 `settings(user_id, key, value)` 存储账号级配置
- Web/Server 都统一通过 settings service 读写
- 优点：可扩展、可多端同步、符合“跟账号走”

### 方案 B：localStorage
- 优点：实现快
- 缺点：不满足多端同步，与需求冲突

### 方案 C：users 表加字段
- 优点：字段直观
- 缺点：扩展性差，每个设置都要加字段

## 数据模型

**settings key：** `agent.defaultWorkspaceId`  
**value：** workspaceId 字符串  
**清空：** 删除 key 或 value = null（等价表示未设置）

## API 设计

### 读取
- `GET /settings?keys=agent.defaultWorkspaceId`
- 响应：
  - `{ settings: { "agent.defaultWorkspaceId": "ws_xxx" } }`
  - 未设置时：`{ settings: {} }` 或该 key 不存在

### 写入
- `PUT /settings/agent.defaultWorkspaceId`
- body：
  - `{ value: "ws_xxx" }` 设置
  - `{ value: null }` 清空（服务端执行 delete）
- 响应：`{ success: true }`

## 前端行为

### 初始化加载
- 并行请求：
  - `api.workspaces.list()`
  - `api.settings.get(keys=[agent.defaultWorkspaceId])`
- 选择决策：
  - setting 指向的 workspace 存在：选中它
  - setting 为空或指向不存在：
    - 若 workspaces 非空：选中第一个 workspace，并写回 setting
    - 若 workspaces 为空：保持未选择状态并提示创建 workspace

### 用户切换 Workspace（立即生效）
- UI 乐观更新（立即切换）
- 异步写回 `PUT /settings/agent.defaultWorkspaceId`
- 失败：回滚到原 workspace，并用 Notifications 提示错误

### 与 session 的关系
- 创建 session：客户端仍显式携带 `workspaceId = selectedWorkspaceId`
- 服务端增强（兜底，推荐）：`createAgentSession` 若未传 workspaceId，则读取 `agent.defaultWorkspaceId` 填入

## 服务端安全

- Settings API 必须验证登录态（cookie token）
- 所有 settings 读写严格按 `userId` 过滤
- 读取接口仅允许读取 `keys` 参数中指定的 key（避免全量泄露不必要的配置）

## 测试策略

- bun 单测：
  - set/get 同一 key 的行为（含清空）
  - 不同 user 之间相同 key 不可互读
- 端到端手测：
  - A 浏览器设置默认 workspace -> 退出登录 -> 登录 -> 默认仍存在
  - 换一个浏览器登录 -> 默认仍存在

