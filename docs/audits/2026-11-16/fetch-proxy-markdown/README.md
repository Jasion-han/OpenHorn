# 官方文档 Fetch：Fake-IP 与 Markdown 修复

前轮 Agent 对话中，内置 Fetch 读取 DeepSeek 官方的 Responses API 和 pricing Markdown 页面，两次返回 `unsafe_url`，随后通过 Exa MCP 网页读取恢复。本轮修复这两个实际失败页面。

根因有两个：系统代理将 `api-docs.deepseek.com` 映射为 `198.18.0.25`；通用 SSRF 检查将其视为保留地址。另外直接 Fetch 未接受 `text/markdown`，即使 DNS 校验通过，也无法读取这两个文档。

实现增加仅供直接页面读取的 `assertPublicPageUrl`：仅固定的 `https://api-docs.deepseek.com` origin 可使用全部为 `198.18/15` 且不等于本机接口的 Fake-IP DNS；其他域名、HTTP、非默认端口、私网或混合 DNS 均不借用此例外。TLS 显式强制证书验证，每次重定向仍先校验，付费工具端点/target 的原校验不变。新增 Markdown MIME 类型作为原文处理，继续限制正文大小及超时，不向网页发送搜索/回答 Key。该修复是官方文档的窄范围兼容，不是任意网站的 Fake-IP 全局放行。

直接用产品 `executeTool("web_fetch")` 在实际本机代理环境读取两页成功，分别约 2.43 秒和 0.59 秒，返回原文及来源。未调用 MCP 或付费搜索；见 [direct-validation.json](./direct-validation.json)。共享层 131、Sidecar 365 全绿，完整类型/Biome、host Sidecar 及 Tauri debug app 构建通过，包内 Sidecar 与编译产物哈希一致。未增加依赖、Key 或设置。

**原生 Agent 验收已完成。** 解锁后核对最终 app、包内 Sidecar 及源文件哈希均与已验证版本一致，检查输入草稿完整后，在 OpenHorn 项目发送验证问题。新对话「读取官方文档并核实」（`0c8a0101-15de-47af-a7a5-4b79eda58a53`）只有两次内置 `web_fetch`，均成功返回页面原文，无 `unsafe_url`、MCP、搜索或本地文件/命令调用，回复 completed。两次读取工具起止时间为 **1.42 秒**和 **0.32 秒**，界面显示工具过程 **2 个步骤 · 11s**。执行步骤已展开并留在桌面供用户查看；来源与标题分别为 Using the Responses API、Models & Pricing。持久化工具事件只保留结果摘录，不能将摘录长度当作完整页面长度。证据见 [native-validation.json](./native-validation.json) 及 [原生截图](./native/02-two-fetch-success.png)。

原锁屏阻塞已解除，未绕过锁屏。正式证据和测试对话保留，本轮临时目录及指针已清理，没有新增依赖或修改 Key，未提交推送。
