# DeepSeek Workspace Capabilities Implementation Plan

> **For agentic workers:** 按本文分阶段执行，使用 boss 的独立写集与验证门禁；主会话负责跨模块集成和最终复核。实施阶段不自动 Git 提交；后续 Git 收尾按用户 ship-flow 授权执行。

**Goal:** 在 OpenHorn 当前架构中接入可配置 DeepSeek 工具、显式 OCR、完整原生联网和可追溯历史导入。

**Architecture:** 保持 shared/provider helpers → server/sidecar → desktop 的分层。普通 Chat 的文本流兼容，provider 扩展元数据通过独立可选回调、DTO 和持久化通路传递。

**Tech Stack:** TypeScript, Bun, Hono, Drizzle/LibSQL, React 19, Radix, Playwright。

**Spec:** `docs/superpowers/specs/2026-11-14-deepseek-workspace-capabilities.md`

## Global Constraints

- 当前 main 有约 258 个脏路径，禁止 reset/clean/覆盖已有工作。
- pnpm 管包、Bun 测试；无新增外部依赖；仅离线链接 adapters→shared workspace；不调用真实付费 API。
- 中文 UI 仅在 agent.ts；暖浅色控件状态；密钥不进备份。
- 新增 DB 字段必须同步 Drizzle/bootstrap；sidecar 变更必须 compile:tauri:host。

## Review Focus

- 普通桌面 Chat 绕过 server SSE，必须检查 prepare/complete 与本机流。
- provider 最后一个 chunk 才返回引用/签名；Stop/拒答不能落盘失真。
- 云端 OCR 失败/并发/删除后返回，不能重复收费或复活过期索引。
- ZIP manifest 重名、无效 JSON、重复导入、坏分支，不能误认备份或覆盖数据。
- 新设置保存与重连交错、导航切换、失败重试，不能丢失用户草稿。

## Tasks

### 1. 共用工具与配置

- [x] 红测 DeepSeek Search/Fetch 的合法与畸形响应、URL 限制、空结果、超时与选择策略。
- [x] 实现 shared/search provider；接入 server/searchService 和 sidecar 通用 Agent。
- [x] 接入专用设置 UI，保存/失败/草稿保护；更新备份安全白名单。
- [x] 用范围 Bun 测试和 TypeScript 验证旧 Tavily/DDG 行为不变。

### 2. 显式 OCR

- [x] 合成 HTTP 回放测试 OCR 页完整性、错误体、长度和超时。
- [x] 在资料库 CAS 流程加入单独 OCR 入口，扩展可保存格式且默认不联网。
- [x] 在文档操作区加入确认流程及失败反馈；真实临时 DB 验证归属和并发。

### 3. 原生联网 Chat

- [x] 协议回放红测文本/引用/工具事件/终态签名/拒答。
- [x] 扩展适配器、共享 DTO 和新增 providerState 列，保留旧文本流接口。
- [x] 接通 Sidecar、server send/edit/regenerate、prepare/complete 与桌面显示。
- [x] 验证第二轮签名回传、渠道隔离、Stop/截断/断线及 reload。

### 4. DeepSeek 导入

- [x] 合成 ZIP 红测真实 manifest 格式识别与当前分支转换。
- [x] 独立解析模块、事务落库/去重、导入历史、UI 格式标签。
- [x] 真实临时 DB 跑重复导入、其他用户隔离、坏档案和缺失附件。

### 5. 集成与交付

- [x] 更新 DeepSeek 模型预设和视觉能力识别；保守处理旧 text-only 别名。
- [x] 浏览器验证设置、资料库 OCR 确认和引用列表；展开控件检查浅色状态与键盘操作。
- [x] 全 workspace typecheck、相关 Bun suites、范围 Biome、desktop build、sidecar host compile。
- [x] 写实际结果、限制与可复用架构约束，不宣称未执行的真实 API 或原生端到端测试。
