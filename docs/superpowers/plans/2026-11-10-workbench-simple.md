# Workbench simple interaction plan

**Goal:** 减少工作台菜单跳转、弹窗叠加和装饰性卡片。
**Architecture:** 复用现有 React/Radix/Zustand。就地历史和草稿确认，评论单工具栏。
**Spec:** `docs/superpowers/specs/2026-11-10-workbench-simple-design.md`

## Scope and verification

- [x] `DiscardChangesNotice.tsx` 替代二级弹窗；接入配方、成果、评论导入与修正，确认显式放弃才清理，Escape 可继续编辑，焦点回到可操作控件。浏览器断言最多一个 dialog。
- [x] `RecipePanel/RecipeHistory`：编辑/历史直接显示、内联历史保留异步取消/重试/只读语义，测试旧版本可读且无写入。
- [x] `WorkbenchView/ArtifactPanel`：精简重复页头和包围层，导出可直接点击；保留版本、预览、编辑和续改行为。
- [x] `ReviewDataset/ReviewWorkspacePanel`：分析方式选择、条件模型、单个主按钮，统计平铺；Jev 关闭/无聊天模型时行为准确。
- [x] 更新既有浏览器验收，运行桌面单测、类型、格式、工作台/评论/Jev 浏览器、原生构建并实际打开。记录当前工作区的实际验证结果，不自动提交推送。
