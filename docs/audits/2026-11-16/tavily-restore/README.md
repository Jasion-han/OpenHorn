# Tavily 误隐藏修复

原因：上一轮将“去重并保留可用连接”错误实现为只展示有新验证记录的来源，导致原有Tavily被隐藏。配置和Key从未删除。

修复后保留已配置连接，将验证状态单独标注。缺少新验证记录时显示“待验证”，不会把Tavily与OpenRouter合并或隐藏；真正未配置的类型仍需主动进入配置。

新增只验证、不切换来源的专用API `POST /settings/search/verify`，沿用原有来源校验、revision事务和并发保护。旧后端不识别该路由时返回404，不会误触发切换。

真实Tavily验证仅请求一次，7.28秒通过；原Tavily Key、原启用开关、当前OpenRouter来源及其凭据/验证行逐值保持不变，Jev环境文件哈希未变。最终已配置和已验证列表均包含Tavily与OpenRouter，当前使用仍是OpenRouter。

验证：Server 645/0、Desktop 734/0、设置浏览器22组、完整类型检查与Biome通过；Tauri debug包构建完成并实际重启。未修改Sidecar运行代码。

原生实际展开主列表看到两个独立选项，选Tavily能看到原Key掩码，未点击重复收费验证；随后恢复OpenRouter表单。截图见`native/01-both-connections.png`、`02-original-tavily-key.png`、`03-restored-default.png`。

临时测试数据和任务材料已清理，正式证据保留。未提交推送。机器记录见`validation.json`。
