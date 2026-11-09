# 评论分析工作台：交付与验证

后续更新：同日已对 Jev 说明核对完成70次真实调用并接入，详见 [Jev 实测与使用说明](2026-11-09_review-jev-note-results.md)。下文保留首版生成模型使用合成回包的验收范围。

2026-11-09。依据用户“认真详细深度规划后再开始执行”的授权，先完成代码调查、设计与独立 builder check，再实施并独立审阅代码。具体实现选择由执行者作出，未新增通用插件运行时。

- [详细设计](superpowers/specs/2026-11-09-review-workspace-design.md)
- [实施计划](superpowers/plans/2026-11-09-review-workspace.md)
- [桌面浅色截图](evidence/2026-11-09-review-workspace/reviews-light.png)
- [窄屏深色截图](evidence/2026-11-09-review-workspace/reviews-dark-narrow.png)

## 使用

更新后的后端启动时会通过 bootstrap 幂等创建 `review_workspaces` 表。当前运行中的旧后端需要重新启动，客户端需要加载本轮 UI；本轮未操作用户的正常数据库或重启已有服务。

1. 打开 **工作台 → 评论分析 → 导入 CSV**。选择 UTF-8 CSV，调整分隔符，映射正文列及可选评分列，检查预览后保存项目。
2. 在评论列表搜索、筛选，选择下一批未标注评论，或手动勾选需要重新分析的评论。默认批次排除已有待导入分析覆盖的评论；未发送/取消的批次仍可通过打开会话继续，或重新勾选评论准备新批次。
3. 选择支持普通 Chat 的 API 渠道/模型，点击 **准备 AI 分析**。应用打开绑定该批次的新聊天草稿，检查后由用户发送；取消、重试和凭据处理使用现有聊天流程。
4. 回复完成并保存后，回到评论分析页，在分析记录点击 **同步分析结果**。整批必须满足评论 ID、批次 ID、字段与原文证据要求，否则不写入任何标注。
5. 点击评论原文查看完整内容、证据和来源，必要时保存人工修正。后来修改过的标注不会被旧批次覆盖；同步记录分别显示应用与跳过数量。
6. 导出菜单提供全部标注 CSV、原始 CSV 和 Markdown 证据报告，也可删除评论项目。全量 OpenHorn 备份包含评论资料，恢复时重绑来源引用。

资料保存在当前连接的后端；远端后端不等于仅在本机存储。

## 实现边界

- 有界 JSON 文档表独立保存源 CSV、稳定评论记录、标注和分析批次。每次修改用 SQL CAS，准备批次的 requestId 幂等；会话与批次在同一事务创建。
- CSV 最大 2 MiB、1000 条有效评论、50 列；单格最多 20000 字符，正文最多 8000 字符，映射评分最多 200 字符。支持 BOM、引号内换行/分隔符、双引号转义、重复/空表头和重复评论；不静默截断数据。
- 每批最多 20 条，实际 JSON 输入（包括评分、ID 和转义）最多 24000 字符；每项目最多 50 批；整个 JSON 文档最多 12 MiB，插入前必须验证总量。空正文跳过并计数，源 CSV 完整保留。
- AI 结果严格绑定批次，情绪枚举受限，主题最多 5 项、单项 50 字符，证据最多 160 字符且必须是原文连续片段，说明最多 400 字符。
- 专用 JSON systemPrompt 不受 GenUI 追加影响；这类会话跳过跨会话记忆、RAG、天气/联网/工作区上下文路由，避免对评论内容执行扩展。
- 搜索/筛选/分页/统计/导出在本地计算；Markdown 报告是已保存数据的可复核汇总，不冒充新生成的业务洞察。标注 CSV 防电子表格公式执行；原始 CSV 导出保留源文。
- 来源删除不删除已导入标注；无法打开来源时给出错误。刷新会重载列表并修复失效选择；列表刷新与保存重叠时不会永久显示加载状态。
- 没有新增抓取器、插件市场、任意插件执行或 GenUI 特权接口。现有配方/产物功能保留。

## 验证

| 验证 | 结果 |
|---|---|
| 共享 CSV/完整文档/结果校验/人工保护/导出/批次预算 | 6 tests，0 fail |
| 服务端 Chat、上下文、配方、产物、备份和评论 API 相关回归 | 189 tests / 24 files / 882 assertions，0 fail |
| 桌面端 GenUI、产物草稿、工作台 store 回归 | 89 tests / 7 files / 495 assertions，0 fail |
| 评论浏览器完整流程（真实组件 + 实际 Hono/SQLite） | 10 条场景通过 |
| 既有工作台浏览器回归 | 全部通过，覆盖配方、定时交接、产物和真实 composer 交接 |
| desktop / server `tsc --noEmit` | 均通过 |
| 本轮 33 个代码文件的 Biome | 通过 |
| `pnpm --filter desktop run build:ui` | 通过 |

测试命令及装置：

```bash
bun test packages/shared/src/reviews.test.ts
# cwd apps/server; 使用独占 DATABASE_URL、OPENHORN_TEST_DATABASE_URL 和 OPENHORN_HOME
bun test src/services/messageService.*.test.ts src/routes/reviewWorkspaces.test.ts src/services/appendSystemPrompt.test.ts src/services/liveCapabilities.test.ts src/services/liveCapabilities.orchestrator.test.ts src/services/exportService.test.ts src/services/recipeService.test.ts src/services/artifactService.test.ts
# cwd apps/desktop
bun test src/lib/genui src/stores/workbenchStore.test.ts src/stores/artifactDraftStore.test.ts
node scripts/reviews.browser.mjs
node scripts/workbench.browser.mjs
```

新增 HTTP 和浏览器服务装置自己创建临时 SQLite/状态目录，阻断外部 fetch，并在退出时关闭服务、释放测试资源。浏览器只允许本地 Vite 和独占测试 API。合成模型回复由仅存在于测试服务的 `/__fixture/complete` 写入，生产入口不注册这些路由。

浏览器场景覆盖：UTF-8 拒绝与 CSV 预览、真实数据库保存、普通 Chat 草稿且不触发模型、拒绝未完成/错误批次输出、人工标注保护、三种完整导出、重载恢复与冲突留稿、刷新/保存竞态、深浅主题与窄屏、来源删除、迟到准备响应、远端删除后的列表恢复。场景分组计数为 10；详细结果见随附 `browser-results.json`。

## 审阅修复

独立审阅发现的缺口均已修复并加入回归：ACP 普通聊天不兼容、JSON 与 GenUI 提示冲突、跨会话记忆/RAG/实时路由污染、长评分绕过预算、超限文档插入后列表不可读、已删除来源静默清空聊天选择、远端删除后的刷新失效、刷新被保存废弃后加载状态无法结束。

## 验证范围限制

没有调用真实付费模型，因此没有把格式验证和合成结果测试描述为真实标注准确率验证。没有执行 Tauri 原生打包、安装、部署或 Git 提交/推送。生产 UI 构建仍输出既有依赖/分块类提示，但构建退出成功；未为本功能改动无关依赖或资产。
