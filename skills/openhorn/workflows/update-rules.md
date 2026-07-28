# Rule Update Workflow

## Classification Guide

- 长期约束、必须遵循的规则 → `rules/`
- 带有步骤的任务流程 → `workflows/`
- 架构、路由、依赖说明 → `references/`

## Sync Targets

| 变更类型 | 需要更新的文件 |
|---------|-------------|
| 新增/重命名 workflow 或 reference 文件 | `SKILL.md` Common Tasks 路由 |
| 新增 sidecar 安全层 | `rules/sidecar-security.md` |
| 新增桌面端交互规范 | `rules/desktop-rules.md` |
| 新增文案 / i18n 约定 | `rules/project-rules.md` § 文案与数据真实性 |

## Where To Record

- 稳定约束或约定 → `rules/`
- 坑点、架构注意事项 → `references/`
- 有序任务步骤 → `workflows/`
- 任务路由变化 → `SKILL.md`
- 入口路由变化 → `CLAUDE.md`（仓库根目录，唯一入库的那份，冲突时以它为准）
