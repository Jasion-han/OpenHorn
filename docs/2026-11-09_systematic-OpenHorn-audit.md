# OpenHorn 系统性可靠性检查

本轮检查了聊天与项目状态、MCP 配置、导入导出、服务端归属与删除链路、Sidecar 工作区以及容器启动模板，确认并修复五类问题。实际修改围绕可复现缺陷展开，未重构无关模块。

## 已修复的问题

| 优先级 / 发现 | 修复前的触发与影响 | 修复后的行为 | 证据 → 调用路径 |
|---|---|---|---|
| P1 会话元数据并发回滚 | 改名与移动项目重叠时，失败请求用整行旧数据回滚，覆盖另一项已成功修改；旧列表也能覆盖刚保存的名称 | 同一会话的写入顺序提交；回滚只处理本次仍拥有的字段；刷新保留期间完成的本地修改，重置会取消未发出的排队请求 | E1 → [元数据回归](../apps/desktop/src/stores/chatStore.metadata.test.ts) → [chatStore](../apps/desktop/src/stores/chatStore.ts) → 会话 API |
| P1 项目一致性 | 列表读取晚于删除返回会让目录重新出现；6个并发添加同一用户/路径的请求会触发唯一键错误 | 桌面列表带请求/修改版本；服务端冲突安全插入并返回唯一项目，不增加数据表或改现有项目 | E2 → [桌面项目回归](../apps/desktop/src/stores/projectStore.test.ts)、[服务端项目回归](../apps/server/src/services/projectService.test.ts) → projectStore → projectService → 既有唯一索引 |
| P1 MCP 连接类型与配置 | UI 改为HTTP配置后服务端仍保存stdio类型；null/数组配置能进入错误路径；旧连接探测可能继续显示绿标 | 持久化修改后的类型，校验名称/类型/对象配置/布尔状态；配置指纹改变时撤销旧探测结果，迟到探测不能恢复旧绿标 | E3 → [MCP服务回归](../apps/server/src/services/mcpService.test.ts) → McpSettings → mcp路由 → mcpService |
| P1 文件导入状态 | 快速重复确认、迟到文件识别/结果窗口缺少保护；导入后相关列表不刷新；带缺失项的结果仍统一显示完成 | 确认按一次操作去重，显示所选文件，离页后不弹旧窗口；部分结果用待处理提示；异步刷新会话/渠道/项目/任务/工作台，不启动模型或任务 | E4 → [浏览器回归](../apps/desktop/scripts/settings-clarity.browser.mjs) → BackupFileImportRow → [刷新入口](../apps/desktop/src/lib/refreshImportedResources.ts) |
| P1 容器模板漂移 | 未安装pnpm、工作区通配复制不能保留目录结构、根目录没有start脚本、容器端口与服务端默认不符 | 固定pnpm@9.0.0、显式工作区复制、使用真实入口与3002端口；Compose默认绑定回环地址；构建上下文仅包含运行源码和依赖清单 | E5 → [Dockerfile](../Dockerfile.server)、[Compose](../docker-compose.yml)、[构建上下文](../.dockerignore) → 隔离容器 API |

## 验证证据

| 证据 | 内容与结果 |
|---|---|
| E1 | [修复前会话测试](audits/2026-11-09/systemic/conversation-before.log)：3项失败；修复后新增6项元数据测试通过，涵盖运行时字段保留、重置与前后台刷新 |
| E2 | [修复前项目列表测试](audits/2026-11-09/systemic/project-before.log)与[并发创建测试](audits/2026-11-09/systemic/server-before.log)失败；修复后桌面/服务端定向回归通过 |
| E3 | 同一份服务端修复前证据显示传输类型未更新；修复后非法配置/错误布尔值被拒绝，原配置保留；浏览器探测使用合成Sidecar，不连接真实MCP |
| E4 | [设置/MCP/导入浏览器证据](audits/2026-11-09/systemic/settings-browser.json)：12项通过；[工作台证据](audits/2026-11-09/systemic/workbench-browser.json)：25项通过；既有聊天失败脚本56项PASS |
| E5 | Docker镜像实际构建成功，构建上下文约1.92MB；[隔离容器结果](audits/2026-11-09/systemic/container-smoke.json)：API启动、空数据库、6请求只创建1项目、HTTP类型更新和400校验均通过；宿主挂载数为0，验证后移除测试容器 |

完整测试：Server465、Desktop657、Sidecar331、Shared53，共 **1,506项通过、0失败**；全仓类型/格式和macOS debug app构建通过。汇总见[结果](audits/2026-11-09/systemic/results.json)，证据文件校验值见[SHA-256](audits/2026-11-09/systemic/sha256.json)。

复查命令在项目根目录运行；服务端必须保留隔离数据库参数：

```bash
pnpm --filter desktop exec bun test src/stores/chatStore.metadata.test.ts src/stores/projectStore.test.ts
OPENHORN_TEST_DATABASE_URL=file:/tmp/openhorn-systemic-review.db pnpm --filter server exec bun test src/services/projectService.test.ts src/services/mcpService.test.ts
node apps/desktop/scripts/settings-clarity.browser.mjs
node apps/desktop/scripts/workbench.browser.mjs
node apps/desktop/scripts/genui-chat-failure.browser.mjs
docker compose config --quiet
docker build -f Dockerfile.server -t openhorn-local-review .
```

本机完整日志位于`/tmp/openhorn-systemic-*.log`，浏览器使用合成API/IPC。容器测试使用独立文件系统和随机宿主回环端口，没有挂载本机数据或传入真实凭据。本地服务重启前后均为344个会话、2条定时任务、0条启用；仅对真实接口提交了无写入的非法MCP输入校验。原生只操作导航并取消文件选择，没有发送会话消息或执行数据导入；浏览器/容器均未调用真实模型或连接外部MCP。未Git提交、推送或外部部署。

## 检查边界与后续建议

- 既有会话/项目删除事务、服务层用户归属、RAG存活来源过滤和Sidecar工作区测试本轮回归通过。这不是对所有并发时序、操作系统或网络条件的穷尽证明。
- HTTP身份仍采用单个本地用户，不是多用户认证系统；本轮保持该架构，实际本机服务与Compose默认均为回环地址。未开展公网或多租户部署验收。
- **下一优先级：启动与大列表性能测量。** 当前主前端chunk约1,839kB（gzip约585kB），侧栏会话仍全量渲染；先记录冷启动、切会话和滚动指标，再决定拆包/虚拟列表，避免无证据重构。
- RAG目前按用户全局检索而非按项目过滤，这是已有产品范围；增加项目级检索需要同时定义共享资料的可见性。本轮未调用embedding模型或改变检索范围，不将它当成已证实越权。
