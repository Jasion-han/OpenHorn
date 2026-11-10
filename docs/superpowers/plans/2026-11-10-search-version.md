# Search and version implementation plan

**Goal:** 统一搜索定位，以及成果/配方有界版本对比和显式恢复。
**Architecture:** Hono聚合查询及restore端点复用现有CAS服务，shared定义搜索DTO；React复用搜索入口和历史区域，纯文本差异组件限制工作量。
**Spec:** `docs/superpowers/specs/2026-11-10-search-version-design.md`

- [x] 后端：新增unifiedSearchService/routes/search与共享DTO；用户范围、字面关键词、空/长输入、结果限额测试。
- [x] 恢复：recipe/artifact restore服务/路由；隔离测试历史不变、当前版本递增、源删除仍可恢复、跨用户/无效版本/CAS冲突拒绝。
- [x] 前端：纯文本差异helper+组件，历史中确认恢复及失败保留；测试差异重建、边界文本和降级。
- [x] 统一入口：侧栏搜索分组，工作台定向导航与项目定位；验证旧响应/清空/删除/跳转不触发执行。
- [x] 浏览器闭环、相关单测/全量类型格式、构建与原生查看；记录边界，不提交推送。
