# 桌面消息列表虚拟化（长会话渲染性能）

## Goal

桌面端 `DesktopChatArea` 目前一次性渲染整个会话的全部消息（`groupedMessages.map(...)`），每条 assistant 消息还要跑 ReactMarkdown 解析 + 代码块语法高亮。会话达到几百条时，切换会话/首次挂载会明显卡顿——代码里已用 `requestIdleCallback` 延迟高亮来救火，说明痛点已现。目标：只渲染视口内（+overscan）的消息，把长会话的挂载/切换/滚动成本降到与会话长度基本无关，同时**完整保留**现有的流式、自动滚动、复制、slash 面板等行为。

## What I already know

* 主文件 `apps/desktop/src/components/chat/DesktopChatArea.tsx`（~2400 行），消息渲染在 `groupedMessages.map(...)`（约 2242 行附近），分组函数 `groupMessagesByRound`。
* `MessageBubble` 已做 `memo` + 自定义比较，逐行 bail-out 有效；`groupedMessages` 刚改为 `useMemo`（已提交）。
* 已有 `DesktopMarkdownMessage`（memo）、`DesktopStreamingMarkdownMessage` + `textStreamSmoother` 处理流式；代码块高亮用 `requestIdleCallback` 延迟。
* 滚动相关有 `pendingScrollTargetRef`、`useLayoutEffect`/`useEffect`；切换会话时会滚到底部。
* Web 与 Desktop 组件树有意独立——本任务只改 desktop。
* 依赖策略：pnpm；`@tanstack/react-virtual` 尚未安装（web 曾装过 react-query 等已被移除，说明可加运行时依赖）。

## Assumptions (temporary)

* 采用 forward-list（正序）+ 动态测量 + stick-to-bottom，而非 reverse-list。
* 变高行用 `measureElement` 动态测量，流式最后一行增长时重新测量并保持贴底。
* 初期可接受"仅视口内消息挂载 ReactMarkdown"，视口外用占位高度。

## Open Questions

* （见下方一次一个提问）

## Requirements (evolving)

* 长会话（数百条）切换/挂载不再明显卡顿；滚动流畅。
* 保留现有 UX（方案 A）：发送/重试/编辑 → 问题钉视口顶部 + 流式期间重钉；切换会话跳到底部；复制按钮、slash 面板、键盘焦点、工具运行面板。
* 变高内容（markdown/代码块/工具面板/附件/图片）动态测量正确，无明显跳动/闪烁。

## Acceptance Criteria (evolving)

* [ ] 打开数百条消息的会话，DOM 只挂载视口内（+overscan）的轮次组；首屏明显快于现状。
* [ ] 发送/重试/编辑后，目标用户消息滚动并钉到视口顶部；回答流式生成时问题保持钉顶（行为与现状一致）。
* [ ] 切换会话一次性跳到底部（与现状一致），无错乱跳动。
* [ ] 变高内容（代码块延迟高亮、AgentRunPanel 展开、异步图片、流式增长）触发自动重测量，无明显跳动/闪烁。
* [ ] 流式行与钉顶目标行在动画期间始终挂载（不被虚拟化卸载导致 smoother 重置/anchor 丢失）。
* [ ] post-stream 全量 `loadMessages`（数组身份替换）后列表稳定，不错位、不重复滚动。
* [ ] 复制/编辑/重试、slash 面板、工具运行面板等交互不回归。
* [ ] desktop tsc 0 错、`bun test` 通过、biome 干净。

## Definition of Done (team quality bar)

* 新增/更新测试：可单测的纯逻辑（`groupMessagesByRound`→虚拟索引映射、`getItemKey` 稳定性、目标组 index 定位、"是否需强制挂载目标/流式行"的判定）。
* tsc / biome 绿；desktop 测试通过。
* 真机（`pnpm dev` 起 server+desktop，测试账号 123@qq.com）验证：长会话滚动、发送钉顶、流式重钉、切换会话、复制、代码块高亮后不跳动。
* 风险可回滚（改动集中在消息列表渲染层；保留旧路径 diff 可快速 revert）。

## Implementation Plan (小步提交)

* **PR1 — 脚手架 + 基础虚拟化**：加依赖 `@tanstack/react-virtual@^3.14.5`；将 `groupedMessages.map` 替换为 `useVirtualizer`（count=组数，`getItemKey=group.key`，`estimateSize`，`measureElement`，`overscan≈6`，`useFlushSync:false`）；渲染沿用现有 `renderMessageRow`/`MessageBubble`（保持引用相等 memo）。仅保证"能滚、能显示"，滚动定位暂用 `scrollToIndex`。
* **PR2 — 滚动 UX 对齐（方案 A 核心）**：用 virtualizer 复刻现有两种行为——切换会话 → 跳底部；发送/重试/编辑 → `scrollToIndex(targetGroupIndex,{align:'start'})` 且流式期间在 layout effect 重钉直到稳定。确保流式行 + 钉顶目标行始终在渲染范围内（overscan/强制 range）。替换 `pendingScrollTargetRef`/`messageAnchorRefs`/`scrollTop=scrollHeight` 逻辑。
* **PR3 — 变高与边界**：验证 `measureElement` 对代码块延迟高亮、`AgentRunPanel`（`<details>`+ResizeObserver clamp）、异步图片、流式增长的自动重测；处理 post-stream `loadMessages` 身份替换、编辑态 textarea 行高、agent-mode（`isFlatAgentAssistant`）路径；补纯逻辑单测 + 真机验证 + 必要注释。

## Out of Scope (explicit)

* Web 端（`apps/web`）不改。
* 不做"仅高亮最后 N 条"以外的高亮策略重构（已单独提交过高亮优化）。
* 巨型组件整体拆分（#16，另立任务）。

## Research References

* [`research/current-architecture.md`](research/current-architecture.md) — 现有渲染/滚动/流式架构（`file:line` 全覆盖）
* [`research/react-virtual-streaming-chat.md`](research/react-virtual-streaming-chat.md) — `@tanstack/react-virtual` v3 流式聊天虚拟化方案

## Research Notes

### 关键发现（改变方案设计）

1. **当前不是"贴底跟随"**：真实 UX 是"把刚发送/重试/编辑的**用户消息钉到视口顶部**，回答生成时持续重钉"（`DesktopChatArea.tsx:1086-1116`，`pendingScrollTargetRef`+`messageAnchorRefs`）。切换会话时一次性跳到底部。无"贴底"、无"用户上滑停止跟随"、无滚动位置保存、无 scroll-to-bottom 按钮。
2. **变高且异步**：markdown、代码块（`requestIdleCallback` 延迟高亮，高度后置settle）、`AgentRunPanel`（`<details>`+`ResizeObserver`+二分 clamp）、异步图片、流式 smoother 持续增高。任何虚拟化必须支持动态测量 + 异步重测（`measureElement` 的 ResizeObserver 自动处理）。
3. **`MessageBubble` 的引用相等 memo**（`prev.message===next.message`）与虚拟化兼容——store 对未变行返回同一对象引用。
4. **真虚拟化的真实代价**：卸载视口外行 → 原生 **Cmd+F 全会话查找**、**跨消息文本选择**只在已渲染行生效（仓库无自研 find/jump，纯靠原生）。这是标准取舍，需用户确认是否可接受。
5. **`@tanstack/react-virtual@^3.14.5`（core ≥3.17）** 有一等 chat 模式：`anchorTo:'end'`、`followOnAppend`、`isAtEnd`、`scrollToEnd`、`takeSnapshot`。React 19 需 `useFlushSync:false` + 稳定 `getItemKey`（按 message id）。~10KB，仅 peer react/react-dom。

### Feasible approaches

**Approach A — 虚拟化 + 保留"问题钉顶"UX**（最忠实）
* react-virtual 动态测量；发送/重试/编辑时 `scrollToIndex(userIndex,{align:'start'})` 并流式期间重钉，替换现有 `scrollHeight`/anchor 逻辑。
* Pros：UX 与现状一致；性能大幅提升。
* Cons：布线最多（要把 anchor 逻辑接进 virtualizer，保证目标行/流式行始终挂载）；丢失视口外 Cmd+F/跨消息选择。

**Approach B — 虚拟化 + 切换为"贴底跟随"chat UX**（最省代码）
* 用 `anchorTo:'end'`+`followOnAppend`+`isAtEnd`+`scrollToEnd`+"跳到最新"按钮；库自动处理贴底/prepend 稳定/抖动。
* Pros：代码量最小、最稳；现代聊天手感。
* Cons：**改变现有"滚到我的问题"行为**为贴底；同样丢失视口外 Cmd+F/选择。

**Approach C — 窗口化 markdown（不做真虚拟化）**（最保守）
* 所有行仍挂载，但只对最近 N 条（+近视口）渲染完整 markdown/高亮，更早的行降级为轻量纯文本。
* Pros：保留原生 Cmd+F、跨消息选择、精确滚动行为；无测量抖动；最易推理。
* Cons：DOM 仍随会话增长（超长会话仍有上限压力）；性能提升小于真虚拟化；旧行观感略有差异。

## Decision (ADR-lite)

**Context**: 长会话一次性渲染全部消息 + markdown/高亮导致挂载/切换卡顿。需在滚动 UX 忠实度、代码量、原生 Cmd+F 之间取舍。
**Decision**: **方案 A** —— 用 `@tanstack/react-virtual` 做真虚拟化，并**保留现有"把用户消息钉到视口顶部、流式期间重钉"的 UX**。用户已确认丢失视口外原生 Cmd+F/跨消息选择**可接受**。
**补充决定（实现细节，非产品决策）**：
* **虚拟化单元 = 轮次组（group）**，与 `groupedMessages` 一致；`getItemKey = group.key`（由 message id 组成，稳定）。"钉问题到顶" = `scrollToIndex(groupIndex, { align: 'start' })`（用户消息在组顶，天然匹配）。
* **单一虚拟化路径、默认全程启用**（不做 N 条阈值双路径，避免漂移；react-virtual 对短列表无负担）。
* **不新增** "跳到最新" 按钮 / 贴底跟随 / 滚动位置保存（现状没有，保持范围收敛）。
**Consequences**: 性能与会话长度基本解耦；换来视口外 Cmd+F/跨消息选择失效（已接受）。需保证流式行与钉顶目标行在动画期间始终挂载（靠 overscan + 必要时强制包含目标 index）。风险点：异步测量抖动、post-stream 全量 `loadMessages` 身份替换、编辑态行高变化——列入 PR2 专项处理。

## Technical Notes

* 版本下限关键：必须 `@tanstack/react-virtual@^3.14.5`，否则 chat API 缺失、退回手动模式。
* 需保证：流式行、以及"钉顶目标行"在动画期间始终挂载（A 尤其）。
* 可加渐进开关/阈值（如会话 > N 条才启用虚拟化），降低回归风险、便于回滚。
