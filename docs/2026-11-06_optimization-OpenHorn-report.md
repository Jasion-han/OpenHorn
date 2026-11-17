# OpenHorn 优化与产品机会调研

实施更新：下列六项优先可靠性问题已修复，并完成任务配方与文本/交互页面产物工作台。实际范围、验证与首版限制见[实施结果](2026-11-06_reliability-workbench-results.md)。本文后续内容保留为初始调研，不代表所有建议均已实施。

调研日期：2026-11-06。范围为当前工作区代码、项目约定和历史记录，以及公开工具的官方资料。工作区已有大量未提交改动，本文以当前文件为准，不把历史任务状态当成现状。

建议主线：先让任务、保存和备份可信，再把已有 Agent、Skills、MCP 和生成式 UI 组合成可复用的任务与产物工作台。

本文是调研建议，功能方向和工作量均未获得产品决策确认；未修改业务实现、未提交或部署。没有做完整原生桌面验收或全量测试，不能据此判断所有路径的质量。

## 已有能力与历史约束

当前已有多模型聊天、Claude/Codex/Direct/ACP 等运行路径、MCP 导入和侧车连接测试、Skills 渐进加载、会话搜索、上下文预算、摘要记忆、文档向量检索、Checkpoint、定时任务和生成式 UI。GenUI 已有本地交互状态持久化；附件、网页和本地路径已接右侧预览。它们均不应被重新包装成“从零添加”的功能。

历史上曾在 Agent 质量优化中加入并回滚意图路由和 trace，简化连接池、熔断器、摘要、预算和 RAG。见 [.trellis/workspace/han/journal-1.md，Session 4](../.trellis/workspace/han/journal-1.md)。可观测性建议应从实际排障需要出发，先做运行摘要，避免直接重建全套 trace 平台。

## 优先修复的具体问题

优先级：P0 表示涉及数据保全、应最先处理；P1 表示核心行为正确性；P2 表示体验与维护改进。成本为熟悉项目的单人开发粗估，含定向验证，不是排期承诺。

| 优先级 | 发现与证据 | 影响与建议路径 | 验收与粗估 |
|---|---|---|---|
| P0 | 备份导出实际失败。`exportService.ts:15` 使用旧式 `require("archiver")` 工厂；当前安装 archiver 8.0.0 仅提供命名类导出。隔离内存库调用 `exportBackup` 报 `archiver is not a function` | 按当前依赖接口生成 ZIP，检查归档与输出流错误处理；备份恢复作为一条完整功能验证 | 新库/旧库导出→导入→会话与附件哈希一致；损坏/缺失附件有明确结果。约 1–2 天 |
| P0 | 备份脱敏不完整。`exportService.ts:63–108` 仅对 channels 执行 `stripApiKey`，MCP 行和 settings 行原样进入 ZIP；`mcp-tools.ts:76,91` 确实支持 headers/env 中的凭据。这是静态确认的导出路径，当前 ZIP 运行错误会先阻断导出 | 修复 ZIP 时一并处理：普通备份使用字段白名单与凭据引用，敏感迁移需独立设计。还应检查 URL/args 中的秘密；不要只按 `apiKey` 一个字段删除 | 用合成 env/header/query/args/settings 秘密检查包内容；恢复后明确标识需要重新授权。约 1–2 天；未读取真实凭据 |
| P1 | 定时任务缺少执行租约。`backgroundTaskRunner.ts:128` 将当前页面未处理的全部 running 记录判为中断；`scheduledTaskService.ts:233` 完成写入只校验 user/run，不校验执行者或旧状态 | 同账号第二客户端启动可能把第一客户端的任务写为 failed；原执行者还可把终态写回 completed。增加 owner/lease/heartbeat，过期后再回收；终态更新需条件约束 | 两客户端同时在线、刷新、崩溃、租约过期和迟到完成均有明确结果。服务层越权终态覆盖已隔离复现；尚未做双原生客户端验收。约 2–4 天 |
| P1 | “立即执行”提前记为完成。`routes/scheduledTasks.ts` 的 `POST /:id/run` 创建 run 后立即 `completeTaskRun(completed)`；`ScheduledTasksView.tsx:244` 随后切聊天并填入 pendingPrompt | 任务记录的完成时间先于实际模型执行，失败时也不能忠实反映该 run。手动和定时执行应复用 pending→claim→执行→持久化→终态链路 | 点击后不能提前 completed；停止、失败和保存失败应回写同一 run。静态调用链确认，未做 UI 复现。约 1–2 天，可并入租约改造 |
| P1 | 熔断恢复探测未限制单次请求。`circuitBreaker.ts:49` 第一次切 half_open 后，后续调用仍直接 true。隔离复现得到 `[true,true,true]` | 故障渠道恢复时可能同时承接多次探测；增加原子探测占用与失败/超时释放。单渠道无备选时是否允许继续请求应单独定义 | 冷却后并发调用只取得一个探测许可；探测未回报与失败均能恢复。约 0.5–1 天 |
| P1 | 本地 Agent 保存重试仅在内存。`sidecarPersistence.ts:10` 明确 session memory only，待保存 payload 位于 Map；chatStore 的未保存保护也不是持久磁盘队列 | 服务端不可用时可以重试，但退出/崩溃后缺少待保存恢复保证。增加本地 durable outbox，并保留已有消息身份和 revision 去重逻辑 | 生成完成→服务器离线→退出重启→恢复网络，仅保存一次；编辑、删除和退出账号不能复活旧回合。约 2–4 天 |

## 体验与架构上的改进

1. **附件接入统一能力矩阵。** 现有预览能力远大于上传白名单，不能把“可预览”当成“可上传、可让模型理解”。现有 [34 格式实测记录](../.trellis/research/attachment-format-validation.md) 明确：68 组预览检查通过，但上传只有 11 个样例接收、23 个被拒绝。首批增加 CSV/JSON/代码文本，再做 DOCX/XLSX 内容提取；音视频转写与 OCR 单独判断能力、大小和费用。约 2–5 天起。
2. **知识检索可配置、可解释。** `embeddingService.ts` 固定模型与 1536 维；`attachmentService.ts:95` 从聊天渠道推断 embedding 凭据；没有兼容渠道时检索能力受限。提供独立 embedding 配置、连接测试、索引状态、模型/维度版本和重建入口，失败不能只是后台静默降级。约 3–6 天。
3. **项目记忆范围可选择。** `ragService.retrieveContext` 和 `getRecentSummaries` 按 userId 检索，未按 projectId/conversationId 限定；现有用户隔离检查存在，这不是已证明的跨用户泄漏。建议让用户选择当前会话/当前项目/个人全局，并能看到引用来源、排除文档及关闭记忆。默认范围需要产品决策。约 3–6 天，可与知识配置合并。
4. **知识检索质量有基准。** 当前向量搜索取 top 5，无显式相似度门槛或关键词融合；输出按 chunk 截取最多 800 字。先用项目文档与中文/代码/表格合成查询建小型检索集，评估正确来源、引用定位、无答案时的行为，再决定是否增加混合检索/reranker。不要先堆 GraphRAG。约 2–4 天起。
5. **运行诊断与能力说明。** 已有 token/ACP context cost 展示；增量是统一失败分类、运行时/模型/工具版本、重试与耗时摘要，以及“支持图片、恢复、审批、终端”等协商能力说明。精确费用、估计费用与未知费用应区分。先本地诊断导出，外部 trace 作为可选项。
6. **文档与契约去漂移。** README 仍把 Agent 主要描述为 Claude SDK、默认端口写 3000，而 server 当前 fallback 是 3002；`docs/plans` 已不存在。优先更新真正影响安装与排障的内容。双份数据库定义暂时保留现行契约，增加 schema/迁移一致性检查，而不是一次性替换迁移系统。根目录未见 `.github/`，只能确认仓库内缺少该套 GitHub 工作流，不能据此断言没有任何外部 CI。
7. **按边界拆大文件。** chatStore 约 1344 行、ACP runtime 约 1040 行、Direct runtime 约 1166 行、bootstrap 约 1705 行。行数本身不构成缺陷；建议仅在上述修复涉及的范围内，抽离 run 生命周期、消息同步和能力协商，保留跨 runtime 的契约测试。

## 外部热门工具：能借鉴什么

以下能力已核对官方资料。热度为 2026-11-06 的 GitHub API 累计 stars 快照，仓库最近两日有 push；它衡量关注度与维护活跃，不能证明近 30 天增长排名或实际用户规模。

| 工具/生态 | 关注快照 | 已验证能力与官方来源 | 对 OpenHorn 的可用增量 |
|---|---:|---|---|
| OpenClaw | 394,002★ | [仓库](https://github.com/openclaw/openclaw)、[Hooks](https://docs.openclaw.ai/automation/hooks)：Gateway、多渠道入口、生命周期 hooks 和外部事件入口 | 让任务从桌面延伸到消息渠道与事件，而非复制整套 Gateway |
| n8n | 209,660★ | [Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)、[工具审批](https://docs.n8n.io/advanced-ai/human-in-the-loop-tools/) | 先做 webhook 接收/回调或对接外部 n8n；嵌入和分发前核对 fair-code 许可 |
| browser-use | 120,153★ | [仓库](https://github.com/browser-use/browser-use)：本地 browser agent、CLI/Python 入口及可选云浏览器 | 优先经现有 MCP 接工具，再补可见动作、截图证据、接管与继续；避免首期新增整套 Python/云浏览器依赖 |
| CopilotKit | 38,534★ | [仓库](https://github.com/CopilotKit/CopilotKit)、[生成式 UI 概念](https://docs.copilotkit.ai/concepts/generative-ui-overview)：共享状态、受控/声明式/开放 UI、HITL | 基于现有 GenUI 增加产物收藏、版本与再运行；无需整体替换聊天框架 |
| Langfuse | 37,077★ | [仓库](https://github.com/langfuse/langfuse)、[Observability](https://langfuse.com/docs/observability/overview)：模型/工具/检索观测、token/费用/延时，OTel/JS 接入 | 借鉴诊断字段；有真实跨运行质量分析需求时，再选配导出 |
| ACP | 4,585★ | [仓库](https://github.com/agentclientprotocol/agent-client-protocol)、[协议](https://agentclientprotocol.com/protocol/overview)：初始化能力协商、会话、取消、权限与可选文件/终端能力 | 项目已经接入；完善能力诊断与兼容性。wire protocol 版本不能用 SDK 包版本代替 |

stars 可用 `https://api.github.com/repos/<owner>/<repo>` 的 `stargazers_count` 复核；之后数字会变化。产品能力不等于可以无成本移植，正式接入前仍需 spike 验证传输、许可、生命周期与安装成本。

## 最值得做的产品增量

| 顺序 | 具体玩法 | 利用现有能力 | 最小版本与验收 | 粗估 |
|---|---|---|---|---|
| 1 | **任务配方**：把一次成功的任务保存为“竞品周报”“CSV 分析”“代码审查”等 | Skills、MCP、模型渠道、项目、定时任务、已有提示词模板 | 不是再做提示词列表：保存输入参数、所需能力、输出格式和版本；运行前检查缺项，同一配方可立即或定时执行。先 3 个模板 | 4–7 天 |
| 2 | **产物工作台**：将报告、图表、HTML 小工具和生成文件收藏，继续修改、更新数据再运行 | 右侧预览、GenUI、消息关联、本地状态 | 建立独立产物身份、原件存储、来源会话和版本；重启后原件可读，更新不覆盖旧版。跨设备同步后置，UI 状态已有本地持久化不重复建设 | 5–8 天 |
| 3 | **项目知识库**：问某个项目时只用该项目资料，答案可追溯 | 项目、附件、摘要、现有 LanceDB | 索引状态、范围选择、引用跳转、删除即时生效；中文查询和无答案查询有样例基准 | 5–8 天 |
| 4 | **事件触发任务**：GitHub issue/webhook 到达→执行配方→产物与通知 | 定时任务执行链、MCP、配方 | 首期只接一种经验证的 webhook，来源验证、去重、并发上限、失败重试和事件/run 对应关系齐全；本地 sidecar 仍需在线 | 4–7 天，依赖任务租约 |
| 5 | **飞书任务入口**：手机发任务、查看产物、确认某项具体操作 | 自托管服务、MCP、运行状态 | 首期一种渠道；审批绑定 run/tool/参数及有效期，重复点击和超时结果确定。手机入口并不能使离线桌面自动具备执行能力 | 5–10 天，依赖任务身份与审批协议 |
| 6 | **浏览器任务工作台（实验）**：多页资料收集→带来源报告，必要时由用户接管 | MCP、执行事件、右侧预览和产物 | 先一个只读研究场景；展示当前动作和证据，登录接管后能继续。不把普通网页预览视为自动化浏览器能力 | 2–3 周以上，需先 spike |

估算不宜直接相加：配方、产物和事件触发有共享模型，也有尚未确认的业务边界；每项在动手前需明确数据归属和验收样例。

## 建议实施顺序

第一批处理备份可用性/脱敏、任务真实状态/租约、熔断探测和离线待保存恢复。它们直接决定用户是否能信任结果和保存状态。

第二批优先做“任务配方 + 产物工作台”。示例：选择“竞品周报”→填公司与范围→检查搜索工具→生成带来源报告→收藏→下周更新数据产生新版本。它能把项目现有模块组合成完整使用场景。

第三批再接 webhook/n8n 与飞书，逐步实现“事件来了自动做，做完得到可查的产物”。运行器先保持既有本地 sidecar 边界；常驻/远程执行器属于单独架构决策。

暂不优先：全量可视化 DAG、多 Agent 自由组队、GraphRAG、十几个聊天渠道、整体更换 GenUI/Agent 框架。当前收益与引入成本尚无足够证据。

## 验证与复现

- `pnpm typecheck` 通过：5 个配置了 typecheck 的任务全部成功，其中 4 个为 Turbo 缓存命中，桌面为本次执行。这不覆盖运行时依赖 API。
- 使用内存数据库和合成用户复现备份错误、服务层 run 状态覆盖；未打开正常数据库、未调用模型或发送业务消息。
- 用独立时钟复现熔断器 half_open 多次放行。
- 备份凭据遗漏、手动任务提前完成、保存队列与 RAG 范围为代码路径发现，未宣称全部经过端到端复现。

从仓库根目录运行：

```sh
bun docs/audits/2026-11-06/reproduce.ts
pnpm typecheck
```

[复现脚本](audits/2026-11-06/reproduce.ts) 强制使用 `file::memory:`，只写合成数据和临时输出，结束清理本次临时目录。[本次结果](audits/2026-11-06/results.ndjson) 中的 `false`、多次 `true` 与状态改写是问题证据，不是修复后的通过结果。
