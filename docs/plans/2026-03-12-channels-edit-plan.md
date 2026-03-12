# Channels Edit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Channels 设置页新增“编辑渠道”能力：预填当前值（含 API Key 掩码），保存后自动同步模型列表，并复用现有 notice 展示错误（不自动 fallback，不暴露 key 明文）。

**Architecture:** Web 侧在 `ChannelSettings` 增加编辑按钮与弹窗；保存时调用 `api.channels.update`，成功后调用 `api.channels.fetchModels`，并复用现有的 notice/toast 逻辑。

**Tech Stack:** Next.js + Mantine；已有 `api.channels.update/fetchModels`。

---

### Task 1: 增加编辑弹窗状态与入口按钮

**Files:**
- Modify: `apps/web/src/components/settings/ChannelSettings.tsx`

**Step 1: Add state + open/close helpers**

新增 state：
- `editOpen`
- `editChannelId`
- `editName/editProvider/editBaseUrl/editEnabled/editApiKey`
- `API_KEY_MASK = '********'`

新增 helper：
- `openEdit(channel)`：预填所有字段；`editApiKey = channel.hasApiKey ? API_KEY_MASK : ''`
- `closeEdit()`

**Step 2: Add edit ActionIcon**

在渠道卡 actions 增加铅笔按钮，点击 `openEdit(channel)`。

**Step 3: Commit**

```bash
git add apps/web/src/components/settings/ChannelSettings.tsx
git commit -m "feat(web): add channel edit modal shell"
```

### Task 2: 保存逻辑（只提交 diff）+ 保存后自动同步模型

**Files:**
- Modify: `apps/web/src/components/settings/ChannelSettings.tsx`

**Step 1: Add diff builder**

实现一个 `buildChannelUpdatePayload(original, form)`：
- 比较 name/provider/baseUrl/enabled，仅将变化字段写入 payload
- `apiKey` 只有在：
  - `editApiKey.trim()` 非空 且不等于 `API_KEY_MASK`
  - 才提交 `{ apiKey: editApiKey.trim() }`

**Step 2: Reuse model sync handling**

把现有 `handleFetchModels` 的结果处理逻辑抽成 `applyFetchModelsOutcome(channelId, result)`，供：
- 手动同步
- 编辑保存后的自动同步

**Step 3: Implement handleSaveEdit**

流程：
1. `api.channels.update(channelId, payload)`
2. `api.channels.fetchModels(channelId)`
3. `loadChannels()` + `setExpandedChannelId(channelId)`
4. 按 outcome toast/notice

更新失败：toast + 不关闭弹窗  
更新成功：关闭弹窗（即使同步失败也关闭，错误在 notice 中显示）

**Step 4: Commit**

```bash
git add apps/web/src/components/settings/ChannelSettings.tsx
git commit -m "feat(web): implement channel edit save + auto sync models"
```

### Task 3: UI 细节与回归

**Files:**
- Modify: `apps/web/src/components/settings/ChannelSettings.tsx`

**Step 1: Base URL 默认值按钮**

Provider 切换时 Base URL 不变；加按钮“填入默认 Base URL”覆盖为 `PROVIDERS[provider].defaultBaseUrl`。

**Step 2: Typecheck**

Run: `pnpm --filter web typecheck`  
Expected: PASS

**Step 3: Manual verification**

1. 打开 `http://localhost:3001/settings?tab=channels`
2. 点击某渠道“编辑”
3. 修改 Provider/Base URL/Enabled 任意一项保存
4. 预期：保存后自动同步模型；成功 toast；失败 notice 直出错误
5. API Key 不修改：保持 `********`，保存后不应更换 key

**Step 4: Commit**

```bash
git add apps/web/src/components/settings/ChannelSettings.tsx
git commit -m "chore(web): polish channel edit ui"
```

### Task 4: Push

```bash
git push
```

