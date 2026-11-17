# 定时任务会话不得出现在用户聊天列表

## 问题
定时任务每次执行建独立会话（forceNew），存于 conversations 表。侧栏靠
`recentRuns[].conversationId` 交叉过滤把这些会话从主聊天列表剔除，但 runs 列表
有窗口上限（50 条），会话越攒越多，一旦某会话对应的 run 掉出窗口就漏进「今天/更早」
的用户聊天列表（截图：5 条「每日调用Claude Code」）。

## 根因
客户端按 runs 交叉过滤不可靠，应在数据层标记会话来源。

## 方案
1. conversations 加列 `scheduled_task_id`（drizzle schema + bootstrap DDL + ALTER 迁移）。
2. createConversation 接受并写入 scheduledTaskId；findReusableBlankConversation 排除
   带 scheduledTaskId 的会话（聊天新建绝不复用定时任务空会话）。
3. 调度器与手动 /run 建会话时传 scheduledTaskId=task.id。
4. DTO（ApiConversation/Conversation/mapConversation）透传 scheduledTaskId。
5. 侧栏 filteredConversations 改按 `c.scheduledTaskId` 过滤（不再依赖 runs 窗口）；
   顶部任务组仍按 runs 分组渲染，点击 run 记录仍能在会话列表里找到并打开。
6. bootstrap 一次性回填：已被 scheduled_task_runs 引用的历史会话补写 scheduled_task_id。

## 不做
不改定时任务每次独立会话（forceNew）；不改执行链路。

## 验收
- 侧栏「今天/更早」不再出现定时任务会话；顶部任务组正常显示、点击可查看。
- 历史泄漏会话经回填后消失。
- typecheck + server/desktop 测试通过；浏览器视觉验证。
