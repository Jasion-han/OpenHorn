# DeepSeek 能力提交隔离验收

用户调用 ship-flow，按项目长期授权先同步远端、按功能中文提交并推送。进入本轮时 main 与 origin/main 均为 `ac148453d4aa9afab87ae0f793d53fcfb173d150`，远端无分叉，pull --ff-only 已完成。

## 范围

原工作区包含大量先前未提交改动。本轮按变更块重建提交候选，不将连接恢复、其他设置/导入生命周期、Sidecar 持久化 outbox/CAS、性能优化和 mini-trellis 迁移混入。隔离工作树拥有独立的 workspace 链接，不能通过原目录 node_modules 借用未提交源码。

必要前置仅包含：准备完成快照使用的 messageSaveToken 辅助模块，以及向量初始化修复依赖的同目录 factory 和原有并发回归测试。原工作区文件内容保留。

## 分批

1. `feat(provider): 增加 DeepSeek 应用能力协议与持久化契约`
2. `feat(web): 接入共用 DeepSeek 检索与原生联网交互`
3. `feat(library): 增加显式 OCR 与完整索引租约校验`
4. `feat(import): 支持 DeepSeek 历史导入与稳定去重`
5. `fix(indexing): 共享同目录向量表初始化并保留失败重试`
6. `docs(validation): 记录 DeepSeek 能力优化与隔离提交验收`

## 隔离版本验证

| 范围 | 通过 | 失败 |
|---|---:|---:|
| shared | 171 | 0 |
| server | 529 | 0 |
| desktop | 664 | 0 |
| sidecar | 342 | 0 |

合计 **1706 项 Bun 测试**。TypeScript、Biome、桌面 UI 构建和 Sidecar host 编译通过。浏览器覆盖6组设置/引用/OCR、19项资料库操作与58组实际 Chat 组件回归。

实现阶段原完整工作区的1,787项结果与此隔离版本结果是不同上下文；两者没有互相冒充。隔离版本的机器记录见 `docs/audits/2026-11-14/deepseek/validation.json` 中 isolated_shipping_validation。

## 后续真实桌面验收

用户已要求推送之后真正打开桌面端逐项实践，再修复、复验。本报告中的浏览器结果不等同 Tauri 原生桌面验收；原生操作与后续优化将另行记录。未部署远程服务。
