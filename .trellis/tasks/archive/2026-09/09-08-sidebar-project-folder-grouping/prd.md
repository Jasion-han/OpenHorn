# 侧栏按项目文件夹分组管理会话

## 背景

用户给出参考截图（PI-Desktop）：左侧栏分「会话」与「项目」两段。「项目」下是本地代码目录
（PI-Desktop、TitleExamSystem、pi-backend…），每个项目可折叠/展开、可星标，项目下挂该项目
的会话，会话前有运行状态点，超长列表有「加载更多」。

OpenHorn 现状（2026-09-08 核对代码）：
- 仓库无任何「项目」实体。`conversations.workspace_id` 只在服务端 agent 路径透传，桌面端不读不写。
- agent 工作目录是全局单值 `sidecarStore.workspaceRoot`（localStorage），默认 `~/OpenHorn Workspace`；
  `pickAndSetWorkspace`（Tauri 文件夹对话框 `pick_workspace_dir`）已实现但**无 UI 调用**。
- sidecar `workspace.setCurrent` 接受任意目录（deny-list 校验），每次 run 前桌面端 `ensureWorkspace()` 重推。
- 侧栏已有：置顶折叠段、定时任务分组折叠段（带状态点）、按日期分组的会话列表。

## 目标

「项目」= 本地文件夹。用户把文件夹加入侧栏后：
1. 在该项目下新建的会话，agent 回合的 cwd 即该文件夹（sidecar workspaceRoot 按会话切换）。
2. 侧栏按项目分组展示会话；项目可折叠、星标、重命名、移除；会话可在项目间移动 / 移出项目。
3. 无项目的会话仍在上方「会话」段按原有置顶/日期分组展示。

## 范围

### 数据层（drizzle schema + bootstrap DDL 同步）
- 新表 `projects`：`id, user_id, name, root_path, is_starred, created_at, updated_at`，索引 `user_id`，唯一 `(user_id, root_path)`。
- `conversations.project_id TEXT`（可空）+ ALTER 迁移 + 索引。移除项目时连同其下全部会话（及消息）一起删除，确认弹窗明确警示，整个项目（全部会话行 + 项目行）在一个事务里提交。

### 服务端
- `services/projectService.ts`：list / create / update(name, isStarred) / delete（级联删除关联会话，复用 `deleteConversation`）。
- `routes/projects.ts`：`GET/POST /projects`，`PUT/DELETE /projects/:id`。注册到 app。
- `conversationService`：Create/Update 接受 `projectId`；空会话复用按 `projectId` 同值匹配（A 项目的空会话不得被 B 项目 / 无项目新建复用）。

### 共享类型
- `packages/shared/src/types`：`Project` DTO；`Conversation.projectId`。

### 桌面端
- `lib/serverApi.ts` + `types/chat.ts`：projects API、`Conversation.projectId`、Create/Update 输入。
- `stores/projectStore.ts`：`projects`、`activeProjectId`（新会话的作用域）、折叠状态（localStorage）、
  load / addFromPicker（复用 `pick_workspace_dir`）/ rename / toggleStar / remove。
- `chatStore`：`createConversation` 透传 `projectId`；`updateConversation` 白名单加 `projectId`；
  `selectConversation` 后作用域跟随会话的 `projectId`。
- `sidecarStore.ensureWorkspace(rootOverride?)`：传入项目目录时推给 sidecar 但**不覆盖** localStorage 里的默认工作区。
- `useSidecarAgentRun` / `backgroundTaskRunner` / 欢迎页 preconnect：按当前会话的项目目录调用 `ensureWorkspace`。
- 侧栏：
  - 「会话」段（无 projectId 的会话）：置顶 + 日期分组，逻辑不变。
  - 新增「项目」段：标题 + 「添加文件夹」按钮；每个项目行 = 折叠箭头 + 星标 + 名称 + 右键菜单
    （在此项目新建会话 / 星标切换 / 重命名 / 移除）；点击名称 = 选中为作用域并打开欢迎页；
    星标项目排前，其余按名称。
  - 项目下会话按 `updatedAt` 倒序，默认显示 10 条，「加载更多（剩 N 条）」每次 +20（列表已全量在内存，纯客户端）。
  - 会话行菜单新增「移到项目 ▸」子菜单（列出全部项目 + 「移出项目」）。
  - 会话行：当前会话正在流式（`isStreaming`）时显示蓝色脉冲点。
- 欢迎页：作用域为项目时显示「项目：<name>」chip，带 × 退出作用域；⌘N / 「新会话」按当前作用域建会话。
- i18n：全部新文案进 `lib/i18n/agent.ts`。

## 不做
- 项目内文件树 / 文件浏览。
- 服务端分页（列表本就全量）。
- 自动把历史会话按 `workspace_id` 归入项目（该列无路径语义，无法映射）。
- 「在 Finder 中打开」（无现成 Tauri 命令）。

## 验收
- 服务端：`bun test` 绿；新增 projectService / conversation projectId 复用测试。
- 桌面端：`bun test` 绿；分组辅助函数测试；`pnpm typecheck` + `pnpm check` 绿。
- 真机：添加文件夹 → 项目出现在侧栏 → 在项目下新建会话发一条 agent 消息 → sidecar 日志 / 工具调用
  显示 cwd 为该文件夹；移出项目后会话回到「会话」段；移除项目时其下会话随之删除，无项目的会话不受影响。截图验证。
