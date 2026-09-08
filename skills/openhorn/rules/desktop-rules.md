# Desktop Rules

> 每条断言都对着代码核过（2026-07-28）。旧版本这里整节都在描述一套已被删除的 task-backed agent UI（`DesktopAgentTaskCard` / `DesktopAgentPlanPanel` / `DesktopAgentToolApprovalPanel`），那些文件全仓已无引用。

## 组件树

`apps/desktop/src/components/` 分五组：`app`（外壳布局与侧栏）、`auth`、`chat`、`settings`、`theme`。桌面端组件树是独立的，不与其它前端共享 —— 不要假设某个组件在别处有对应实现。

外壳只有两个文件：`app/DesktopShellLayout.tsx`（左右分栏 + 顶部拖拽带）和 `app/DesktopLeftSidebar.tsx`。

## 侧栏「项目」

- 项目 = 本地文件夹（`projects` 表，`conversations.project_id` 归属）。状态在 `stores/projectStore.ts`：`activeProjectId` 是**下一个新会话的作用域**，跟随所选会话的 `projectId`（store 订阅 chatStore），点项目名 = 设作用域 + 打开欢迎页
- 挂在项目下的会话，agent 回合前 `useSidecarAgentRun` 用 `resolveProjectRootForConversation` 取项目目录，调 `sidecarStore.ensureWorkspace(root)` 推给 sidecar 作 cwd；**不传 root 时只读 localStorage 的默认工作区，绝不沿用 store 里上一轮的项目目录**。项目目录不可用（被删/移动）时拒跑并报 `chat.run.projectRootUnavailable`
- 空会话复用按项目作用域隔离（server `findReusableBlankConversation` 与 chatStore 双侧守卫）
- 侧栏顺序：置顶 → 定时任务组 → 项目 → 会话（今天/昨天/更早）。项目段放在无上限的会话列表之上，否则会被推到几千像素之外

## 中文文案

**唯一允许出现中文用户文案的地方是 `src/lib/i18n/`**（`agent.ts` 等字典）。组件里禁止内联中文字符串；字典查不到时返回 `null`，调用方显式降级为不渲染，**禁止 fallback 字符串**。工具名、状态机字面量（`Bash` / `Search` / `Approved`）一律保留英文。

## 流式输出

- 平滑输出逻辑在 `lib/textStreamSmoother.ts`；渲染走 `chat/DesktopStreamingMarkdownMessage.tsx`
- chat store 处理 agent 结果时**优先采用实时执行流，而不是轮询回退路径**；改流式相关代码时保持这一优先级

## Agent 运行的渲染

- `chat/DesktopAgentRunPanel.tsx` 是执行过程（工具调用步骤）的渲染器；单步文本折叠走 `DesktopInlineClampStep.tsx`，超过 3 行用展开/收起，**禁止按字符硬截断**
- 工具名展示走 `presentToolLabel`：`mcp__<server>__<tool>` 必须在模糊匹配之前解析；`ToolSearch` 是延迟加载的内部工具，单独标为 `Tool lookup`
- 工具参数里的 URL 抽取走 `lib/agentToolSummary.ts` 的 `extractToolUrls`，同时兼容 `urls: string[]`、`urls: string`、`url: string` 三种形态
- **不存在独立的「重试 / 继续」按钮** —— 消息气泡下方的 `DesktopMessageActionBar.tsx` 已覆盖

## Sidecar 接线

- `lib/tauriBridge.ts` 动态 import Tauri API；纯 Vite dev 模式下返回 `null`
- `lib/sidecarClient.ts` 把 sidecar 事件投影成流式事件形态
- `stores/sidecarStore.ts` 状态机：`idle → starting → connecting → ready`，另有 `unsupported` / `error` 两个终止态
- `hooks/useSidecarAgentRun.ts` 是发起 sidecar 回合的唯一入口。它对 **anthropic 和 openai 两种协议**都加载 MCP server（分别落到 `runClaudeAgent` 和 `runDirectAgent`）；`targetMcpServer` 用于 `/<server>` 斜杠命令，只挂载被点名的那一个
- skill 来源是**磁盘扫描**（`~/.cc-switch`、`~/.claude`、`~/.agents`、`~/.codex`、`~/.gemini` 下的 `skills/`）减去 `~/.openhorn/skills-enabled.json` 里的禁用名单，**不读数据库的 `skills` 表**

## macOS 窗口

走 `TitleBarStyle::Overlay`，没有原生标题栏，拖拽区必须逐块声明 `data-tauri-drag-region`，漏了不会报错。见 `references/gotchas.md#macos-窗口拖不动`。

## 测试

`apps/desktop/src/bun-test.d.ts` 只声明了 `toBe` / `toBeDefined` / `toEqual` / `toHaveLength` / `toMatchObject`。用 `.not` / `toBeNull` / `toBeLessThanOrEqual` 会让 `tsc` 挂掉 —— 改用 `.toBe(true)` 加显式比较表达式。
