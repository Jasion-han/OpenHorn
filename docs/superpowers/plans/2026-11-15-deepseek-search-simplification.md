# DeepSeek 搜索配置收简 Implementation Plan

> **For agentic workers:** 用户已确认本轮方案，由当前会话逐项实施，不另派代理，不例行请求二次确认。

**Goal:** 搜索源固定 DeepSeek，官方与中转仅作为接入渠道；默认复用已有渠道，单独配置仅填 Key，地址藏于高级展开项。

**Architecture:** 独立的 `deepseek.searchConnection` 加密保存搜索连接，并在同一事务内激活 `liveSearch.provider=deepseek`；`deepseek.searchRuntime` 只读解析用户所属渠道。搜索不再按模型名/地址切换到 OpenRouter 搜索；旧非 DeepSeek 工具配置不得替代 DeepSeek 搜索。OCR 保留其单独确认路径，原生联网开关移到折叠高级设置。

**Tech Stack:** React、Hono、LibSQL/Drizzle、Bun、Tauri。

**Spec:** 用户本轮“固定 DeepSeek 搜索源、尽量减少填写”的说明及“好”的确认；取代此前通用工具表单方向。

## Global Constraints

- 保留既有 WIP；本轮不自动提交。
- 所有用户文案走 i18n 字典，菜单沿用灰白共享样式。
- 不把 OpenRouter 自有搜索冒充 DeepSeek，不静默换搜索源。
- 不自动发起付费探测；保存只能说明配置已保存，实际接口能力由首次显式搜索验证。
- 地址与对应 Key 原子保存；新搜索配置存在却无效时不回退旧密钥。
- 不保存真实用户配置作验收，不上传真实资料；使用合成测试响应。

## Review Focus

- 已有渠道删除/停用/跨用户，保存失败且搜索来源不变。
- 保存连接与激活搜索来源须一并成功或一并失败。
- 旧 OpenRouter 工具配置不能触发其搜索，也不能把 Key 发至 DeepSeek 官方。
- 编辑时重连保留草稿，修改地址清空旧 Key。
- 默认界面无搜索来源、连接方式、模型和原生联网开关；单独填写时默认隐藏地址。

### Task 1: 搜索连接契约与服务端事务

**Files:** 新建 shared DeepSeek 搜索契约、server 搜索配置保存服务及测试；调整 settingsService 派生读取。

- [x] 测试旧配置兼容、非 DeepSeek 连接拒绝、用户隔离及原子激活。
- [x] 实现搜索专用加密配置与只读运行时；保留其他工具配置数据。
- [x] 验证定向 Bun 测试与类型检查。

### Task 2: 固定运行时搜索源

**Files:** searchService、sidecarRunSupport、Sidecar direct runtime 及相关测试。

- [x] server/Sidecar 都读取搜索专用连接，并拒绝 OpenRouter 自有搜索替代。
- [x] 验证不传模型、仅请求 DeepSeek 工具端点，失败不回退其他搜索源。

### Task 3: 最小配置界面

**Files:** DeepSeekToolSettings、ToolConnectionFields、toolConnectionDraft、独立高级原生联网组件、i18n、浏览器fixture。

- [x] 主界面仅保留“接入渠道”和保存，手填为同一选择器的末项。
- [x] 手填显示 Key，接口地址默认官方且收在展开项；无模型、来源、供应商分类。
- [x] 保存自动启用 DeepSeek 搜索；已启用时提供停用入口，停用保留连接。
- [x] 原生联网移到独立折叠高级区域；加载/保存失败可重试。

### Task 4: 验收与清理

- [x] 浏览器验证少字段、展开/聚焦态、失败草稿、渠道复用和一次保存直接激活。
- [x] 全量相关测试、类型、Biome、Sidecar及Tauri构建。
- [x] 真实打开桌面查看主界面、手填展开项及渠道菜单；不保存真实配置。
- [x] 更新记忆、核对既有 WIP 并清理本轮临时文件。
