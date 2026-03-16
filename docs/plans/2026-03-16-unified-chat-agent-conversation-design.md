# Unified Chat Agent Conversation Design

**Goal:** 将现有独立的 Chat 会话与 Agent 会话收敛为“统一会话 + 每轮执行模式”的产品与技术结构，让用户在同一聊天框内自由切换 `Chat` / `Agent` 能力。

## Problem

当前 Web 端把 Chat 与 Agent 建模成两套并列系统：

- 左侧分别维护 [`ChatAside`](/Users/han/Project/OpenHorn/apps/web/src/components/chat/ChatAside.tsx) 和 [`AgentSessionsAside`](/Users/han/Project/OpenHorn/apps/web/src/components/agent/AgentSessionsAside.tsx)
- 中部也分别维护 [`ChatArea`](/Users/han/Project/OpenHorn/apps/web/src/components/ChatArea.tsx) 与 [`apps/web/src/app/(app)/agent/page.tsx`](/Users/han/Project/OpenHorn/apps/web/src/app/(app)/agent/page.tsx)
- 前端状态分散在 [`chatStore.ts`](/Users/han/Project/OpenHorn/apps/web/src/stores/chatStore.ts) 与 [`agentStore.ts`](/Users/han/Project/OpenHorn/apps/web/src/stores/agentStore.ts)
- 服务端数据也分散在 `conversations/messages` 与 `agent_sessions/agent_events`

这和目标产品语义冲突：

- 用户希望左侧只有一个会话列表，而不是 Chat / Agent 两套入口
- 用户希望在同一个会话中，随时在输入框底部切换 `Chat` / `Agent`
- `Agent` 只是比 `Chat` 多一些 AI 能力，不应该被建模成另一类会话

## Product Rules

### Unified Conversation

- 左侧只显示一种对象：`Conversation`
- 会话列表混合展示历史 Chat 与 Agent 记录
- `Chat` 与 `Agent` 会话都支持置顶
- 点击左侧任意会话，中部立即显示该会话的统一时间线

### Composer Mode

- 输入框底部提供 `Chat / Agent` 模式选择器
- 该选择器表示“下一轮执行模式”，不是会话类型
- 默认值为 `Agent`
- 用户手动切换后保持该选择，切换会话时不自动覆盖
- 同一会话内允许连续出现 `Agent -> Chat -> Agent` 的轮次切换

### Agent Display

- `Agent` 轮次仍然显示在同一条消息时间线中
- 默认只显示最终回答
- 工具过程、日志、错误信息折叠在“Agent 执行记录”区域内
- 用户按需展开查看执行细节

## Constraints

- 不继续扩散“Chat 会话 / Agent 会话”双模型；新增写入路径必须收敛到统一会话
- 保留现有模型选择、附件、Workspace 上下文的能力
- 兼容已有历史数据，不能要求用户丢弃旧 Chat 或旧 Agent 记录
- 迁移过程中 UI 可以先统一，但数据写入不能长期维持双写分叉

## Proposed Model

### Conversation

在现有 `conversations` 主模型基础上扩展，而不是继续依赖 `agent_sessions`：

- `id`
- `title`
- `channelId`
- `modelId`
- `workspaceId`：统一会话默认工作区
- `defaultMode`：`chat | agent`，用于新会话默认执行模式，初始值为 `agent`
- `lastMode`：最近一轮执行模式，用于左侧列表标记
- `isPinned`
- `runStatus`：最近一轮运行状态，可用于展示运行中/失败
- `createdAt`
- `updatedAt`

### Message

`messages` 仍是统一时间线的主记录，但每条用户消息增加执行上下文：

- `mode: 'chat' | 'agent'`
- `attachments`
- `contextPaths`
- `workspaceId` 快照
- `channelId/modelId` 快照或等价执行配置

助手消息保持一条主回复，同时允许挂载一段 `agentRun` 元数据。

### AgentRun

Agent 专属过程不再作为独立“会话流”，而是作为某条助手回复的附属记录：

- `messageId`
- `status: running | completed | cancelled | failed | partial`
- `summary`
- `steps/tool logs`
- `error`
- `startedAt`
- `finishedAt`

这层可以新建结构化表，也可以先通过兼容映射把旧 `agent_events` 组织成该视图。

## Architecture

### Web

- 用一个统一页面替代 `/chat` 与 `/agent` 的产品分裂
- 左侧 [`LeftSidebar`](/Users/han/Project/OpenHorn/apps/web/src/components/app/LeftSidebar.tsx) 改为统一会话导航
- 中部合并为一个统一聊天时间线组件
- [`PromaComposer`](/Users/han/Project/OpenHorn/apps/web/src/components/composer/PromaComposer.tsx) 新增执行模式选择器
- 统一 store 管理当前会话、消息时间线、运行状态和用户手动选择的 composer mode

### Server

- 以 `conversations + messages` 作为统一读写入口
- `agent_sessions` / `agent_events` 仅作为迁移期兼容来源
- 新增统一运行入口：
  - `mode = chat` 时走现有聊天流式能力
  - `mode = agent` 时走现有 agent 运行能力
- 两种模式最终都写回同一条会话时间线

## Migration Strategy

### Phase 1: Unified Read Model

- 左侧会话列表先做统一查询与适配
- 把 `conversations` 与 `agent_sessions` 映射成统一列表项
- 保留历史置顶状态；为 Agent 增加置顶能力

### Phase 2: Unified Timeline

- 为旧 Chat 历史直接读取 `messages`
- 为旧 Agent 历史将 `agent_events` 映射成统一消息时间线视图
- 中部先做到“统一展示”，即使底层仍有兼容转换

### Phase 3: Unified Write Path

- 新建会话只创建统一 `conversation`
- `Chat` 和 `Agent` 新消息都写入统一 `messages`
- `Agent` 过程记录写入新的附属结构，不再创建新的 `agent_session`

### Phase 4: Data Cleanup

- 停止 UI 对 `agent_sessions` 的直接依赖
- 视迁移完成度决定是否清理旧表或长期保留为只读兼容层

## UX Details

### Left Sidebar

- 新建会话按钮创建统一会话
- 搜索覆盖所有会话
- 置顶区与普通区都可混合显示 Chat / Agent 历史
- 列表项显示：
  - 标题
  - 最近模式标记
  - 运行状态
  - 置顶状态

### Timeline

- 时间线维持“用户消息 / 助手消息”的阅读方式
- `Agent` 轮次的助手消息下方显示折叠式执行记录卡片
- 展开后查看工具步骤、日志与错误

### Composer

- 模式切换、Model、附件、上下文入口保留在同一底栏
- `Agent` 默认选中
- 用户手动切到 `Chat` 后持续保留，直到再次手动切换

## Risks

- 现有前后端都深度依赖双 store 和双路由，统一写入路径需要同时改 Web 与 Server
- 历史 `agent_events` 与 `messages` 的结构差异较大，映射时要避免顺序和语义错乱
- 中断、重试、编辑后重跑等能力目前分别挂在两套链路上，统一后需要重新定义行为

## Validation

- 新会话内可连续执行 `Agent -> Chat -> Agent`
- 左侧统一列表支持搜索、置顶、重命名、删除
- 点击任意历史会话都能恢复统一时间线
- Agent 执行记录默认折叠，展开后可见过程
- 手动切换 composer mode 后，切换会话不应覆盖该选择
- 旧 Chat / Agent 历史进入统一列表后标题、顺序、置顶状态不丢
