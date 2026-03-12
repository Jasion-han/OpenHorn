# Agent Channel Agent-Check Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Channels 设置页增加“Agent 兼容性检查”，可选择 `modelId` 对指定渠道做一次真实 Claude Agent SDK 探测，并把成功/失败结果清晰展示（失败直出真实错误，不做自动 fallback）。

**Architecture:** Web 在渠道卡片上增加入口按钮与弹窗；Server 新增 `POST /channels/:id/agent-check` 调用一个最小化的 Claude Agent SDK probe（`permissionMode: 'plan'`, `maxTurns:1`, 短 prompt + 超时 abort）。

**Tech Stack:** Next.js + Mantine（web）；Hono（server routes）；Bun test；Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）。

---

### Task 1: Server Probe 评估器（可单测）

**Files:**
- Create: `apps/server/src/services/channelAgentCheckService.ts`
- Test: `apps/server/src/services/channelAgentCheckService.test.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test';
import { evaluateAgentProbe } from './channelAgentCheckService';

async function* gen(...events: any[]) {
  for (const e of events) yield e;
}

test('evaluateAgentProbe: success when first text arrives', async () => {
  const result = await evaluateAgentProbe(gen(
    { type: 'meta' },
    { type: 'text', content: 'OK' },
    { type: 'done' },
  ));
  expect(result).toEqual({ success: true });
});

test('evaluateAgentProbe: fail when error arrives', async () => {
  const result = await evaluateAgentProbe(gen(
    { type: 'meta' },
    { type: 'error', content: 'boom' },
  ));
  expect(result).toEqual({ success: false, error: 'boom' });
});

test('evaluateAgentProbe: fail when done without output', async () => {
  const result = await evaluateAgentProbe(gen(
    { type: 'meta' },
    { type: 'done' },
  ));
  expect(result.success).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/channelAgentCheckService.test.ts`  
Expected: FAIL（模块/函数不存在）。

**Step 3: Write minimal implementation**

实现 `evaluateAgentProbe(events)`：
- 忽略 `meta`
- 遇到 `text` 且 `content` 非空 => `{ success:true }`
- 遇到 `error` => `{ success:false, error }`
- 流结束（或 `done`）但没有任何 `text` => `{ success:false, error:'未获得任何输出...' }`

**Step 4: Run tests to verify it passes**

Run: `cd apps/server && bun test src/services/channelAgentCheckService.test.ts`  
Expected: PASS

**Step 5: Commit**

```bash
git add apps/server/src/services/channelAgentCheckService.ts apps/server/src/services/channelAgentCheckService.test.ts
git commit -m "test: add agent-check probe evaluator"
```

### Task 2: Server 真实 agent-check（含超时 abort）

**Files:**
- Modify: `apps/server/src/services/agentSdk.ts`
- Modify: `apps/server/src/services/channelService.ts`
- Modify: `apps/server/src/services/channelAgentCheckService.ts`

**Step 1: Add SDK options passthrough**

在 `runClaudeAgentSdk` 的 options 增加：
- `permissionMode?: 'plan' | 'bypassPermissions' | ...`
- `allowDangerouslySkipPermissions?: boolean`
- `maxTurns?: number`

并保持默认行为不变：
- 默认 `permissionMode: 'bypassPermissions'`
- 默认 `allowDangerouslySkipPermissions: true`（仅在 bypass 时需要）

**Step 2: Expose channel credentials resolver**

在 `channelService.ts` 新增导出函数（不要求 defaultModel）：
- `getChannelRuntimeCredentialsById(userId, channelId) -> { channel, apiKey }`

用于 agent-check 获取 `apiKey` 与 runtime `baseUrl`。

**Step 3: Implement real checkChannelAgentCompatibility**

在 `channelAgentCheckService.ts` 新增：
- `checkChannelAgentCompatibility(userId, channelId, modelId) -> { success, error? }`

逻辑：
- 校验 `modelId` 非空
- 取 `{ channel, apiKey }`
- 创建 `AbortController` + `setTimeout`（15s）abort（reason: `'agent_check_timeout'`）
- `for await` 消费 `runClaudeAgentSdk(...)` 输出，调用 `evaluateAgentProbe` 逻辑（或复用其实现）
- 超时返回明确错误（不 fallback）

**Step 4: Commit**

```bash
git add apps/server/src/services/agentSdk.ts apps/server/src/services/channelService.ts apps/server/src/services/channelAgentCheckService.ts
git commit -m "feat(server): add channel agent-check probe"
```

### Task 3: Server 路由 `POST /channels/:id/agent-check`

**Files:**
- Modify: `apps/server/src/routes/channels.ts`

**Step 1: Implement route**

新增：
- 读取 body `{ modelId }`
- 调用 `checkChannelAgentCompatibility(user.id, channelId, modelId)`
- 返回 JSON `{ success, error? }`

**Step 2: Commit**

```bash
git add apps/server/src/routes/channels.ts
git commit -m "feat(server): add channels agent-check route"
```

### Task 4: Web API 封装

**Files:**
- Modify: `apps/web/src/lib/api.ts`

**Step 1: Add api.channels.agentCheck**

签名：
- `agentCheck(id: string, data: { modelId: string })`

返回：
- `{ success: boolean; error?: string }`

**Step 2: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): add channels agentCheck api"
```

### Task 5: Web UI 入口 + 弹窗 + 内联错误展示

**Files:**
- Modify: `apps/web/src/components/settings/ChannelSettings.tsx`

**Step 1: Extend notice shape**

将 `channelNotice` 类型扩展为可选 `title`（避免 agent-check 错误显示成“同步失败”）。

**Step 2: Add ActionIcon**

在渠道卡 actions 添加 `Agent 检查` 按钮（Tabler `IconRobot`），点击打开弹窗并绑定当前渠道。

**Step 3: Add modal**

弹窗内容：
- 当 `channel.models.length > 0`：Select 选择 `modelId`
- 否则：TextInput 手动输入 `modelId`
- “开始检查”触发 `api.channels.agentCheck(...)`
- 成功 toast + 清 notice
- 失败写入 notice：`{ kind:'error', title:'Agent 检查失败', message:error }`

**Step 4: Commit**

```bash
git add apps/web/src/components/settings/ChannelSettings.tsx
git commit -m "feat(web): add channel agent-check ui"
```

### Task 6: Manual Verification + Push

**Files:**
- (none)

**Step 1: Run**

Run server: `pnpm --filter server dev`  
Run web: `pnpm --filter web dev`

手动验证：
- 对一个已知可用渠道：Agent 检查成功（toast）
- 对不兼容 relay：15s 内失败并展示真实错误（内联卡片）
- 选择不同 `modelId` 能触发不同结果

**Step 2: Push**

```bash
git push
```

