# Journal - han (Part 1)

> AI development session journal
> Started: 2026-05-03

---



## Session 1: 深色代码块修复、sidecar 重试交错修复、MCP 类型归一化、Full Access 全局持久化与 composer 文案打磨

**Date**: 2026-07-04
**Task**: 深色代码块修复、sidecar 重试交错修复、MCP 类型归一化、Full Access 全局持久化与 composer 文案打磨
**Package**: agent
**Branch**: `main`

### Summary

修复深色模式代码块语法高亮过暗(ThemeListener 补发主题事件);修复 agent 重新生成时新旧 run 输出逐字交错(run 所有权守卫);归一化 MCP 服务器 type 使 Claude Agent SDK 能注册 npx/stdio 服务器;Full Access 开关提升到 desktopShellStore 全局持久化;配套提交 sidecar skills/MCP test、server 附件 meta 同步、桌面 skills UI 等既有改动;composer 底栏文案统一为首字母大写英文。全部已推送 origin/main。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0004548` | (see git log) |
| `ac87622` | (see git log) |
| `abaddc5` | (see git log) |
| `67fb1df` | (see git log) |
| `bb314e6` | (see git log) |
| `64298dd` | (see git log) |
| `6eec2f4` | (see git log) |
| `0cf0f2e` | (see git log) |
| `6d9c2c9` | (see git log) |
| `ffbe802` | (see git log) |
| `25f6165` | (see git log) |
| `ddebc04` | (see git log) |
| `c58ed39` | (see git log) |
| `327fd37` | (see git log) |
| `743b9ee` | (see git log) |
| `e878f2a` | (see git log) |
| `ab65819` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: 会话切换性能优化：代码块延迟高亮

**Date**: 2026-07-04
**Task**: 会话切换性能优化：代码块延迟高亮
**Package**: agent
**Branch**: `main`

### Summary

切换到含大量长代码块的会话时主线程被 Prism 同步高亮阻塞，画面卡顿。将代码块拆为 memo 化的 CodeBlock：首帧渲染布局一致的纯文本占位使会话立即可见，挂载后经 requestIdleCallback + startTransition 在空闲时升级为高亮版并在卸载时清理调度；DesktopMarkdownMessage 按 content memo 化避免重复解析。核验并修复占位/高亮行高不一致(1.7 vs 1.5)导致的点亮跳动。已推送 origin/main。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `6fe6427` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: 延迟高亮调优：小块首帧同步高亮 + idle 兜底 timeout

**Date**: 2026-07-04
**Task**: 延迟高亮调优：小块首帧同步高亮 + idle 兜底 timeout
**Package**: agent
**Branch**: `main`

### Summary

上一任务的延迟高亮引入可见闪烁：切到含代码会话时代码先无色、约1秒后才上色，连1行小块也闪。根因为 requestIdleCallback 未设 timeout 被繁忙主线程拖到~1s，且所有块无差别延迟。修复：小代码块(≤12行且≤2000字符)首帧同步高亮不闪(抽出纯函数 shouldHighlightEagerly + 惰性初值)，大块仍延迟但 idle 加 200ms 兜底 timeout 把窗口压到≤200ms。已推送 origin/main。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `9c7c789` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: Agent 质量深度优化：审计→实施→精简

**Date**: 2026-08-28
**Task**: Agent 质量深度优化：审计→实施→精简
**Package**: agent
**Branch**: `main`

### Summary

五维度审计（Memory/RAG/Skill-Tool/错误恢复/Multi-Agent）→ 12项优化实施（重试策略/MCP连接池/上下文截断/FTS5搜索/Token budget/Checkpoint/Circuit breaker/会话摘要/文档RAG/桌面端搜索接通）→ 对抗性审查去除过度设计（回滚意图路由和trace，简化连接池/breaker/摘要/budget/RAG）

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b6846d4` | (see git log) |
| `342c4d2` | (see git log) |
| `3253cb9` | (see git log) |
| `dbf1beb` | (see git log) |
| `da6ac1c` | (see git log) |
| `d4a29a6` | (see git log) |
| `dcde6d7` | (see git log) |
| `3d513ee` | (see git log) |
| `b950a6f` | (see git log) |
| `0fa830c` | (see git log) |
| `204336b` | (see git log) |
| `e0986e1` | (see git log) |
| `8591ade` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: 定时任务隐式准时触发 + 每次独立会话 + 执行中蓝点

**Date**: 2026-09-02
**Task**: 定时任务隐式准时触发 + 每次独立会话 + 执行中蓝点
**Package**: agent
**Branch**: `main`

### Summary

定时任务从'服务端假标完成'改为真正隐式准时执行：服务端到点建 pending run 并精准重武装定时器；桌面端后台执行器认领 pending run，复用聊天同款 sidecar 管线（credentials/MCP/skills/workspace/systemPrompt/Tavily/历史）执行并经 sync-sidecar 落库，全程静默不跳转，打开会话可见流式过程；抽 sidecarRunSupport 共享模块给聊天与定时任务复用；每次执行建独立会话（forceNew，不复用空会话）；执行中(pending/running)统一蓝色小点。desktop 199 + server 174 测试全绿，已推送 origin/main。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `790c0f5` | (see git log) |
| `9b382a5` | (see git log) |
| `b5123b1` | (see git log) |
| `f0a1b7e` | (see git log) |
| `c1dac7d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: 定时任务会话隐藏出用户聊天列表

**Date**: 2026-09-02
**Task**: 定时任务会话隐藏出用户聊天列表
**Package**: agent
**Branch**: `main`

### Summary

修复定时任务会话漏进用户聊天列表：原先靠 runs 窗口交叉过滤不可靠，改为数据层给 conversations 加 scheduled_task_id 列标记；createConversation/scheduler/route 写入，findReusableBlankConversation 排除；侧栏改按该标记过滤，顶部任务组仍按 runs 渲染可点击查看；bootstrap 迁移回填历史泄漏（run 关联 + 旧执行器无 run 关联者按前缀+标题双条件回填）。已回填本机 8 条会话，浏览器实测聊天列表无泄漏，typecheck + desktop 199 + server 174 全绿，已推 origin/main。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `02a083b` | (see git log) |
| `345ac62` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: 侧栏按项目文件夹分组管理会话

**Date**: 2026-09-08
**Task**: 侧栏按项目文件夹分组管理会话
**Package**: agent
**Branch**: `main`

### Summary

新增 projects 表与 conversations.project_id；服务端项目 CRUD、空会话复用按项目隔离、删除项目原子级联删会话；桌面端 projectStore、侧栏项目段（星标/折叠/移动/加载更多）、欢迎页作用域 chip、项目会话以项目目录作 sidecar cwd；窗口重获焦点刷新列表；运行灯与停止键按实际流式会话显示。顺带修复 ACP 预连接 session id 泄漏导致 Anthropic 回合 exit code 1。真机验证：项目会话 pwd=/Users/han/Project/OpenHorn，普通会话=默认工作区。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `5322a24` | (see git log) |
| `41ee532` | (see git log) |
| `2b5166f` | (see git log) |
| `5cc46d2` | (see git log) |
| `158ffc9` | (see git log) |
| `f306104` | (see git log) |
| `cf93c66` | (see git log) |
| `5b664ce` | (see git log) |
| `f5a4e9b` | (see git log) |
| `6b634e7` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 8: 输入框上下键调出历史消息

**Date**: 2026-09-08
**Task**: 输入框上下键调出历史消息
**Package**: agent
**Branch**: `main`

### Summary

会话输入框 ↑/↓ 按 shell 历史方式翻阅本会话已发送的用户消息：只在光标首/末行触发，翻过最新回到草稿，重复去重，编辑/发送/切会话重置；纯逻辑 lib/composerHistory.ts + 13 单测，浏览器实测 ↑↑↑↓↓ 序列正确。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b415da0` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 9: 回滚快照迁出项目目录 + 死代码清理

**Date**: 2026-09-08
**Task**: 回滚快照迁出项目目录 + 死代码清理
**Package**: agent
**Branch**: `main`

### Summary

快照存储从 <workspace>/.openhorn/snapshots/ 迁到 ~/.openhorn/snapshots/<workspaceSlug>/；旧快照自动迁移、空快照自动清理、每工作区保留20个；删除 Rust 侧 skills 物化死代码（7 个函数/结构体 + TS 4 个导出）；OpenHorn 在用户项目目录的运行时脚印降为零。真机验证：Vorla 的 .openhorn/ 整目录消失，8 个旧快照迁至家目录，Downloads 工作区 pruned 到 20 个。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `52a17ab` | (see git log) |
| `43b15e9` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 10: 回复内文件引用/链接右侧预览面板、外部编辑器打开、tool_start 提前、流式首字符修复、composer 响应式

**Date**: 2026-09-11
**Task**: 回复内文件引用/链接右侧预览面板、外部编辑器打开、tool_start 提前、流式首字符修复、composer 响应式
**Package**: agent
**Branch**: `main`

### Summary

新增右侧预览面板：文件引用走 sidecar fs.read 代码预览+行高亮，http 链接走 Tauri 子 webview 内嵌浏览器（capability 改 webviews:[main]，弹窗期间预截图垫底无闪跳），可拖宽/多标签/收起展开；在编辑器中打开按用户选择记住并跳行；sidecar 三 runtime 在 tool_use 出现即发 tool_start 并按 toolCallId 合并；修复 StrictMode 流式首字符丢失；composer 工具条容器查询收缩。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0090e22` | (see git log) |
| `438d62d` | (see git log) |
| `107ef40` | (see git log) |
| `8919989` | (see git log) |
| `70336b3` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 11: 设置页导入中心：本机来源扫描导入 + 导入历史按部分展示

**Date**: 2026-09-11
**Task**: 设置页导入中心：本机来源扫描导入 + 导入历史按部分展示
**Package**: agent
**Branch**: `main`

### Summary

新增 import_records 表与 /import 路由；server 扫描/导入 Claude Code、Codex、Gemini 的历史会话（幂等、过滤注入与自产会话、归项目）、全局指令（标记段）、提示词模板；桌面端新增导入 tab（按来源勾选批量导入、导入历史两级展开可跳转、需要处理区）、斜杠面板提示词分组；MCP/凭据/备份导入统一写记录；Rust 技能扫描补 Continue/OpenCode、MCP 补 VS Code；修复备份恢复日期 bug。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `7eb7c4e` | (see git log) |
| `db961ae` | (see git log) |
| `620e25d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 12: 导入中心并入数据页 + 技能/MCP 单一归属

**Date**: 2026-09-12
**Task**: 导入中心并入数据页 + 技能/MCP 单一归属
**Package**: agent
**Branch**: `main`

### Summary

去掉独立导入 tab，导入中心并入数据页，备份文件导入作为来源列表最后一行；aggregateScan 改为按 client 归属方单一归属，修掉 cc-switch 符号链接导致的各来源重复计数。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `9cf9aed` | (see git log) |
| `7c7e545` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
