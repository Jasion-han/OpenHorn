# 搜索来源显示与 Tavily 切换核实

用户将来源切回 Tavily 后，在项目新会话提问“对比主流AI模型的价格和能力”，怀疑界面仍显示其他搜索。已核对会话 `9eae8ef4-13bd-4de9-9c5b-dbb163eb042f`（主流模型价格能力对比）：当前来源为已验证的 Tavily；4 次内置 `web_search` 的持久化结果都含仅 Tavily 分支生成的 provider summary 段，均没有 OpenRouter 标记；MCP 搜索 0 次。4 次搜索耗时 10.52、2.01、7.71、2.19 秒。历史工具事件未记录结构化来源，以上结论来自本轮核对的代码分支和结果结构，不假称有当时的网络抓包。

Exa `web_fetch_exa` 与 Tavily `tavily_extract` 用于后续读取网页原文，并没有替换 Search。原会话还有 3 次直接 Fetch 被 fake-IP DNS 检查拒绝（OpenAI、Claude、Google），随后由 MCP URL 读取恢复；此前只兼容固定 DeepSeek 官方文档，未修复任意网站代理读取，这仍是独立问题。

界面问题是所有内置搜索均只显示 Search。新增运行时生成的 `SearchExecutionSource`，从 Direct/Claude 工具执行分支经 WS、desktop projection、store 到步骤展示，显示 `Search · Tavily` 或 `Search · OpenRouter`。实际发生 Tavily→DuckDuckGo 降级时更新同一调用的开始/结果行并明确降级；不改工具名称/模型参数、不借当前设置重标旧步骤、不从正文猜来源、不改 Key 或路由选择。元数据只保留受限 provider ID，拒绝未知值/错误降级组合。MCP 名和 Fetch 行保留独立含义。

自动化：Shared132、Desktop737、Sidecar368，共1237通过；包含 Direct/Claude 的 Tavily/OpenRouter真实受控工具回合，降级来源、流事件、早开始合并、序列化与历史兼容。类型检查、host Sidecar和Tauri debug app构建通过。

**新版原生显示验收已完成。** 随后在 OpenHorn 项目新建「验证联网与网页读取」，实际出现 Search · Tavily，来源随步骤保存；彻底退出、重启并重新打开这段对话后仍显示正确来源。该回合还完成三站内置 Fetch，无 MCP 补救。见 [联合原生验收](../public-page-fetch/native-validation.json) 与 [重载截图](../public-page-fetch/native/02-reloaded-tavily-source.png)。此前锁屏阻塞已解除，旧历史步骤仍不猜测来源。当前 Tavily、OpenRouter、MCP、Key、原会话及无关 WIP 保留；临时目录/指针已清理，未提交推送。
