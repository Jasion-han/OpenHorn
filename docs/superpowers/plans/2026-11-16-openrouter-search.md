# OpenRouter 联网实施计划

后续修复：过严过滤误隐藏原有Tavily，已改为保留已配置连接、验证状态单独标注。Tavily已用原Key实测通过且不切换当前OpenRouter，两者并列展示。最新证据见`docs/audits/2026-11-16/tavily-restore/README.md`。

**Goal:** 用户可用独立OpenRouter Key，让DeepSeek Pro提供有来源的检索，供任意回答模型使用。

**Architecture:** 新增`openrouter`同级来源，固定官方地址/Pro/Exa，沿用候选/active与revision验证事务，共享检索适配覆盖两条Chat路径及Sidecar。凭据独立于Jev。

**Tech Stack:** 现有React/Radix、Hono/Drizzle、Bun、TypeScript与Tauri，不新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-16-openrouter-search-design.md`。用户已要求直接执行，由当前会话完成，不自动提交。

## 全局边界与复核重点

只使用固定官方OpenRouter目标；保留任意中转DNS和URL防护。无自动付费重试/降级。合成测试不接触用户Key；真实Key只加密保存并向OpenRouter发送。保留既有脏工作区，不扩大Git操作。文案走agent.ts，沿用浅色菜单。

重点覆盖旧后端误写明文、候选与active漂移、多窗口迟到验证、来源切换后误借Jev/回答Key、完成响应有文本但没有真实引用。

- [x] 1. 共享浏览器安全连接契约、OpenRouter检索请求与严格来源解析；测试拒绝/截断/空引用/伪造正文URL、取消、安全边界和无重试。
  - 新建`packages/shared/src/openrouter-search.ts`、`search/openRouterSearchProvider.ts`及测试；扩展`providerSelection.ts`、`toolTransport.ts`与导出。
- [x] 2. 服务端独立加密配置、配置快照/指纹/revision及显式验证激活；保护派生设置/备份，专用保存路由和后端能力标记。
  - 新建`apps/server/src/services/openRouterSearchSettings.ts`及测试；扩展`searchSettingsService.ts`、`settingsService.ts`、`backupSanitizer.ts`、`routes/settings.ts`及回归。
- [x] 3. 服务端Chat与Sidecar检索路径接通，桌面所有发送入口传播独立连接；关闭联网不加载；显式Fetch不借检索Key。
  - 扩展`searchService.ts`、`sidecarRunSupport.ts`、桌面调用入口、Sidecar协议及direct/Claude；覆盖两种runtime与Chat集成。
- [x] 4. 设置来源新增OpenRouter及最少字段表单；能力缺失只禁新来源，保存/取消/验证和旧来源不漂移。
  - 新建`OpenRouterSearchFields.tsx`；扩展`DeepSeekToolSettings.tsx`、`serverApi.ts`、`i18n/agent.ts`及浏览器夹具。
- [x] 5. 完整Bun/类型/Biome、host Sidecar与Tauri构建，真实独立Key显式验证一次、原生桌面交互验收；记录证据、更新主题和清理临时数据。

最终：用户追加“仅保留可用且不重复”后，主列表按已验证活动目录筛选，DeepSeek协议去重，其他配置显式进入，当前已启用按钮禁重复验证。1953项Bun/0失败、22组设置浏览器交互、类型/Biome、Sidecar及最终Tauri构建通过；第三次限定复核无P1/P2。解锁后通过真实产品验证API仅发起一次收费验证，17.05秒成功并启用OpenRouter；独立Key与候选/active均加密且一致，Jev环境文件未改。最新后端PID80188健康，实际及可用目录均只有OpenRouter。最终原生包已退出旧进程后重启，真实展开主列表只见一项，检查已启用状态、输入并取消草稿、保存与重复验证禁用。证据、截图和清理结果见`docs/audits/2026-11-16/openrouter-search/validation.json`。未提交推送。
