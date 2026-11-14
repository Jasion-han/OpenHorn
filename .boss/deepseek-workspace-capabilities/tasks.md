# 实施与并行写集

Spec: docs/superpowers/specs/2026-11-14-deepseek-workspace-capabilities.md
Plan: docs/superpowers/plans/2026-11-14-deepseek-workspace-capabilities.md

## Repo Preflight

main，工作区约258处已有修改；pnpm9/Bun/TypeScript/Hono/React。已有 Bun 单元、独立进程 SQLite fixture、Playwright/Vite browser scripts。未发现本次检查范围内的 CI workflow。schema 权威为 packages/db/src/schema/index.ts 和 apps/server/src/db/bootstrap.ts；API 共享类型为 shared/types。无新增外部依赖；主会话离线补充 adapters→shared workspace 依赖。无破坏性迁移，无提交/部署。

## Wave 与契约矩阵

Wave 1 并行实现各独立领域。每项先复现缺失行为，再实现最小功能，Bun + typecheck 验证。Stop condition：不兼容既有契约、真实秘密外发、脏改动被覆盖。Wave 2 依赖 Wave1，主会话串行接通中央入口和文案并做实际浏览器/集成验证。

| Owner | 写集 | 必须证明 |
|---|---|---|
| Search | shared/search/*、server/searchService.ts及测试、sidecar/direct.ts及测试 | 固定官方端点；Tavily/DDG兼容；可选Fetch与DeepSeek选择 |
| OCR | server/libraryService.ts、libraryParser.ts、libraryOcr.ts、routes/library.ts、shared/library.ts、shared/types/library.ts、desktop/library/*、lib/libraryApi.ts及相关测试 | 默认不联网，显式同意，原件保留，租约/CAS不失效 |
| Import | server/importService.ts、deepseekImport*.ts、routes/dataTransfer.ts、importRecordsService.ts、desktop/import/BackupFileImportRow.tsx、ImportHistoryCard.tsx及测试 | manifest正确识别；安全ZIP；逐会话事务；去重与结果诚实 |
| Native Chat | adapters/*、shared/types/provider-chat.ts、server/messageService.ts、sidecar/chat.ts、events.ts及相关测试 | 旧接口兼容；引用/签名/拒答；双Chat路径 |
| Main integration | shared/types/index.ts、desktop/i18n/agent.ts、DB schema/bootstrap、sidecar index/protocol/client、desktop Chat入口、设置页、设置解析、types/chat.ts、serverApi.ts、模型预设、browser验证 | 跨域DTO与实际入口接通；类型检查和构建 |

共享文件由 Main 独占。其他 owner 如需共享文件改动，发出精确类型/文案/接线要求，不直接编辑。除主会话补充内部 workspace 依赖外，不改 package.json/锁文件。agent 编辑当前工作区的指定文件，不恢复任何已有修改。

## Blast Radius 与风险

跨多模块，可逆增量更改；用户当前指令已授权按推荐路线逐步优化。仅 additive schema，已存在备份/身份/安全边界不放松；不执行发布、提交、付费调用或不可逆数据操作。原生模式、OCR 和独立工具均显式可选。
