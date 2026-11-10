# Workbench flow implementation plan

**Goal:** 完成用户批准的五项工作台衔接与清晰度优化。
**Architecture:** 复用现有 API、Dialog、Zustand 和工作台三页布局；当前会话顺序实施与验证，不自动提交。
**Tech stack:** React 19、TypeScript、Zustand、Bun、Playwright。
**Spec:** `docs/superpowers/specs/2026-11-10-workbench-flow-design.md`

## Constraints and review focus

中文用户文案只放 i18n；续改仍由用户发送和确认保存；参数/续改绑定按后端和账号隔离、登出清理；历史只读，不能更改定时任务冻结版本；保留现有异步响应和 CAS 守卫。

- [x] 成果续改：新增 `workbenchSessionStore.ts`，保存 conversation→artifact/version；MessageActionBar 传会话 ID；ArtifactSaveDialog 预选匹配目标、提示失败并允许另存；单测隔离/错会话与浏览器保存验证。
- [x] 评论分析：ReviewDataset 将聊天模型和按钮放同一分析区域，Jev 提供独立说明；ReviewWorkspacePanel 空态收敛、导出和更多操作分开；浏览器验证模型选择不影响 Jev，删除仍需确认。
- [x] 配方状态/历史：RecipePanel 按 ID/version 保存参数与选择；新建 RecipeHistoryDialog 消费 recipes.detail，只读浏览，失败重试；验证切换恢复和版本变更失效、迟到详情不串配方。
- [x] 命名/空态：i18n 统一成果文案，任务配方说明为可复用模板；同步浏览器期望；核对窄屏布局和空列表。
- [x] 验证交付：桌面 Bun 测试、全仓类型/格式、工作台/评论/Jev 浏览器回归和 UI 构建；记录结果与边界，再在桌面查看可见页面。
