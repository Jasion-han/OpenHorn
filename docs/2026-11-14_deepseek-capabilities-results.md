# DeepSeek 应用能力与 OpenHorn 优化结果

本次将 DeepSeek 2026-11-13 应用 API 中适合 OpenHorn 的能力接入现有工作区：共用搜索与网页读取、资料库显式 OCR、DeepSeek 原生联网，以及 DeepSeek 历史导入。没有新增外部运行库；适配器补充了对现有 shared workspace 的类型依赖。

真实 API 的质量、延迟、账户权限和最终账单没有实测。本次验证使用协议回放、临时 SQLite、实际 React 组件与浏览器交互；没有使用用户真实密钥、资料或生产数据库。上述数字记录实现阶段的工作区快照，当时尚未提交或部署。后续提交已按变更块排除其他既有改动，并在隔离版本重新验证，见[提交隔离验收](2026-11-14_deepseek-shipping-results.md)。

## 使用入口

1. **设置 → Agent → 搜索来源与 DeepSeek 工具**：选择自动、Tavily、DeepSeek 或 DuckDuckGo。自动保留原有优先级；选择 DeepSeek 时需单独保存工具 Key。密钥加密保存，不进入备份。
2. **DeepSeek 原生联网**：在上述区域显式开启，再使用官方渠道的受支持 Flash 模型，并开启会话联网。使用模型渠道的密钥，显示联网步骤、来源及工具调用次数。其他供应商和网关继续普通兼容路径。
3. **资料库 → 选择文档 → 更多 → 使用 DeepSeek OCR**：按次确认整份原件上传和按页计费。默认上传、本地重建、检索和恢复备份不会自动调用 OCR。成功文字进入原有本地索引，原件保留；失败可核对后手动重试。
4. **设置 → 导入 → 备份或导出文件**：支持 DeepSeek v3 ZIP。导入当前分支，不覆盖既有历史；缺失附件、其他分支和不能恢复的签名明确列入结果。

## 代码梳理与改动

| 链路 | 原有情况 | 本次调整与代码入口 |
|---|---|---|
| 模型能力 | 预设仍列旧 DeepSeek 模型；Flash 无法通过视觉名单 | 更新 `shared/constants` 和 `shared/vision`；已知 Flash 别名与 Pro/旧文本模型分别处理，不按模糊子串全部放行 |
| 共用检索 | server 与 sidecar 各自封装搜索，只有 Tavily/DDG | `shared/search/deepseekProvider.ts` 统一协议、有界响应、取消和来源归一化；`providerSelection.ts` 统一选择；`webSafety.ts` 验证公开 URL/DNS |
| 服务端聊天 | SSE 有实时上下文，桌面 prepare 路径没有相同接线 | `messageService.ts` 将搜索/读链接接入 prepare 与 SSE，基于有效系统提示排除 Library/Review，原生联网不重复走独立 Search/Fetch |
| 原生协议 | Chat generator 只输出文本和 usage | `adapters/deepseek-native-web.ts` 处理工具事件、终态引用与签名；用可选 metadata callback 保持旧文本 generator 接口 |
| 持久化 | 没有 provider continuation state；prepare/complete 缺少快照保护 | messages 增加 `provider_state` 与 `completion_version`，同步 Drizzle/bootstrap；prepare 返回 saveToken，新桌面 complete 在事务内校验快照 |
| 桌面交互 | 没有工具来源选择、OCR 确认或原生联网过程 | `DeepSeekToolSettings`、`DesktopNativeWebActivity`、`LibraryOcrDialog`；保存失败保留草稿，过期读取不覆盖编辑，来源列表过滤不安全 URL |
| 文档解析 | UTF-8 与 PDF 文字层，扫描件/Office 缺少处理入口 | `libraryOcr.ts` 校验完整页集、实际 PDF 页数和输出限制；原索引流程加入显式云端 claim，五分钟租约涵盖180秒请求 |
| 外部导入 | ZIP 有 manifest.json 就视为 OpenHorn | 内容识别实际 manifest；`deepseekImport*` 拆分格式、校验、转换和事务，稳定用户/来源会话主键保证重入去重 |

## 实际架构边界

普通桌面 Chat 仍走：

```text
React → server prepare（有效联网策略、上下文、快照 token）
      → sidecar Chat → provider adapter（文本 + 独立 metadata）
      → React → server complete（快照校验、正文/来源/state 分别落库）
```

服务端 send/edit/regenerate 的 SSE 是另一条实际入口，复用相同能力判断与数据契约。Agent 执行循环保持独立，仅通用 Agent 的 search/fetch 工具复用共用 provider。未将 DeepSeek 私有工具参数自动发送给其他网关。

展示数据与模型回传数据分别保存。引用和步骤用于界面；签名随所属 assistant 消息存储，限定官方 origin/model，最多256 KiB。两端在预算裁剪前过滤本轮不能回放的状态，匹配的状态与完整旧轮次一起保留或丢弃，不截断签名。

新的桌面 complete 必须携带 prepare 的 saveToken。edit/retry 开始时轮换独立 completion version，迟到回写返回409，不能覆盖新结果。该版本不占用回复完成时间。旧调用方省略 token 的兼容入口仍保留，因此旧客户端没有这项保护。没有 provider state/version 的旧行保持原 token 算法，避免使既有 Agent outbox 无故失效。

## 复核中修复的行为

- 终态才收到的引用、工具调用与网页签名也会保存，第二轮可恢复原网页上下文。
- 大签名与展示 metadata 分别校验、传输和保存，不因较小展示限额使整轮保存失败。
- 普通 OpenAI 与 DeepSeek 的拒答都会撤回已流出的正文，并保存 refused 状态；拒答重试不会在界面恢复旧答案。Stop 优先于晚到事件。
- 零输出失败/Stop 重试保留旧正文、usage、引用与 state；真实拒答替换旧结果。
- OCR 领取和提交均检查归属、revision、token、有效租约；ready/有效占用不重复收费，删除或过期返回不能复活索引。HTTP200中的错误对象、少页和 length 结果不作为成功。
- 备份恢复校验 provider state；非法、超限或 Agent 携带的 Chat state 被省略并明确报告。
- DeepSeek 导入按用户和来源会话稳定去重；SQLite COMMIT 锁竞争在同一事务重试，避免跨进程导入产生虚假的失败或重复。
- 同目录向量存储实例共享正在进行的表初始化，避免读到尚未完成的表；原有并发回归连续10轮通过。
- 测试统一使用合成加密 Key，未 mock 的外网被阻止。并行测试显式使用不同临时数据库，避免固定测试库互相覆盖。

## 验证与复现

完整命令结果记录于 [validation.json](audits/2026-11-14/deepseek/validation.json)，界面证据同目录保存。测试覆盖普通兼容路径及新能力：

- shared/adapters：Search/Fetch 响应与安全边界、模型视觉、签名预算、native SSE 与终态、拒答和断线。
- server：真实临时 SQLite 的 Chat send/edit/retry/prepare/complete、来源身份、快照冲突、OCR 权限和租约、DeepSeek 导入重入/跨进程、备份恢复。
- desktop/sidecar：事件接线、引用与结束状态、Stop/重试、provider state 回放前过滤，以及原有回归套件。
- 浏览器：新设置加载/保存失败、草稿保护、展开/hover/选中/focus浅色状态、来源与联网过程、资料库真实菜单/确认/失败/导航恢复；实际 Chat 的拒答撤回与重试后刷新一致性。

可重复运行：

```bash
pnpm typecheck
pnpm check
bun --no-env-file test packages/shared/src packages/adapters/src
pnpm --filter desktop exec bun --no-env-file test
pnpm --filter sidecar exec bun --no-env-file test
OPENHORN_TEST_DATABASE_URL="file:$(mktemp -d)/test.db" pnpm --filter server exec bun --no-env-file test
node apps/desktop/scripts/deepseek-capabilities.browser.mjs
node apps/desktop/scripts/library-ocr.browser.mjs
node apps/desktop/scripts/genui-chat-failure.browser.mjs
pnpm --filter desktop run build:ui
pnpm --filter sidecar run compile:tauri:host
```

桌面浏览器验证不等同完整 Tauri 原生端到端验收。Sidecar 已要求重新编译，真实 API 仍需在配置后用小样本验证。语音 ASR/TTS 与 Files API 的图文混排解析保持后置，当前 Office/图片能力为资料库 OCR。

## 依据

- [设计与范围](superpowers/specs/2026-11-14-deepseek-workspace-capabilities.md)
- [实施计划](superpowers/plans/2026-11-14-deepseek-workspace-capabilities.md)
- [DeepSeek 应用 API 更新](https://api-docs.deepseek.com/zh-cn/updates/)
- [联网工具](https://api-docs.deepseek.com/zh-cn/guides/web_tools)、[独立 Search/Fetch](https://api-docs.deepseek.com/zh-cn/guides/search)、[OCR](https://api-docs.deepseek.com/zh-cn/guides/ocr)
- [官方 MIT 演示客户端](https://github.com/deepseek-ai/chat-demo)；借用的格式/校验保留许可说明。
