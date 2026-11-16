# Agent 搜索源被 MCP 绕过

用户截图显示 Agent 调用了 `tavily-hikari · tavily_search`，尽管当前搜索源为 OpenRouter Flash。已在原生应用展开原对话，确认两步分别为 Tavily Search 与 Tavily Extract；这不是 OpenRouter 失败降级。上轮 Chat 实测不能覆盖此 Agent 路径。

Direct Agent 将全部 MCP 工具与内置 `web_search` 并列交给模型，导致模型自行选择另一搜索入口。修复在工具注册时过滤已识别的通用 MCP 搜索工具，普通搜索保留产品内置 Search、遵循所选来源；明确 `/server` 调用只对该 MCP 放行，仍要求联网许可。保留原 MCP 配置及其他工具（包括按 URL 提取页面和本地/数据库搜索），不按整个服务名删除。已识别能力来自工具名称及明确描述，不能保证识别任意不透明自定义工具。外部 CLI/ACP 的工具目录不在本次改动范围。

新增 `targetMcpServer` 从桌面经 WebSocket schema 传至 Direct runtime，未命中的名字或仅有一个 MCP 均不能解锁竞争搜索。模型提示也明确使用当前产品搜索入口。独立 OpenRouter Key、Tavily 配置和 Jev 环境均未改。

验证：Sidecar 363/0、Desktop 734/0，最终聚焦回归 24/0，类型和 Biome 通过，host Sidecar 与 Tauri debug app 构建成功。运行时受控回归同时提供竞争 Tavily MCP、保留 URL 阅读工具，真实执行 Search 工具回合后只调用受控 OpenRouter 响应一次，未调用 MCP 搜索。

**原生 Agent 实测已补齐。** 解锁后确认正在运行的最终包与已验收 SHA 一致，在 OpenHorn 项目中新建「核实联网搜索支持模型」（`827102b3-8a37-4be4-91e7-655eac594cc9`），发送相同问题，没有点名任何 MCP。实际步骤首项为内置 `Search`，返回明确的 `OpenRouter web search (Exa)`，当前已验证模型为 Flash，`tavily_search` 调用为 0。Search 工具起止时间为 **10.46 秒**；界面显示整个工具过程 **4 个步骤 · 27s**，不能将前次 4.76 秒验证样本当成本轮耗时。回复状态为 completed；步骤已展开并保留对话，便于用户直接查看。

另有独立读取问题：两次内置 Fetch 访问官方 `.md` 网页返回 `unsafe_url`，随后 `mcp__exa__web_fetch_exa` 按 URL 读取到原文并完成回答。这是网页读取恢复，不能误标成 MCP 搜索；本次没有放宽 URL 安全校验，也未将此读取问题宣称已修复。详细原生记录见 [native-agent-validation.json](./native-agent-validation.json)。

原锁屏阻塞已解决，正式证据及测试对话保留，本轮未创建临时数据库或额外临时目录；前轮临时数据已清理。未提交推送。

后续更新：上述 Fetch 读取问题已完成针对性修复，并在新版原生 Agent 中验证原两页均成功，无 MCP 补救；见 [Fetch 原生验收](../fetch-proxy-markdown/README.md)。
