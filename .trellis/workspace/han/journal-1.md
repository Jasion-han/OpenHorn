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
