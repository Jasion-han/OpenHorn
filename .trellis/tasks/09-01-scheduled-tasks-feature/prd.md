# 定时任务功能

## Goal

为 OpenHorn 桌面端添加定时任务系统，让用户可以设置周期性执行的 Agent prompt（如每日新闻摘要、每周工作周报），到时间自动触发 Agent 运行并保存结果。支持手动表单创建和聊天自然语言创建两种方式。

## Requirements

### 数据模型

- `scheduled_tasks` 表：id, userId, title, prompt, cronExpression (存储频率+时间), enabled (boolean), notifyOnComplete (boolean), channelId, modelId, createdAt, updatedAt, lastRunAt, nextRunAt
- `scheduled_task_runs` 表：id, taskId, userId, status (pending/running/completed/failed), result (text), startedAt, completedAt, error (text)

### 服务端 API（apps/server）

- `GET /scheduled-tasks` — 列表（当前用户）
- `POST /scheduled-tasks` — 创建
- `PUT /scheduled-tasks/:id` — 更新
- `DELETE /scheduled-tasks/:id` — 删除
- `PATCH /scheduled-tasks/:id/toggle` — 启用/禁用
- `GET /scheduled-tasks/:id/runs` — 执行记录
- 调度引擎：server 启动时加载所有 enabled 任务，用 setInterval 每分钟检查 nextRunAt，到期触发 Agent 运行

### 桌面端 UI（apps/desktop）

1. **新视图 "scheduled-tasks"**
   - 扩展 `DesktopActiveView` 为 `"chat" | "settings" | "scheduled-tasks"`
   - 侧栏"定时任务"按钮切换到该视图
   - 视图内含两个 tab：定时任务列表 / 执行记录

2. **定时任务列表 tab**
   - 空状态提示
   - 任务卡片显示：名称、prompt 摘要、频率、下次执行时间、启用开关
   - "从模板开始"区域：预置 4-6 个模板卡片（每日财经资讯、工作区整理、每日英语单词、每周工作周报等），点击快速创建

3. **执行记录 tab**
   - 按时间倒序列出所有执行记录
   - 每条显示：任务名、执行时间、状态（成功/失败）、结果摘要

4. **创建/编辑弹窗**
   - 字段：任务名(必填)、Prompt 指令(必填)、执行时间(频率下拉+时间选择器，必填)、完成时推送系统通知(checkbox)
   - 频率选项：每天、每周一~日
   - 保存后自动调度

5. **聊天创建**
   - 用户在对话中说"帮我创建一个定时任务"时，Agent 识别意图并调用 API 创建
   - MVP 阶段：服务端提供创建接口即可，聊天意图识别作为后续增强

### i18n

- 所有中文文案通过 `apps/desktop/src/lib/i18n/agent.ts` 的 `scheduledTaskLabels` 字典管理

## Acceptance Criteria

- [ ] 点击侧栏"定时任务"切换到专属视图
- [ ] 可通过表单弹窗创建定时任务（任务名+prompt+频率+时间）
- [ ] 任务列表正确显示已创建的任务
- [ ] 可启用/禁用任务
- [ ] 可删除任务
- [ ] 模板卡片可一键创建任务
- [ ] 执行记录 tab 显示历史运行结果
- [ ] 调度引擎到时间自动触发任务执行
- [ ] TypeScript 类型检查通过
- [ ] Biome lint 通过

## Definition of Done

- 数据库 schema + bootstrap DDL 同步更新
- 服务端 CRUD API + 调度引擎
- 桌面端视图 + 弹窗 + 列表完整
- 类型检查 / lint 通过

## Out of Scope

- 聊天自然语言创建的意图识别（MVP 只提供 API，不做 Agent 工具绑定）
- 复杂 cron 表达式（只支持每天/每周X固定时间）
- 任务执行的实时流式显示（执行完看结果即可）
- 任务执行失败的自动重试
- 移动端/Web 端适配

## Technical Approach

### 数据层
- Drizzle schema 新增 `scheduledTasks` + `scheduledTaskRuns` 两张表
- Bootstrap DDL 同步新增 CREATE TABLE

### 服务层
- 新建 `scheduledTaskService.ts`，遵循现有 service 模式（纯函数导出，userId 作用域）
- 新建 `scheduledTasks.ts` 路由，挂载到 `/scheduled-tasks`
- 调度器：`scheduledTaskScheduler.ts`，server 启动时初始化，setInterval 每 60s 检查 nextRunAt <= now 的 enabled 任务

### 前端层
- 扩展 `DesktopActiveView` 类型
- 修改 `App.tsx` 视图路由（ternary → 条件渲染）
- 修改 `DesktopShellLayout.tsx` 支持新视图
- 新建 `ScheduledTasksView.tsx`（两 tab 布局）
- 新建 `CreateTaskDialog.tsx`（表单弹窗）
- 新建 `scheduledTaskStore.ts`（Zustand store）
- 修改侧栏按钮从 toast 改为 `setActiveView("scheduled-tasks")`

## Technical Notes

- 现有 15 张表，无定时任务相关表
- `DesktopActiveView` 当前只有 `"chat" | "settings"`
- App.tsx 用三元表达式切换视图，需改为 switch
- DesktopShellLayout 接受 activeView prop 控制样式
- 服务端路由模式：Hono router + requireUser 中间件
- 服务层模式：纯函数导出，Drizzle ORM 查询
- 两处 schema 定义必须同步：Drizzle schema + bootstrap DDL
