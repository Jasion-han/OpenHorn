# OpenRouter 联网接入

后续纠正：用户指出原有Tavily被误隐藏。已配置连接必须保留，验证状态单独标注；不能将缺少新验证记录等同不可用。Tavily和OpenRouter不是重复项，当前均已实测通过并并列展示。下文曾采用的“仅已验证目录”过滤已由此规则取代，见`docs/audits/2026-11-16/tavily-restore/README.md`。

用户已要求直接执行：让现有 OpenRouter Key 可以在项目中使用 DeepSeek 联网，凭据与 Jev 分开。执行沿用现有搜索来源与验证交互，不再新增设计确认轮次。

## 事实与选择

2026-11-16公开模型目录未发现独立DeepSeek搜索模型；端点`native_tools`为空。OpenRouter的`:online`是已弃用的联网变体，不证明转发DeepSeek官方原生搜索。已真实验证`deepseek/deepseek-v4-pro`配合`openrouter:web_search`、显式Exa、`tool_choice=auto`可返回完整回答和结构化来源。

独立“OpenRouter 联网”来源与现有来源并列。模型固定为上方已验证Pro，搜索引擎明确为Exa，默认只填写独立OpenRouter Key。无需选择聊天渠道，不读取Jev凭据，也不借用当前回答模型密钥。现有DeepSeek官方原生来源保留其官方契约。

用户后续明确要求减少选项，只保留可用且不重复的连接：默认主列表改为服务端`availableProviders`中的已验证活动连接，去重并将DeepSeek两种协议合为一个入口（优先当前使用的协议）。未配置/未验证类型只在主动进入“配置其他来源”时出现，不声称可用。当前唯一通过真实验证的连接为OpenRouter，主列表只有这一项。当前已启用且无待验证替换时，禁用重复验证按钮并显示“已启用”，去掉重复的模型/引擎说明。

复用官方原生入口会混淆协议/能力；仅配置聊天渠道不能接通Chat前置检索和Agent Search。因此采用独立来源，沿用候选保存、显式验证、活动连接与revision事务。

## 契约

- 配置`openrouter.searchConnection`、活动`openrouter.activeSearchConnection`均加密；只读派生`openrouter.searchRuntime`只在选中且验证匹配时提供。专用两段保存路由和能力标记避免旧后端明文写入未知Key。
- 冻结官方`https://openrouter.ai/api/v1`、模型和Exa引擎。固定完整聊天端点可按TLS/origin信任兼容fake-IP，不能放开任意中转地址。禁重定向、限响应、贯穿Stop、不自动付费重试或切换源。
- 请求使用自动工具选择，并显式要求一次搜索；`max_uses=1`、`max_results=3`、`max_tokens=2000`、禁provider fallback。模型不调用搜索或无结构化公开`url_citation`时失败；正文中的URL不当证据。拒绝、截断、私有/推理内容不交给回答模型。
- 通过后返回来源及明确标注的模型生成检索摘要，不冒充页面原文。Agent显式URL读取继续走经过URL安全检查的原文路径，不发送OpenRouter Key给网页；服务端Chat保留现有链接读取门控（仅独立DeepSeek工具接通），OpenRouter下明确显示未读取，不以搜索摘要伪造原文。
- 新来源贯穿server Chat/SSE、桌面发送/编辑/重试/后台、Sidecar direct与Claude。联网关闭时不加载或使用检索Key。
- 用户已授权用提供的独立Key做接入测试。自动回归全部合成凭据；实现检查通过后保存独立加密配置，显式调用一次验证并成功才切换真实来源。失败保留Tavily，不重复收费重试。

## 验收

验证保存不启用、修改候选不破坏active、失败保持原来源、迟到验证不能激活新配置、通用PUT/DELETE不能绕过门控、备份不导出凭据、旧后端失败关闭、密钥不会进入模型上下文/日志。完整类型/格式和相关Bun回归通过，编译Sidecar与桌面包，真实打开桌面检查表单、下拉浅色态和当前来源。
