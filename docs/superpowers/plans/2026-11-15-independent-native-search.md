# DeepSeek 原生联网独立搜索方案实施计划

**Goal:** DeepSeek 原生联网与 Tavily 在同一搜索来源选择区并列，GPT/Claude 等回答模型也可使用它获取联网依据；移除独立覆盖开关。

**Architecture:** 新增 `deepseek-native` 来源，固定官方 Responses API 和明确支持 web_search 的 `deepseek-v4-pro`，不把旧 Chat/Flash 参数复制到新接口。共享检索实现供 server Chat 与 Sidecar Search 使用；只传递已验证的结构化来源和明确标注为模型生成的检索摘要，不把 DeepSeek 私有状态、签名或推理内容交给其他模型。候选配置、活动配置和能力验证沿用已有事务/revision 保护。

**Tech Stack:** React/Radix、Hono/Drizzle/Bun、共享 TypeScript、现有 Tauri/Sidecar。

**授权:** 用户已确认把原生联网接成独立联网渠道，让 GPT/Claude 等模型也能使用。按已确认方案在当前会话实施；不重复请求例行设计许可，不自动收费探测、不保存真实用户配置、不自动提交。

## 接入和界面

- 来源并列：Tavily、DeepSeek 原生联网、DeepSeek 搜索接口、DuckDuckGo；既有独立接口保留并明确命名。
- 原生联网默认仅需官方 Key，显示固定接口和 `deepseek-v4-pro`；存在可用官方渠道/模型时允许复用，并显示渠道名、模型和“使用渠道 Key”。不列普通 GPT/OpenRouter/Claude 渠道为可选项。
- 保存配置不启用；显式验证取得完整响应、真实搜索调用记录（不能标记未完成）、非零成功搜索计数及可用结构化网页来源，才原子激活。普通模型回答、无来源、拒绝、截断或未执行检索一律失败。
- 验证会产生模型和检索费用；一次 HTTP 请求可能包含多个服务端搜索操作，不承诺只计费一次搜索。无自动重试/切换来源。
- 删除底部高级开关及其 Chat 优先覆盖分支；旧布尔设置保留数据但不再决定联网路径。当前来源须是唯一权威。

## 实施步骤

- [x] 1. 共享原生连接契约、官方模型/地址校验、Responses 检索和结构化结果解析；Bun 覆盖成功、伪造搜索、无来源、超时/取消与安全边界。
- [x] 2. 服务端原生候选/active 加密保存、所属用户渠道/已启用模型解析、验证指纹、原子快照与激活；旧覆盖开关不再生效。
- [x] 3. Chat 任意回答模型前统一使用选中来源；Sidecar direct 与 Claude Search、发送/编辑/重试/后台任务完整传递独立原生凭据；失败不静默回退。显式 URL Fetch 不用模型摘要冒充原文。
- [x] 4. 统一设置新增原生来源与清晰凭据字段，删除底部覆盖开关；保留草稿/revision 绑定/失败恢复及浅色交互。
- [x] 5. 跨模块测试、类型/Biome、host Sidecar 编译、桌面包和真实原生界面逐项操作；独立 reviewer 复核，清理临时数据并更新已有知识主题。

## 验收重点

- GPT 与 Claude 的回答凭据不得被误用为 DeepSeek 检索凭据；检索的 Key/模型来源必须可见。
- 开启旧 nativeWebEnabled 不能覆盖 Tavily 或再额外启动一次搜索。
- 只有 completed 响应、server web_search 调用记录、非零成功计数及结构化来源才算联网；调用项status按官方契约可省略，但不能以模型正文代替证据。只有满足这些条件才算联网，不能从模型正文提取 URL 伪造证据。
- 复用渠道 Key/地址/模型启用状态变化撤销运行时；验证期间修改拒绝迟到激活。
- 自动化全用合成凭据/受控响应；真实账户仅查看和取消未保存草稿。

**官方依据（已核对）:** https://api-docs.deepseek.com/guides/responses_api/ ，https://api-docs.deepseek.com/api/create-response/ 。Responses 原生 web_search 支持 deepseek-v4-pro，deepseek-flash 会忽略该工具。

## 已验证的补充边界

- Native候选序列化明确冻结`model`与`baseUrl`，避免客户端展示与后端默认模型不一致；能力标记缺失时界面只读。
- Native Key保存使用独立两段URL，不落入旧后端通用设置明文写入入口。
- 回答模型metadata不能覆盖独立检索来源，私有状态/签名/推理不得传给其他模型。
- `forceWebSearch=false`在分类/搜索/天气前拒绝外部请求；SSE编辑/重试贯穿取消信号。
- 前置检索Stop有用户+会话+nonce作用域，取消早于请求也有效；取消检索后仍返回已保存的停止回合，不启动回答模型，准备完成前不释放前台所有权。
- 上传前即登记Stop与所有权等待；`stoppedBeforeStart`确保上传耗时超过取消墓碑有效期或取消请求失败时，已停止回合仍不启动检索。停止后的上传失败保留问题和经过校验的附件元数据，标明上传未确认，不把本地元数据当已上传文件。
- 自动化已通过：Bun全套1906/0、搜索配置浏览器14组、真实Chat组件浏览器62组；类型、Biome、host Sidecar编译与最终Tauri debug包构建通过。2026-11-16 解锁后已通过CUA退出旧进程、启动最终构建，实际查看四来源、原生Key/模型说明、输入并取消合成草稿、展开中转地址、查看DuckDuckGo并恢复Tavily；真实配置未改。悬停由浏览器夹具验证，原生截图覆盖默认/选中/键盘态，不声称原生独立悬停帧也已留存。证据与清理结果见`docs/audits/2026-11-15/independent-native-search/validation.json`。
