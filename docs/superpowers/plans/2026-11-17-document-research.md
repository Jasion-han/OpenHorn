# PDF 图文输入与深度研究 Implementation Plan

**Goal:** 提供可选择页码的本地 PDF 图文输入，以及遵循当前搜索源的有界网页研究。

**Architecture:** PDF.js 将显式选择的页面转换为现有图片附件；新研究执行器通过 adapters 调用模型并复用内置 Search/Fetch。Chat/Agent 模式与原有保存链路保留。

**Tech Stack:** React、Zustand、PDF.js、Bun、TypeScript、现有 provider adapters；上传使用 busboy 绕开已复现的 Bun 二进制截断。

**Spec:** `docs/superpowers/specs/2026-11-17-document-research-design.md`

## Global Constraints

- 保留现有工作区和配置；不自动收费测试或提交。
- UI 中文仅写入 `apps/desktop/src/lib/i18n/agent.ts`。
- PDF 每次最多6页、每图1MiB、合计6MiB、长边1600；超限明确失败。
- 研究4次搜索、6次读取、12轮工具决策、180秒；只有网页工具，API渠道。

## Review Focus

- 文档解析失败/Stop 后是否保留原草稿，是否存在晚到发送。
- 扫描件图像是否实际进入模型图片块，而非只有文字占位。
- 研究是否被 MCP/CLI/未授权联网替换，是否串用搜索凭据。
- 工具失败、重复请求和达到预算是否产生虚假完整报告或多收费请求。
- 保存、刷新与重试是否保留本轮研究身份及来源。

## Task 1: 文档解析与发送

- [ ] 新增 `apps/desktop/src/lib/documentInput.ts` 与测试：范围解析、渲染预算/取消/清理、真实派生 File。
- [ ] 新增临时 File 选项 store 与 PDF 选项组件，接入 Composer/Welcome；中文标签集中。
- [ ] Chat 上传原件和选定页面，Agent 注入对应图片；准备先完成，失败保留草稿，Stop 不发模型。测试实际图片块及文件/页码关系。
- [ ] 用 busboy 有界解析真实 multipart，保留重复文件及NUL字节；实际 Hono/SQLite 回归确认四个原件/页面身份及字节，客户端拒绝不完整回执。

## Task 2: 研究执行器

- [ ] 新增共享研究契约与 `apps/sidecar/src/agent/research.ts`，通过现有 `ToolCallingAdapter` 与 `executeTool` 执行。
- [ ] 覆盖成功规划/检索/阅读/报告、无来源、失败、重复、取消、预算、未知工具和受控工具源。
- [ ] 接通 protocol、Sidecar handler、desktop client/hook；研究不走 CLI/ACP 或 SDK resume。

## Task 3: 研究入口与持久化

- [ ] 模式菜单加入研究入口，发送解析 `/research`，保留显示问题与研究标记；欢迎页移交不丢标记。
- [ ] 重试/编辑继承该轮策略，来源步骤沿用已有持久化。禁用不适用模型与未联网入口并说明原因。
- [ ] 添加浏览器组件回归，真实展开默认/悬停/选中/键盘态。

## Task 4: 完整验证与桌面验收

- [ ] Bun/类型/Biome、前端与 host Sidecar 编译；新增失败先修复，不削弱现有测试。
- [ ] 在独立合成环境实际打开桌面验证，保留脱敏证据；真实收费服务未测就明确写未测。
- [ ] 更新相关主题与会话链接，清理本轮临时数据，保留应用和既有用户内容。
