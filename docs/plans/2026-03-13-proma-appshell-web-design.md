# Proma-aligned Web AppShell Design

**Goal:** 在 Web 端将 OpenHorn 的整体布局重构为 Proma 风格的三栏 AppShell：
- **LeftSidebar（最左）**：Chat/Agent 模式切换 + 会话标题列表（A：跟随当前模式显示）+ 底部唯一 Settings 齿轮入口
- **Main（中间）**：只显示当前页面主内容（Chat 只聊天、Agent 只运行、Settings 独立页）
- **RightSidebar（最右）**：项目 Workspace 文件栏（文件树 + 预览 + Add to Context），并且在 **Chat 与 Agent 都显示**

**Non-goals:**
- 不新增额外 Settings 入口（严格保持：只有左侧栏底部齿轮能进入 `/settings`）。
- 不做 “小步微调” 的 shell polish；这里是结构性重构。
- 不引入复杂的 Tab/Split 系统（Proma Electron 的 TabBar/SplitContainer 不在本次范围）。

---

## Layout specification

### Overall frame
- `AppShellLayout` 负责三栏容器与响应式。
- 视觉参考 Proma：外层使用 `bg-gradient-to-br from-background via-background to-muted/20`，每栏内部使用 `rounded-2xl border border-border/50 bg-background/70 backdrop-blur-sm shadow-minimal` 的 Panel 质感。

### LeftSidebar (A: mode-specific list)
- 顶部：模式切换（Chat / Agent），不包含 Settings。
- 中部：
  - 在 `/chat` 路由：显示 Chat 对话列表（复用现有 `ChatAside` 逻辑：新对话、搜索、分组、置顶、上下文菜单）。
  - 在 `/agent` 路由：显示 Agent 会话列表（从 `apps/web/src/app/(app)/agent/page.tsx` 抽离并复用：新会话、搜索、会话菜单）。
- 底部：齿轮按钮跳转 `/settings`（唯一入口）。

### Main content
- `/chat`：仅包含聊天消息区与 composer；不再在右侧显示对话标题列表。
- `/agent`：仅包含 Agent 事件区与 composer；会话列表移至左侧。
- `/settings`：保持独立设置页；左右栏仍可显示（左侧为模式切换 + 空态，右侧为 Workspace 文件栏）。

### RightSidebar (Workspace files)
右侧固定为 Workspace 文件栏，包含：
- Workspace selector（下拉选择，默认值：优先使用 Agent store/默认 workspace 或最近使用）。
- 文件树（懒加载展开目录）。
- 预览区（只读，截断）。
- Context actions：Add/Remove，使选中文件作为 **contextPaths** 参与 Chat/Agent 运行（C）。

---

## Context integration (C)

### Design choice
采用 **路径级 context**（workspaceId + relativePaths），不在 DB 中持久化全文，也不创建 attachments 记录。

运行时（每次发送）把选中文件内容拼为一段 “Project Context” 文本，并作为 **system message** 注入模型请求中：
- Chat：在 `messages/stream` 请求体中附带 `{ workspaceId, contextPaths }`
- Agent：在 `agent/sessions/:id/run` 请求体中附带 `{ contextPaths }`（使用 session 的 effective workspace cwd 读取）

### Limits & safety
- 仅允许读取 workspace.cwd 下的路径（防止 `../` 穿越）。
- 支持文本/markdown/代码文件；二进制文件仅显示 metadata，不允许加入 context。
- 预览与 context 都做大小/数量限制（例如：最多 20 个文件，总字符数上限，单文件截断），并在 context 中显式标注 `...(truncated)`。

### UX
- 右侧文件树中，对已加入 context 的文件显示选中状态（✓）。
- Chat/Agent composer 底部显示 Context chips（可移除/清空）。

---

## Backend API additions

在 `/workspaces` 下新增 FS API（由 server 读取本机目录）：
- `GET /workspaces/:id/fs/list?path=...`：列目录 children（name/type/size/mtime/relativePath）。
- `GET /workspaces/:id/fs/read?path=...`：读取文本预览（截断）。

并在现有接口中增加 context 参数：
- `POST /messages/stream`：允许 `workspaceId?: string; contextPaths?: string[]`
- `POST /agent/sessions/:id/run`：允许 `contextPaths?: string[]`

---

## Acceptance criteria
- Web 的 `/chat`、`/agent` 结构与 Proma 一致：左侧会话列表、右侧 workspace 文件、中间内容纯粹。
- Settings 仍只有齿轮入口。
- 右侧文件树可展开、可预览，且可 Add to Context；Chat/Agent 发送时会带上文件上下文。

