# 工作台原生桌面演示记录

2026-11-06，用户明确授权重启桌面端并在可见窗口里跑流程。本轮使用真实 OpenHorn.app、真实本地服务与用户已配置的默认模型，不是前一轮的浏览器 mock。

## 可见入口与主要文件

| 功能 | 桌面入口 | 前端 | 后端 |
|---|---|---|---|
| 任务配方 | 左侧工作台 → 任务配方 | [RecipePanel](../apps/desktop/src/components/workbench/RecipePanel.tsx)、[RecipeEditor](../apps/desktop/src/components/workbench/RecipeEditor.tsx) | [recipeService](../apps/server/src/services/recipeService.ts)、[recipes routes](../apps/server/src/routes/recipes.ts) |
| 产物工作台 | 已保存助手回复下的收藏按钮；工作台 → 产物 | [ArtifactPanel](../apps/desktop/src/components/workbench/ArtifactPanel.tsx)、[ArtifactSaveDialog](../apps/desktop/src/components/workbench/ArtifactSaveDialog.tsx) | [artifactService](../apps/server/src/services/artifactService.ts)、[artifacts routes](../apps/server/src/routes/artifacts.ts) |

统一入口接线在 `App.tsx`、`DesktopLeftSidebar.tsx` 与 `DesktopMessageActionBar.tsx`；类型与数据表分别在 shared/types 和两份数据库定义中。

## 实际操作结果

1. 退出旧桌面端，重启旧服务端。新 `/recipes`、`/artifacts` 路由可读；启动新版桌面应用后侧栏出现“工作台”。
2. 新建“演示配方：三句话介绍”，任务说明含 `{{topic}}`，参数显示名“主题”，默认值“AI 工作台”，关联 OpenHorn 项目。
3. 首轮真实运行发现默认渠道未绑定新会话，没有调用模型；定位后修复，再次运行真实得到三句话回复并保存。成功模型运行一次，指令不要求文件操作或联网。
4. 用回复下“收藏为产物”保存“演示产物：AI 工作台介绍”。版本 1 保留模型原文。
5. 编辑为版本 2，添加标题与说明；随后切回版本 1，确认旧版未被覆盖。
6. 通过原生保存对话框，将版本 1 导出到 `/Users/han/Downloads/演示产物：AI 工作台介绍-v1.md`，文件存在且为 210 字节。
7. 追加版本 3，加入 `html-ui` 交互卡片。在原生 WKWebView 的隔离预览中点击“点我 +1”，点击次数由 0 变为 1。
8. 打开配方定时表单，显示执行频率与时间；没有创建新的长期定时任务。演示前后原有任务均为 2 条、0 条启用。
9. 再次退出并重开最终应用包，确认配方与产物三个版本仍在。窗口最终停在工作台的产物版本 3，侧栏恢复展开，供用户继续查看。

HTML 计数器的运行时数值会随 iframe 重建初始化；本轮验证的是产物内容和版本跨重启保存，不宣称任意 HTML 内部状态都能跨重启恢复。

## 实机发现并修复

- `validateReferences` 在没有显式渠道时原本返回空对象，`prepareRecipe` 因而创建了 channel/model 皆空的会话。新增执行阶段的默认解析：取当前用户已启用的全局默认渠道和严格默认模型，绑定完整对；定时任务快照也固定完整对。没有可用默认模型时在创建执行状态前返回 `channel_not_found`，配方仍可编辑保存。
- 新增默认渠道执行、无默认渠道提前拒绝两项回归。先确定性复现原代码返回 null 渠道，再验证修复。
- 手动编辑的产物版本没有来源引用，并不意味着原会话被删除。将提示改为“此版本未关联来源会话，产物副本独立保存”。

验证：Server 全套 **461 项通过、0 失败**；Server 类型检查、相关文件 Biome 和最终 macOS debug app 构建通过。其余包沿用此前已通过的 638 Desktop、331 Sidecar、53 Shared；新增修复没有改动这些包的运行逻辑，桌面仅调整一条提示文案。全仓类型/格式检查结果在最终交付前核对。

本轮保留上述演示配方、产物与导出文件，没有删除既有会话或改动真实定时任务。首次失败准备的空演示会话也没有通过数据库手工清理。未 Git 提交或推送。
