# 桌面前端性能测量与优化

已根据实测完成两项优化：普通会话历史只渲染可见范围，代码高亮器按需加载。日期分组、置顶与项目原有分页保留；聚焦、菜单和编辑中的行会保留在渲染范围内。未增加依赖、后端接口或数据结构。

## 对照结果

以下为生产构建、相同733px侧栏视口、Chrome全新上下文、CPU减速4倍下的合成数据结果。每个规模/模式各测3次，表格取中位数；它衡量浏览器界面，不包含Rust进程、Sidecar启动或真实网络耗时。

| 指标 | 优化前 | 优化后 |
|---|---:|---:|
| 344会话：应用界面首次可用 | 1.33秒 | 0.59秒 |
| 5,000会话：应用界面首次可用 | 4.25秒 | 0.64秒 |
| 5,000会话：独立侧栏首次可用 | 3.22秒 | 0.46秒 |
| 5,000会话：选中切换到稳定两帧 | 105.1毫秒 | 31.6毫秒 |
| 5,000会话：初始侧栏DOM节点 | 35,020 | 258 |
| 5,000会话：初始实际挂载会话行 | 4,988 | 20 |
| 启动阶段加载的JS（解码后，含测试入口） | 1.87MB | 1.22MB |
| 5,000会话：滚动帧间隔P95 | 34.4毫秒 | 18.4毫秒 |

正常桌面入口的主JS产物也从约1,839kB降至1,192kB，gzip从约585kB降至361kB。344会话的侧栏切换约31–33毫秒，差异不明显，不宣称小列表的所有操作都更快。

首次可用时间在真实组件挂载、数据就绪后两帧记录，早于Playwright定位器查询，避免把测试框架遍历大量DOM的时间算进界面渲染。切换指标包含合成空消息读取和两帧等待，不是标准INP。滚动以每帧改变300px、共30帧测量，不代表所有触控板/显示器的表现。

## 实际改动

- [SidebarConversationGroups](../apps/desktop/src/components/app/SidebarConversationGroups.tsx)复用已有TanStack Virtual，使用稳定会话ID和日期组键，只挂载可见行与预渲染缓冲。祖先项目展开后重测列表偏移，保留焦点、打开菜单和编辑中的行；支持上下方向键、Home和End到达未挂载历史。
- [DesktopLeftSidebar](../apps/desktop/src/components/app/DesktopLeftSidebar.tsx)缓存置顶和日期分组，避免选中状态变化时重新构造全部分组。搜索仍针对完整数据和服务端全文检索，未用截断数据冒充全部历史。
- [DeferredSyntaxCode](../apps/desktop/src/components/chat/DeferredSyntaxCode.tsx)将Prism与主题移至[独立模块](../apps/desktop/src/components/chat/DesktopSyntaxHighlighter.tsx)，共享加载结果。模块等待期间保留完整原文、行号和复制能力；小代码在模块已缓存时仍立即着色，大代码保留原有空闲时高亮策略。
- 工作区文件预览在[预览面板](../apps/desktop/src/components/preview/DesktopPreviewPanel.tsx)中按需载入。面板结构和文件/网页页签生命周期不变；首次查看代码会承担相应模块加载成本，不宣称首次高亮或文件读取本身更快。

## 验证与证据

- [原始基准](audits/2026-11-09/performance/before.json)、[优化后样本](audits/2026-11-09/performance/after.json)、[汇总](audits/2026-11-09/performance/comparison.json)。两侧各12组样本，均无页面错误和非预期请求；入口产物的大小与SHA分别保存在before-build/after-build JSON中。
- 新增4组生产浏览器行为检查：有界DOM与键盘深层导航；滚动期间菜单/编辑行保留；项目展开后的实际视口位置与深层搜索；延迟高亮期间复制字节、高度稳定和主题变化。
- Desktop657项测试、全仓类型和格式检查通过。既有聊天56、工作台25、设置12、附件滚动3、本地路径2、附件预览8个浏览器PASS检查点全部通过，合计110个检查点；其中新增工作区预览首次加载检查。
- macOS debug app打包并重启，原生窗口实点344条真实会话的列表长距离滚动、返回顶部，未出现缺行。真实会话数量仍为344，没有发送新消息或修改历史数据。浏览器基准使用合成API，不调用真实模型。

复查优化后的生产构建与行为：

```bash
OPENHORN_PERF_EVIDENCE=/tmp/openhorn-perf-review OPENHORN_PERF_CHECKS=1 node apps/desktop/scripts/performance.browser.mjs
pnpm --filter desktop exec bun test
pnpm typecheck
pnpm check
```

优化前的生产测试构建保留在本机`/tmp/openhorn-perf-before/build`；复测旧构建时使用`OPENHORN_PERF_REUSE_BUILD=1`，不要用当前源码覆盖它。计时只采用有界视口、无非预期请求的最终样本，调试过程中无效的测试环境样本未纳入报告。

当前仍一次加载全部会话元数据，置顶区未做大规模虚拟化；本轮验证范围为344与5,000条记录。是否需要服务端分页、更多页面拆包或超大置顶区优化，应在相应规模和真实瓶颈出现后再测量。
