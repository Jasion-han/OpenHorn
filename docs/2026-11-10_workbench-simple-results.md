# 工作台简约交互结果

按用户“简约、易操作、少一些叠层”的要求完成界面调整，并重新构建、重启桌面端。当前原生窗口停在任务配方页。

| 原交互 | 本轮调整 |
|---|---|
| 更多菜单 → 编辑/历史弹窗 | 编辑和历史按钮直接显示；历史替换当前详情中的运行表单，收起后恢复参数，全程没有历史遮罩弹窗 |
| 编辑/导入窗口 → 再弹放弃确认 | 原窗口内提示继续编辑或放弃；配方、评论导入、评论修正及关联定时任务表单最多保留一个 dialog，成果原文编辑确认无需 dialog |
| 成果更多菜单 → 导出 | 导出原文与预览/原文切换并列，可直接操作 |
| 评论页两张分析卡 | 一条工具栏选择聊天/Jev，只显示适用模型、一个主按钮及对应说明；切换方式不请求模型 |
| 重复说明与统计卡片 | 精简工作台页头；评论数量平铺，内容列表占主要空间，窄屏自然换行 |

保留现有参数暂存、版本冲突保护、手动确认保存、失败重试和删除确认。Jev 仍独立于聊天模型，聊天方式仍由用户发送草稿并回来同步。没有新增后端接口、数据库字段、模型调用引擎或业务功能。

验证结果：

- **675 项桌面 Bun 测试通过，0 失败**。
- **56 个浏览器检查点通过**：工作台30、评论18、Jev8。新增/调整的断言包括：历史没有 dialog 或运行按钮；配方/评论/定时表单放弃确认仍只有一个 dialog；成果取消原文编辑没有 dialog；继续编辑保留草稿；分析方式切换不发送请求、Jev 模式隐藏聊天模型；直接导出保持原文字节。
- `pnpm typecheck`、`pnpm check` 通过，macOS debug app 构建通过。现有大分包构建提示仍存在，不作为本轮阻塞项。
- 原生实际查看直接编辑/历史入口、内联历史、运行表单恢复、单层取消提示和继续编辑。临时用途说明已恢复原值并取消，未保存真实配方修改、运行任务或分析真实评论。

[证据汇总](evidence/2026-11-10-workbench-simple/summary.json)及同目录合成截图/浏览器结果对应当前完整工作区。没有新增真实付费探针；应用正常启动仍遵循已有功能配置。验证不是仅含本轮改动的独立发布候选验收。完整日志在 `/tmp/openhorn-workbench-simple-*.log`；本轮未 Git 提交、推送或外部部署。

复查：

```bash
pnpm --filter desktop exec bun test
pnpm typecheck
pnpm check
node apps/desktop/scripts/workbench.browser.mjs
node apps/desktop/scripts/reviews.browser.mjs
node apps/desktop/scripts/jev-integration.browser.mjs
pnpm --filter desktop exec tauri build --debug --bundles app
```
