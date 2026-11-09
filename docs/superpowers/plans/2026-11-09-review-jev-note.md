# Jev 说明核对 Implementation Plan

**Goal:** 用真实实测支持的窄判断补齐评论说明语义核对。
**Architecture:** 单条、显式、服务端TypeSafe Noul调用；原生详情展示辅助结果；现有JSON文档保存有版本绑定的检查记录。
**Tech Stack:** 已有Bun/Hono/React/TypeScript，原生fetch，无新依赖。
**Spec:** `docs/superpowers/specs/2026-11-09-review-jev-note-design.md`

## Global Constraints

- 总实验预算1美元，所有付费调用发送自编样例；凭据不进入代码/报告/浏览器。
- CSV/ID/CAS仍用确定性代码；不自动调用，不自动改标注，不作可靠性保证。
- 固定`jev-1.14.0`与HTTPS官方endpoint，10秒超时，无自动重试。
- 界面文案走`lib/i18n/agent.ts`；DTO在shared/types；旧文档与备份兼容。

## Review Focus

- API错误不是概率0；非法/不完整回答不得保存。
- 缓存/版本控制避免重复付费及旧结果覆盖新标注。
- 网络等待期间不持SQL事务；再次CAS后才能保存。
- 检查自己的ACK更新详情基线，外部更新不覆盖编辑草稿。
- 测试默认阻断外网；live模式只允许指定provider和自编样例。

### Task 1: 完成真实实验

- [x] 首轮32个案例、额外4个Choice对照：36次真实调用，保存完整数据。
- [x] 最小输入复测：同样32例，去掉情绪，只发送原文和说明，评估留出结果。
- [x] 逐例检查错误/不确定项，记录实际token和延迟，不按留出结果调阈值。

### Task 2: 协议与后端

Files: `apps/server/src/services/reviewNoteVerification.ts`、对应test；修改`shared/src/types/reviews.ts`、`shared/src/reviews.ts`、`reviewWorkspaceService.ts`、`routes/reviewWorkspaces.ts`、`.env.example`。

- [x] 先写红测：`buildReviewNoteRequest(text,note)`精确payload；`parseReviewNoteResponse(value)`拒绝错类型/概率/模型/usage；`noteSupportVerdict(probability)`边界。
- [x] 实现`evaluateReviewNote(text,note,{apiKey,fetchImpl})`，固定endpoint/超时/redirect，安全结构化错误，返回实际请求供查看。
- [x] 实现`verifyReviewNote(userId,id,rowId,value)`，归属/输入/缓存/HTTP/二次CAS/保存，响应`{workspace,verification,request}`。
- [x] 增量JSON校验、清失效记录；HTTP/备份隔离回归。

### Task 3: 界面与真实闭环

Files: `ReviewAnnotationDialog.tsx`、`ReviewWorkspacePanel.tsx`、`reviewWorkspaceApi.ts`、`i18n/agent.ts`、`reviews.browser.mjs`和隔离fixture。

- [x] 显式按钮与发送范围提示；草稿未保存/空说明禁用。
- [x] 显示概率/建议/不确定/失败，展开实际请求，ACK后更新当前表单baseline。
- [x] 默认provider装置覆盖结果/缓存/失效/错误/迟到，不调用外网。
- [x] live模式在真实生产API/DB路径核对合成好/坏说明并保存证据，费用计入同一预算。

### Task 4: 收尾

- [x] 独立审阅关键边界并修复。
- [x] 相关Bun测试、前后端类型检查、Biome、浏览器流程、UI构建。
- [x] 记录实测结果、限制、使用入口与配置；更新mini-trellis；不提交/部署。

## 完成记录

第二轮执行：

- [x] 20组边界实测，复现纯建议与混合建议误报，保留逐例结果。
- [x] 两Noul验证44组（20边界+16旧留出+8新确认），未调阈值。
- [x] v2增加hasClaimsProbability/not_applicable；保留v1读/备份兼容，RED→GREEN。
- [x] 两种transport校验两头；缓存按resolved model准确重建请求。
- [x] UI显示不适用并隐藏无意义支持概率；旧记录提示重查但不自动调用。
- [x] 受控浏览器和独立live三样例闭环，费用计入累计预算。
- [x] 独立审阅、相关回归、类型/格式/UI构建，保存证据与记忆，不提交/部署。

官方API共70次真实调用，估算0.001471596美元；最小输入留出16组（8错8对）均识别。相关Server195/Desktop89/shared7测试、受控浏览器13场景、live浏览器12场景、类型/格式/UI构建通过。独立审阅修复ABA错绑并收紧未知计费承诺。详见 `docs/2026-11-09_review-jev-note-results.md`。未提交或部署。

第二轮完成：v2新增事实存在性、旧记录兼容及正确缓存预览；新增67次真实调用，累计137次、估算0.003103884美元。44组评测、真实三样例闭环、41服务端/11共享测试、16受控与16 live浏览器场景及类型/格式/UI构建通过。详情见 `docs/2026-11-09_review-jev-v2-results.md`。
