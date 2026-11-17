# 工具服务与中转适配 Implementation Plan

> **For agentic workers:** 按任务逐项实施与复核，本轮由当前会话直接执行，不额外派生代理；用户已明确要求“好，改吧”。

**Goal:** 在同一工具服务配置中支持 DeepSeek 官方、兼容中转及 OpenRouter，允许手填或复用已有渠道。按用户后续截图反馈，不显示三个供应商分类，统一为一个工具连接表单。

**Architecture:** `shared/search` 负责经过校验的工具连接及供应商 Search/Fetch 适配。服务端加密、原子保存地址/凭据或渠道引用，运行时按用户归属解析；server 和 Sidecar 使用同一连接。OCR 保留 DeepSeek 逐页契约，OpenRouter PDF 只消费解析器 file annotation 原文，不以模型摘要替代识别结果。

**Tech Stack:** TypeScript、Bun、Hono、React/Tauri、现有 LibSQL settings、Zod。

**Spec:** `.trellis/research/tool-relay-feasibility.md` 及用户本轮批准的方案。

## Global Constraints

- 保留全部既有 WIP，局部配色补漏不丢失；不自动提交。
- 中文显示文案仅写入 `apps/desktop/src/lib/i18n/agent.ts`；沿用灰白共享样式。
- 连接地址/密钥存为一个加密配置；渠道引用只按当前用户解析，禁用/已删渠道不借用其他密钥。
- 新中转地址仅支持公网 HTTPS、无URL凭据/查询/片段，不跟随携带密钥的重定向；付费工具不自动重试或回退到其他收费供应商。
- 原生 DeepSeek Chat 联网 origin/model 门控保持独立，配置工具中转不自动开启原生联网。
- 旧 `deepseek.toolsApiKey` 在没有新连接配置时继续生效；新连接配置存在却失效时禁止回退旧 key。
- 不运行真实付费查询或上传用户文档验证；用合成协议响应验证，再实际打开桌面检查表单。

## Review Focus

- 地址或渠道改变后旧 Key 不自动用于新目标；整组配置保存失败保留草稿。
- 错误/无来源/拒绝/截断响应不能冒充搜索或文档识别成功。
- 发送、编辑、重试、后台任务与 Sidecar schema 都传递工具连接。
- OCR 上传确认准确说明配置的第三方目的地与 PDF 解析边界。
- 凭据不进入备份、日志、测试快照或前端静态 bundle。

### Task 1: 连接与共享工具适配

**Files:** 新建 `packages/shared/src/search/toolConnection.ts`、`toolProvider.ts`、`toolProvider.test.ts`；调整 `deepseekProvider.ts`、`index.ts`。

**Interfaces:** `ToolConnection={kind:'deepseek'|'openrouter',baseUrl:string,apiKey:string,model?:string}`；`searchToolService(query, options)`、`fetchToolService(url, options)` 产出既有来源类型。

- [x] 编写协议/错误/URL隔离测试并确认失败。
- [x] 实现兼容中转地址构造、公共HTTPS验证和OpenRouter基于citation的结果解析。
- [x] 运行 shared 定向测试和类型检查。

### Task 2: 服务端配置、渠道解析与文档适配

**Files:** 新建 `apps/server/src/services/toolConnectionService.ts`、`libraryToolParser.ts` 及测试；调整 settingsService、searchService、libraryService、settings 路由和 backupSanitizer 测试。

**Interfaces:** `tools.connection` 加密配置保存手填连接或渠道引用；只读派生 `tools.runtime` 为当次解析出的连接，失效连接返回空而不回退旧密钥。OpenRouter PDF 只采纳 file annotation 的 text 部分。

- [x] 测试原子加密、用户隔离、渠道删除/禁用与备份排除。
- [x] 接通 Search/Fetch/OCR；保留 DeepSeek 逐页OCR解析原逻辑。
- [x] 运行服务端隔离测试与类型检查。

### Task 3: Sidecar 端到端传播

**Files:** sidecarRunSupport、DesktopChatArea、backgroundTaskRunner、useSidecarAgentRun、sidecarClient、Sidecar protocol/index/direct。

- [x] 增加可选 ToolConnection 字段并贯穿发送/重试/编辑/后台任务。
- [x] 测试 schema 不剥离连接、网页权限关时无请求、失效连接不发送旧 key。
- [x] Sidecar测试与host二进制编译。

### Task 4: 设置界面与交付复验

**Files:** DeepSeekToolSettings（保留兼容导出）、新工具连接表单/草稿模块、LibraryOcrDialog、i18n字典、浏览器fixture与脚本。

- [x] 统一工具服务入口，仅显示手填/已有渠道、接口地址、可选模型与能力说明；按地址和模型配置选择内部协议，保留重连/失败草稿。
- [x] 连接字段作为一组保存，防止迟到重连拆开地址/Key；更换目的地清空手填Key。
- [x] 浏览器验证两类连接、保存失败/重试、展开菜单及聚焦配色；完整类型/格式检查和构建。
- [x] 重启实际桌面，查看两种配置展开状态；不保存用户真实配置，不运行付费工具。
- [x] 更新记忆、核对无关WIP并清理任务临时文件；如需真实中转联调，明确仍需具体服务可用性验证。
