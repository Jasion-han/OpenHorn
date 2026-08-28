# ACP 丰富事件展示——透传 plan/diff/tool 生命周期/agentInfo/上下文用量到 UI

## Goal

ACP agent 通过 session/update 传回了丰富的执行信息（plan、diff、tool 生命周期、agentInfo、上下文用量），但当前 AgentEvent（9 种变体）和 AgentRunPanel 太简单，全部被丢弃或简化了。用户看不到 agent 在用什么模型、不知道执行到哪一步、看不到文件修改 diff——和 Zed/Cursor 等 ACP client 的体验差距大。

本任务扩展 sidecar → desktop 的事件链路和 UI，让 ACP agent 的执行细节可见。

## What I already know

**信息丢失链路**（摸底确认）：
1. `acp.ts mapAcpUpdate()` 把 tool_call 简化为只取 title → tool_start（丢失 kind/status/locations/rawInput/diff/content）
2. `sidecarClient.ts projectSidecarAgentEvent()` 展平为 `{ eventType, content, toolName }`（无字段承载 diff/locations/plan）
3. `chatStore.ts applyAgentEventToRun()` 只支持 tool_start/tool_result/text/error 四种 step 类型
4. `DesktopAgentRunPanel.tsx` 用 InlineClampStep 渲染——只有名字+摘要，无 diff 预览/状态徽章/文件路径

**ACP 传回但当前丢弃的数据**（来自上个任务的 research/acp-protocol-and-ts-lib.md）：
- `tool_call`: toolCallId、title、kind（read/edit/execute/search/think/fetch）、status（pending→in_progress→completed/failed）、locations[]、rawInput/rawOutput、content[]{type:"diff", path, oldText, newText}
- `tool_call_update`: 增量状态+内容更新（按 toolCallId 合并）
- `plan`: entries[]{content, priority, status}——完整计划列表，每次全量替换
- `usage_update`: used/size/cost{amount,currency}
- `agentInfo`（initialize 响应）: name, version

**扩展点**（摸底确认）：
- `AgentEvent` (`events.ts:1-16`) — 加新变体
- `projectSidecarAgentEvent` (`sidecarClient.ts:181-250`) — 加新 eventType 映射
- `ApiAgentRunStep` (`types/chat.ts:68-82`) — 加新 type + 字段
- `applyAgentEventToRun` (`chatStore.ts:72-122`) — 加新 step 构建逻辑
- `DesktopAgentRunPanel.tsx` — 加新渲染分支

## Decision (ADR-lite)

**Diff 预览**：简单文本对比（红删绿增纯文本块），不引入 Shiki/CodeMirror。
**Plan 位置**：混在步骤列表里作为 AgentRunStep 渲染，不加独立浮动面板。

## Requirements

### 层 1：sidecar AgentEvent 扩展
- 新增 `tool_call_detail` 变体：携带 toolCallId、title、kind、status、locations[]、rawInput、diff?{path,oldText,newText}
- 新增 `plan` 变体：entries[]{content, priority, status}
- 新增 `agent_info` 变体：name、version（从 initialize 响应透传）
- `usage` 变体扩展：加 contextSize（窗口总大小）、cost?{amount,currency}
- `acp.ts mapAcpUpdate()` 改为透传原始数据而非简化

### 层 2：sidecar → desktop 协议扩展
- `projectSidecarAgentEvent` 加新 eventType 映射
- desktop `AgentTaskStreamEvent` 能承载新数据

### 层 3：chatStore 扩展
- `ApiAgentRunStep` 新增 type: `"plan"` / `"tool_detail"`
- `ApiAgentRunStep` 加字段：status?、locations?[]、diff?、kind?
- `ApiAgentRun` 加 agentInfo?{name,version}、contextUsage?{used,size,cost?}
- `applyAgentEventToRun` 处理 tool_call_detail（按 toolCallId 合并 update）、plan（整体替换）

### 层 4：UI 渲染
- tool step 显示 kind 图标 + status 徽章（pending/running/done/failed）
- tool step 的 locations 显示为文件路径 chips
- diff 内容块用简单 old/new 对比渲染（红删绿增）
- plan 作为可折叠的步骤列表渲染（priority 标色、status 标记）
- composer 栏 / 消息元信息显示 agentInfo（agent 名称+版本替代裸二进制名）
- usage 显示上下文占用百分比（used/size）+ 累计费用（如有）

## Acceptance Criteria

* [ ] ACP agent 的 tool call 显示 kind 图标、实时 status 变化、文件路径
* [ ] 文件修改显示 diff 预览（红删绿增）
* [ ] plan 事件渲染为带 priority/status 的步骤列表
* [ ] agentInfo 显示在 composer 或消息元信息里
* [ ] usage 显示上下文占用比例
* [ ] 现有 Claude/Codex/direct runtime 的 agent 面板不受影响（它们不发新事件类型，渲染不变）

## Definition of Done

* bun test 全绿、typecheck、biome 干净
* sidecar 重编译通过
* 真实 claude-agent-acp agent turn 截图验证新 UI

## Out of Scope

* Monaco/CodeMirror 级别的 diff 编辑器
* tool call 的 terminal 类型内容块（实时终端输出）
* session 恢复 / session 管理 UI
* 非 ACP runtime 的事件扩展

## Technical Notes

* 上一个任务的调研（.trellis/tasks/08-16-sidecar-acp-runtime-acp-agent/research/）仍然适用
* 摸底确认的关键文件和行号见 Goal 章节
