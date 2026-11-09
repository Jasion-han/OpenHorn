# 评论分析工作台 Implementation Plan

> **For agentic workers:** 本会话按用户“规划后开始执行”授权原生执行。brainstorming 要求的独立 builder check 与最终独立代码审阅使用审阅代理；不自动提交/推送，不依赖当前未安装的 superpowers 执行技能。

**Goal:** 交付可保存、追溯、人工修正和导出的评论分析闭环。

**Architecture:** 原生工作台新增评论分析页；shared 纯函数定义 CSV/标注/输出验证契约；服务端一张有界 JSON 文档表通过事务/CAS 修改；AI 复用绑定会话的普通聊天，不添加执行引擎或扩大 GenUI 沙箱。

**Tech Stack:** 已有 React/Radix/Zustand、Hono/Drizzle/LibSQL、Bun tests、Vite/Playwright 测试装置；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-09-review-workspace-design.md`

## Global Constraints

- 保留当前所有既有未提交改动；不提交/部署；只运行隔离数据验证。
- UI 中文及提示词说明走 `apps/desktop/src/lib/i18n/agent.ts`；共享 DTO 位于 `packages/shared/src/types`。
- CSV 2 MiB / 1000条 / 50列 / 单格20000字符 / 正文8000字符 / 评分200字符；JSON文档12 MiB；每项目50批。
- AI 每批20条 / JSON输入总24000字符（含评分与转义）；完整 batch 严格校验后原子导入；人工/新标注 revision 变化不被旧批次覆盖。
- SQL CAS保护全部文档写入；准备批次requestId幂等；会话交接autoSend:false。
- Drizzle/bootstrap 同步；全量备份含数据，恢复重绑来源并幂等。

## Review Focus

- 不规则 CSV/公式型原文：拒绝坏结构，保留证据，CSV导出不能执行公式。
- 同步遇到模型失败/半段JSON/假证据：整批不写且可修正后重试。
- 准备后人工修改或其他批次先完成：旧批次跳过变化评论，保留原新值。
- 切页/切账号/切后端时迟到响应：不能导航、覆盖或显示旧身份数据。
- 来源删除和备份恢复：保存结果独立，来源引用只重绑当前用户资源。

### Task 1: 共享领域模型与纯函数

**Files:** create `packages/shared/src/types/reviews.ts`, `packages/shared/src/reviews.ts`, `packages/shared/src/reviews.test.ts`; modify `packages/shared/src/types/index.ts`, `packages/shared/package.json`.

**Interfaces:** `parseReviewCsv(csv, delimiter)`, `createReviewData(input)`, `validateReviewData(value)`, `parseReviewResults(text, run)`, `applyReviewResults(data, runId, result, sourceMessageId)`, `reviewCsv(data)`, `reviewReport(title,data)`, `buildReviewPrompt(run,instructions)`；DTO includes ReviewWorkspace/Summary/Data/Record/Annotation/Run/PreparedReviewRun.

- [x] 写 CSV/limits/严格结果/旧结果不覆盖/导出回归，运行确认 RED。
- [x] 实现有界状态机CSV解析、数据schema验证和确定性输出；原文不执行。
- [x] 运行 `bun test packages/shared/src/reviews.test.ts`，全部通过。

### Task 2: 持久化/API/隔离测试

**Files:** modify `packages/db/src/schema/index.ts`, `apps/server/src/db/bootstrap.ts`, `apps/server/src/index.ts`; create `apps/server/src/services/reviewWorkspaceService.ts`, `apps/server/src/routes/reviewWorkspaces.ts`, `apps/server/src/routes/reviewWorkspaces.fixture.ts`, `apps/server/src/routes/reviewWorkspaces.test.ts`.

**Interfaces:** GET/POST `/review-workspaces`; GET/DELETE `/:id`; PATCH `/:id/rows/:rowId`；POST `/:id/runs`；POST `/:id/runs/:runId/import`。所有写入携带expectedRevision；errorCode统一 review_*；结果只从绑定会话已保存助手正文读取。

- [x] 子进程独占临时数据库 HTTP/服务测试先失败：创建/读回、权限、CAS、幂等准备、模型引用、坏输出、人工保护、来源删除、删除工作台。
- [x] 新增双schema，领域服务和路由；事务内校验+CAS+写入。
- [x] 运行 server 测试（cwd apps/server，独占 `OPENHORN_TEST_DATABASE_URL`/`DATABASE_URL`/`OPENHORN_HOME`），要求0失败。

### Task 3: 备份恢复

**Files:** modify `apps/server/src/services/exportService.ts`, `apps/server/src/services/importService.ts`；测试扩展 review fixture 或独立fixture。

**Interfaces:** `review-workspaces.json` entry；`manifest.contents.reviewWorkspaces?`。复用identities与reference，validateReviewData验证导入文档，批次conversationId/sourceMessageId经用户范围映射。

- [x] 测试原始CSV/标注/批次完整恢复、新用户ID冲突和重复导入。
- [x] 快照加入表；恢复严格校验并重绑来源；旧备份无entry仍兼容。
- [x] 运行相关 export/import 与新增备份测试。

### Task 4: 原生工作台界面与会话交接

**Files:** create `apps/desktop/src/components/workbench/reviews/ReviewWorkspacePanel.tsx`, `ReviewImportDialog.tsx`, `ReviewAnnotationDialog.tsx`, `ReviewDataset.tsx`, `ReviewRuns.tsx`, `apps/desktop/src/lib/reviewWorkspaceApi.ts`; modify `WorkbenchView.tsx`, `workbenchStore.ts`, `lib/i18n/agent.ts`.

**Interfaces:** API DTO全部复用shared；交接到已有chatStore.selectConversation与pendingPrompt；失去身份/页签/项目所有权立即停止迟到handoff。会话运行与取消沿用现有组件。

- [x] 声明Extension设计，复用现有token与控件，新增“评论分析”页签。
- [x] 导入真实预览、保存、错误重试、分页/筛选/选择、统计、人工修改、历史记录、导出/删除。
- [x] 所有待保存表单有显式提交、失败保留、放弃确认；请求期间禁用冲突操作。
- [x] tsc检查；无组件内中文，无直接模型调用或GenUI权限变更。

### Task 5: 集成验证、审阅与知识记录

**Files:** create `apps/desktop/tests/reviews.html`, `reviews.tsx`, `apps/desktop/scripts/reviews.browser.mjs`；必要时新增纯交接helper回归；更新本计划checkbox与验证记录。

- [x] 真实React组件+隔离API装置跑CSV导入→分析准备→模拟已保存结果→同步→人工修正→导出→重载；覆盖坏结果/冲突/迟到导航，截取深浅/窄屏。
- [x] 运行 shared/新增 server 回归，desktop `tsc --noEmit`，server `tsc --noEmit`，作用域Biome；运行已有workbench浏览器回归。
- [x] 独立审阅实际增量，修复重要发现；不为无关既有改动改写文件。
- [x] 将经过验证的约束写入 `.trellis/spec/desktop/frontend/workbench.md`，记journal；完成通知仅在实际耗时超过10分钟且尚未交付时发送。
- [x] 最终说明完成范围、验证证据、未使用真实模型的限制和使用入口。

## 完成记录

2026-11-09：按本计划实施并通过独立审阅修复。验证详情见 `docs/2026-11-09_review-workspace-results.md`。使用真实Hono/SQLite与合成模型回包验证闭环，未调用真实付费模型、未部署或提交。
