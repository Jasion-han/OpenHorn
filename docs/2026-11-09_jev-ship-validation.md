# Jev 精确提交验收

本次按用户 `$ship-flow` 授权，在同步后的 `70b613e` 上收尾剩余 Jev 集成。此前工作台、评论核对、决策客户端和预算基础已由另一会话提交；本次只纳入欢迎建议语义去重、Server 搜索/RAG 重排、路由影子对照、五项功能设置及相应验证材料。

工作区仍有连接管理、消息 outbox/CAS、性能优化及 Trellis 迁移等未提交内容。没有纳入这些改动，也没有推送保留分支 `preserve/pre-review-ship-bb35ca4`。`messageService.ts` 仅选取四处 `userId` 传递，欢迎服务仅选取语义过滤，README/Compose 仅选取 Jev 说明和变量。

## 独立验证

从上述基线创建独立工作树，只放入本次选定文件，再用 `pnpm install --offline --frozen-lockfile --ignore-scripts` 安装。已核对 Server 的 `shared` 链接指向该工作树自身，未借用原工作区源码；数据库位于任务自有临时目录。普通测试清理真实决策凭据，浏览器使用合成接口，没有新增付费请求。

| 检查 | 结果 |
|---|---|
| Server 全套 | 初次 465 通过；加入测试凭据清理后复跑 464 通过、1 项消息并发测试超时 |
| 并发文件对照 | 原始 `70b613e` 和候选版本均为 11 通过、2 项编辑/重试完成测试超时，均触发原 5000ms 上限 |
| Server Jev/检索/路由专项 | 56 通过，0 失败 |
| Desktop 全套与新增技能回归 | 全套 618 通过；随后新增的技能名单保留测试 1 通过 |
| Shared 全套 | 67 通过，0 失败 |
| 浏览器 | Jev 7 个、评论工作台 16 个检查点通过；无未预期页面错误 |
| 类型与格式 | `pnpm typecheck` 和 `pnpm check` 通过；Server/Desktop 类型检查实际执行，未改包复用缓存 |

消息并发测试存在基线超时，因此不宣称 Server 全套稳定全绿；本次没有扩大范围去修改该组业务逻辑或放宽测试时限。原始失败、基线对照及专项日志见[本次证据](evidence/2026-11-09-jev-ship/summary.json)。该目录的源码 SHA-256 对应独立候选；早期研究与集成目录中的哈希仍是当时快照。

可从仓库根目录复跑，不需要真实 Key：

```bash
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm check
OPENHORN_TEST_DATABASE_URL=file:/tmp/openhorn-jev-ship-check.db pnpm --filter server exec bun test
pnpm --filter desktop exec bun test
pnpm --filter shared exec bun test
node apps/desktop/scripts/jev-integration.browser.mjs
node apps/desktop/scripts/reviews.browser.mjs
```

## 证据对应关系与边界

- Jev 浏览器验证了开关写入失败保留原状态、关闭功能阻止操作、双击不重复请求、直接保存批次、备注核验缓存、预算失败保留人工内容、迟到结果不抢页面及影子差异不改变路由。
- RAG 回归验证判断使用回答实际可见的 800 字符片段，且来源在外部等待期间删除后不会进入上下文。技能回归保留完整已启用名单并优先排列配方必需项。
- [初始调研](2026-11-09_jev-opportunity-audit.md)和[首批实现报告](2026-11-09_jev-integration-results.md)是各自阶段的记录。原生运行、1670 项全工作区测试、125 个浏览器检查点和真实联通费用不能直接归属于这次精确提交。
- 本次未重新构建 Sidecar/原生应用、未重启用户服务、未部署容器，也未执行真实评论或定时任务。欢迎服务的其他冷却/工厂重构保留在工作区；本次只接入已有流程的语义过滤。
