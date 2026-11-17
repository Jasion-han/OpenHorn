# 可靠性修复与工作台实施结果

后续原生验收更新：用户授权重启后已在真实桌面端完成配方运行、收藏、三版本切换、原生导出与交互按钮演示，并补修默认渠道执行漏项。最新 Server 全套为461项通过。详见[原生演示记录](2026-11-06_native-workbench-demo.md)；下文保留此前隔离验证阶段的范围和计数。

2026-11-06，按用户授权先完成六项优先修复，再实现首批适合 OpenHorn 的新玩法。保留原有工作区改动；本次没有 Git 提交、推送或外部部署。

## 已修复的六项问题

| 问题 | 最终行为与证据 |
|---|---|
| 备份导出失败 | 使用 archiver 8 的 ZIP API，完整等待归档及输出流；附件元数据和可用原件入包，缺失原件明确列出。真实 ZIP 往返、原始字节、源文件消失和输出失败均有回归 |
| 备份凭据过滤不完整 | 渠道端点与 MCP 配置按白名单处理，敏感设置不出包，连接器恢复后禁用并提示重新配置。正文和产物内容作为用户数据完整保存，不承诺识别用户在正文自行粘贴的秘密 |
| 定时任务被其他客户端误判中断 | owner + 两分钟租约 + 心跳 + 条件终态更新；只回收过期 run，迟到或非 owner 写入不生效。独立 pending 队列避开最近 50 条历史限制 |
| “立即执行”提前标完成 | 进入与定时执行相同的 pending→claim→execute→save→complete 管线；生成失败、租约失效或保存失败均不伪报 completed |
| 恢复探测同时放行 | half-open 只预留一个探测，失联探测有时限；实际 fallback 渠道的 sidecar 完成结果正确结算，全部渠道故障时不会绕回 primary 旁路 |
| 保存失败重启后丢失 | IndexedDB 保存 final payload 和干净快照，按 backend/user 隔离；重连/重启仅重试保存。持久回执、同消息高序号记录及 `saveToken` 基线校验阻止重复写入、删除后复活与跨会话迟到覆盖。冲突保留本地副本，提供复制和明确放弃操作 |

补充修复包括：账号切换只清旧用户队列；删除/重置等待磁盘作废并使迟到恢复读取失效；未知旧消息 baseline 在模型启动前获取；同一次备份的父资源和版本历史来自一个 SQL 快照，避免并发追加使 ZIP 无法恢复。

初始审计与修复后结果分别保留在 [results.ndjson](audits/2026-11-06/results.ndjson) 和 [after.ndjson](audits/2026-11-06/after.ndjson)。[复现脚本](audits/2026-11-06/reproduce.ts) 已适配新的 owner 接口：当前结果为导出成功、非 owner 完成被拒、终态不能覆盖、探测结果 `[true,false,false]`。

## 任务配方

入口：桌面侧栏 **工作台 → 任务配方**；用户消息下也可选择“保存为任务配方”。

- 内置竞品周报、CSV 分析和项目代码审查三个模板；后两者使用项目内文件，而不是展示当前无法上传 CSV 的入口。
- 配方支持参数、默认值、项目、渠道/模型、Skills/MCP 要求、输出格式和不可变版本。参数一次性字面替换，不执行表达式。
- 立即运行交接绑定到新会话；预检后还会在实际 Agent 启动前复查最新工具清单。离开页面、切页签或迟到请求不会把任务发进别的会话。
- 定时任务冻结所选版本、参数、prompt、项目和显式模型。执行前核对实际会话与冻结设置，不能把项目 A 的配方放到项目 B 执行。
- 历史导入的提示词模板仍使用原格式；配方没有覆盖它们。

首版定时输出限 Markdown，并继续依赖在线的本地 desktop/sidecar。配置检查不等于远程连接已经验证；不支持自动重放可能已有副作用的工具。

## 产物工作台

入口：已保存助手回复下的 **收藏为产物**，以及 **工作台 → 产物**。

- 收藏完整原文作为独立副本，删除源消息/会话后仍保留。
- 查看历史版本、预览、查看/导出原文、编辑为新版本、重命名、删除或进入新会话继续修改。
- 新版本使用 `expectedVersion`；并发冲突保留编辑草稿和格式，刷新基线后由用户明确再次保存。
- HTML/OpenUI 继续使用原 GenUI 沙箱，按独立产物版本保存交互状态，没有引入可信原生 WebView 执行通道。
- 新配方、产物及全部版本历史已接备份/恢复；跨用户导入、稳定 ID 映射、项目/渠道重绑定、缺失来源和重复导入均有验证。

首版范围是文本和交互页面。尚未实现任意二进制生成文件的自动复制保存，也没有加入 n8n、飞书通道或云端常驻执行器。

## 验证结果

| 检查 | 结果 |
|---|---|
| Server 全量 Bun 测试 | 459 通过，0 失败 |
| Desktop 全量 Bun 测试 | 638 通过，0 失败 |
| Sidecar 全量 Bun 测试 | 331 通过，0 失败 |
| Shared 全量 Bun 测试 | 53 通过，0 失败 |
| 全仓类型检查 | 5 个配置了 typecheck 的任务成功，2 个缓存命中 |
| 全仓 `pnpm check` | 通过 |
| 工作台真实浏览器操作 | 10 项通过，包含实际表单、目标交接、缺工具拒跑、409→刷新保草稿→新版本、原文字节导出、沙箱按钮和窄窗/深浅主题 |
| 真实 IndexedDB | 9 项通过，覆盖重启、作用域、旧回执删除保护、事务提交、12 类坏输入、损坏记录、容量限制和存储不可用 |
| 既有实际聊天失败/重试浏览器脚本 | 56 个 PASS 场景，完整脚本成功 |
| 桌面 UI 生产构建及 Tauri macOS debug app | 成功 |

四个 Bun 测试包合计 **1,481 项**。所有服务测试均使用独立临时数据库，浏览器使用合成业务 API/IPC 和 fake sidecar，没有调用真实模型或写入真实会话。

浏览器证据：[结果](audits/2026-11-06/workbench/results.json)、[浅色桌面截图](audits/2026-11-06/workbench/light.png)、[深色窄窗截图](audits/2026-11-06/workbench/dark-narrow.png)、[IndexedDB 结果](audits/2026-11-06/outbox-browser.json)。截图是隔离 fixture，不是原生窗口实点验收。

构建产物：`apps/desktop/src-tauri/target/debug/bundle/macos/OpenHorn.app`。本次未重启用户当前应用实例，也不宣称已完成原生窗口点击验收。构建保留 Vite 的大 chunk 提示，不影响构建通过。

## 复跑入口

```sh
pnpm --filter server exec bun test
pnpm --filter desktop exec bun test
pnpm --filter sidecar exec bun test
pnpm --filter shared exec bun test
pnpm typecheck
pnpm check
node apps/desktop/scripts/workbench.browser.mjs
node apps/desktop/scripts/sidecar-outbox.browser.mjs
node apps/desktop/scripts/genui-chat-failure.browser.mjs
pnpm --filter desktop exec tauri build --debug --bundles app
```

并行运行多个 Server 测试进程时，分别设置独立的 `OPENHORN_TEST_DATABASE_URL=file:/tmp/...`，避免使用默认测试文件互相覆盖。
