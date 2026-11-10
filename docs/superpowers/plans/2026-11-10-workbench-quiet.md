# Workbench quiet defaults plan

**Goal:** 按用户纠正减少默认可见操作，次要能力按需展开。
**Spec:** `docs/superpowers/specs/2026-11-10-workbench-quiet-design.md`
**Architecture:** 现有 React/Radix 组件与本地显示状态，不改变 API。

- [x] RecipePanel：编辑/历史/定时移回更多，参数预览收纳绑定和说明，保留单一运行按钮。
- [x] ArtifactPanel：更多收纳编辑/导出/原文切换/版本入口；默认预览，编辑只展示保存/取消。
- [x] ReviewWorkspacePanel/ReviewDataset/ReviewRuns：统一更多菜单，设置默认隐藏，主按钮先选择再执行，记录默认折叠，阻塞原因可见。
- [x] 浏览器验证默认隐藏与展开、所有已有功能/草稿保护/显式模型调用；运行桌面单测、类型/格式、原生构建并实际查看。
- [x] 保存本轮结果和修正后的长期约定；不提交推送。
