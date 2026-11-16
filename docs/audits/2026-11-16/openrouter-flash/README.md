# OpenRouter 轻量检索模型切换

用户嫌 Pro 的 18.65 秒验证耗时太长，要求更轻量、更快。当前已启用 DeepSeek V4 Flash；使用原来的独立 OpenRouter 搜索 Key，保留 Tavily 与 Jev 配置。

- Flash 仅整理最多三条简短结论，关闭 reasoning，按 latency 优先路由，保留 Exa 搜索及结构化引用检查。
- 显式存量 Pro 完整保留，Flash 候选必须独立验证成功才原子替换 active。新旧模型属于不同验证指纹。桌面显示实际保存模型，修改 Key 保留该模型。
- 真实启用验证成功，但计时收集脚本在之后读取未指定 keys 的 settings 时出错；没有记下该次耗时。修正后额外显式调用只验证路由，4.76 秒成功。共两次真实验证，无自动重试。前次 Pro 18.65 秒与本次 Flash 4.76 秒仅是单次样本比较，不保证固定延迟。
- 最终自动化：Server 646、Desktop 734、Sidecar 357、Shared 128，共 1865 通过、0 失败；浏览器 23 组，包含存量 Pro 显示/改 Key 兼容。类型、Biome、host Sidecar 及 Tauri debug app 构建通过。
- 重启最终原生包，实看 Flash 已启用、菜单只有 Tavily/OpenRouter 两项、浅色选中态；进入 Tavily 看到原有掩码 Key，再恢复 OpenRouter 视图，未触发额外验证。

详细结果见 [validation.json](./validation.json)、[真实调用记录](./live-validation.json) 和 [原生界面](./native/01-active-flash.png)。本轮未提交或推送。历史 Pro-only 说明以本次兼容契约为准。
