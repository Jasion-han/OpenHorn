# 通用网页读取与搜索来源的完整验收

已处理此前价格对比对话中暴露的本地问题：public DNS 被系统代理映射为 Fake-IP 而误拒绝、Claude 较大 HTML 触及旧直接读取上限，以及 Google 动态文档页面只返回标题却被当成已读取。搜索来源标签也补齐了最终原生和重启后验收。

通用页面读取仅在系统 DNS 全为 198.18/15 时查询固定 HTTPS 公共 DNS 的 A/AAAA 结果，验证全部为公网且不等于本机接口。之后用系统 curl 的 `--resolve` 固定连接到已校验 IP，原 URL 保留 Host、SNI 和 TLS 证书校验；普通公网解析同样固定连接，防止校验和连接之间重新解析。每次重定向重新校验，不使用自动跟随。curl 忽略默认 curlrc 和代理环境，子进程剥离产品凭据，Stop/超时会结束本轮子进程。没有新增 npm 依赖或 API Key；没有 curl 的环境明确报告不可用。固定 DeepSeek 官方文档保留之前的 TLS 代理路径。

直接页面上限为 **2 MiB**，足以读取本次约 1.34 MiB 的 Claude 页面；付费 JSON 工具仍保持 1 MiB。输出原文仍有 50,000 字符上限。识别到只有标题的 JavaScript app shell 时，在最终 origin 真实读取一次对应 `.md` 文档，并使用实际返回地址作为来源；失败会报告 `page_requires_javascript`，不冒充已读，整体 Stop/超时预算不重置。

原生实测对话 **「验证联网与网页读取」**（`1ef03a10-17c1-43f3-9c7d-99530d972315`）位于 OpenHorn 项目：**1 次 Search · Tavily、3 次内置 Fetch 全部成功，MCP 和本地工具调用均为 0**。Claude 使用原请求页面，Google 从旧地址转到真实官方 `aistudio.google.com/docs/pricing.md`，OpenAI 使用当前开发者价格文档。界面工具过程为 **4 步 · 30s**。彻底退出并重启 app、重新打开保存对话后，Tavily 来源标记仍可见，步骤已展开留桌面供查看。见 [原生记录](./native-validation.json)、[重载截图](./native/02-reloaded-tavily-source.png)。

完整回归 **1247/0**（Shared132、Desktop737、Sidecar378），聚焦读取测试48/0；类型检查、host Sidecar 及 Tauri debug app 构建通过。直接工具读取的单次结果见 [direct-validation.json](./direct-validation.json)，完整边界与源文件哈希见 [validation.json](./validation.json)。

OpenAI 旧价格地址 `openai.com/api/pricing/` 仍由站点返回 HTTP 403；这是外部站点响应，本次未绕过，已验证其当前官方开发者文档可读。超长网页和持久化工具事件仍是有界摘录，不承诺返回整页全文。原 Tavily、OpenRouter、MCP、Key 和 Jev 环境保持，测试对话与正式证据保留；未提交推送。

收尾：本轮专属临时目录/指针与挂起的探测进程已清理；正式证据及实际测试对话保留。
