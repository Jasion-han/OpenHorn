# DeepSeek 应用能力与 OpenHorn 架构优化

## 目标与授权

用户要求在核对项目代码及 2026-11-13 DeepSeek 应用 API 后，按上一轮建议逐步实现架构和交互优化。此次交付覆盖模型识别、共用搜索与网页读取、显式云端 OCR、DeepSeek 原生联网及历史导入；语音是上一轮明确后置的独立项目。仅本地修改和验证，不提交、推送或部署。

## 现状证据

- 桌面普通 Chat 走 `prepareChatForSidecar → sidecar chat.stream → completeChatFromSidecar`；服务端 SSE send/edit/regenerate 是另一条入口，不能只改其中一条。
- `shared/search` 已有归一化来源和 DuckDuckGo；server/searchService 与 sidecar/direct 分别封装 Tavily，凭据和策略分散。
- Chat 适配器只产出字符串、最终返回 Token usage；没有原生联网事件和网页上下文回传能力。
- 资料库保留原件、CAS 索引租约与本地检索。默认入库不得调用云端模型。现有解析主要为 UTF-8 和 PDF 文字层。
- `detectFormat` 仅凭 ZIP 中有 manifest.json 判断 OpenHorn，会误判 DeepSeek 的 v3 归档。
- 工作区已有大量未提交修改。必须基于当前文件增量编辑，禁止清理、还原、覆盖或自动提交。

## 路线取舍

1. 全部绑定 DeepSeek：接入快，但其他模型不能复用独立工具，不符合多 provider 工作区定位。
2. 只加独立工具：能补搜索和 OCR，但不能保留 DeepSeek 原生联网的引用、网页签名与过程。
3. **采用独立工具 + 显式原生联网模式**：共用 Search/Fetch/OCR 服务；原生联网通过能力判断和结构化事件扩展适配器。已有普通聊天仍使用现有路径。

以上路线是根据用户已接受的上一轮建议作出的实现选择。

## 契约

### 搜索与网页读取

- 独立 DeepSeek 请求固定官方 HTTPS API，不把模型渠道的 key 自动发送至其他地址。不引入依赖。
- 配置用户专用 DeepSeek 工具 Key，搜索 provider 为 auto/tavily/deepseek/duckduckgo；未设置新选项时保持现有优先级。
- server 与 sidecar 复用 shared/search 中的 DeepSeek 响应校验、归一化和选择逻辑。空结果和错误可降级，但不可声称已搜索。
- 独立 Fetch 返回有界正文；只接受公开 HTTP(S) URL，拒绝 credentials、localhost/私网/本机地址；返回网页作为不可信引用资料。
- 桌面 Chat 准备阶段接入共用外部搜索/链接上下文；数据专用 Library/Review 回合不触发外网检索。
- 界面保留明确保存、失败重试、草稿和过期请求保护。新密钥不得进入备份。

### OCR

- 默认上传和重建索引仍本地解析。提供单独的“使用 DeepSeek OCR”操作，在调用前说明整份原件会发送到 DeepSeek、按页计费。
- 原件在 OpenHorn 保留；OCR 成功文字写回已有租约/CAS 索引流程。调用前验证用户归属、格式、限额和显式操作。
- 支持 PDF、DOC/DOCX、PPT/PPTX、PNG/JPEG/WebP 等 OCR 格式；Office/图片上传可保留原件并显示待云端解析，不自动请求外网。
- OCR 按现有 5 MiB 文件、100 PDF 页、2 MiB 输出文字等应用限制收紧。逐页 length/错误/不完整结果不得标记 ready。
- 已 ready 的文档不提供无意义的重复收费入口；失败可显式重试。调用超时不自动重复收费请求。云端处理中延长租约至超过请求超时，删除/过期结果不得复活文档。

### DeepSeek 原生联网

- 显式开启、限定官方 DeepSeek OpenAI 兼容端点及明确支持的 flash 模型；网关和其他 provider 不自动注入私有参数。
- 用可选回调扩展 Chat 适配器，保留已有 string generator 返回 usage 的调用契约。
- 展示用的 citation/步骤与下一轮需要的 provider state 分开；持久化有界 provider state，保留 server_tool_calls 和 signature，按 endpoint/model 身份隔离回放。
- 引用 URL 必须为 HTTP(S)，码点索引不能当 JS UTF-16 索引直接切片。完整引用仅在终态返回时也必须落库并在刷新后显示。
- refusal/content_filter 清除本轮流式正文并记录明确结束状态；Stop 优先于晚到的 provider 事件。普通截断和断线仍保留精确 partial content。
- 桌面本机 Chat 和服务端 Chat 的发送/编辑/重试均接通元数据；不要扩展至 Agent 内建工具执行循环。
- schema 新列仅做幂等添加，同时更新 Drizzle 和 bootstrap。备份导入保留已验证的有界状态，不允许跨 provider 回放。
- prepare 返回消息快照 `saveToken`；当前桌面 complete 必须回传。edit/retry 轮换单独的 `completion_version`，事务内拒绝过期回写；不改旧回答完成时间实现版本失效。兼容旧客户端省略 token，但该旧入口没有快照保护。

### 历史导入

- 识别 OpenHorn manifest 的真实格式，识别 DeepSeek export_format_version=3。
- 增加 DeepSeek 归档转换模块，不把其数据当 OpenHorn 备份恢复。使用既有 ZIP 文件数/体积/重复条目限制。
- 保留当前分支对话正文、时间、思考/搜索步骤中可可靠映射的记录；不编造缺失附件，统计缺失附件和未支持分支。
- 按用户隔离、事务写入一段完整会话、稳定来源标识去重；重复导入跳过而不覆盖现有数据。
- 设置页展示 DeepSeek 格式与导入历史；失败、部分成功和跳过结果如实展示。

## UI 与工程限制

- 沿用现有 React/Radix/暖浅色设计，所有中文文案在 agent.ts 字典。实际检查展开、hover、选中、键盘 focus 状态。
- 无新增外部依赖；adapters 新增 `shared@workspace:*` 内部类型契约依赖，离线更新本地链接和锁文件，无外部下载。无真实付费 API 测试、无读取或输出真实密钥。外部 API 用协议回放验证并清楚标注真实质量未实测。
- Bun 测试；模块 mock 必须隔离/还原。保留现有脏工作区。修改 sidecar 后重新编译 host binary。

## 验收

1. 未配置新能力时原有聊天、搜索、本地资料库不退化。
2. DeepSeek 搜索结果与 Fetch 正文能进入实际 Chat/Agent 路径，引用可展示。
3. 云端 OCR 必须显式操作；失败保留原件；外用户、重复并发、删除后返回均不污染索引。
4. 原生联网协议回放覆盖引用、签名第二轮回传、终态 metadata、拒答、Stop、断线与重试。
5. 真实临时 SQLite 与合成 ZIP 验证 DeepSeek 导入、归属、去重和错误识别。
6. typecheck、范围 lint、相关测试与浏览器验收通过；全量检查若有基线问题准确区分。

## 来源

- https://api-docs.deepseek.com/zh-cn/updates/
- https://api-docs.deepseek.com/zh-cn/guides/web_tools
- https://api-docs.deepseek.com/zh-cn/guides/search
- https://api-docs.deepseek.com/zh-cn/guides/ocr
- https://api-docs.deepseek.com/zh-cn/guides/document_parsing
- https://github.com/deepseek-ai/chat-demo （MIT；复用代码须保留许可）
