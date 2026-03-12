# Chat Model Picker Consistency Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update Chat "选择模型" modal to display disabled channels/models consistently with Settings, while keeping selection strict (no auto fallback, no auto switching).

**Architecture:** Keep Settings as the only mutation surface for channel/model state. Chat modal becomes a read-only selector with clear disabled styling and guided links to Settings. Reuse existing resolution logic from `getEffectiveModelForConversation()` for error copy and fix flows.

**Tech Stack:** Next.js (React), Mantine UI, Zustand store, existing REST API (`api.channels.*`).

---

### Task 1: Extend Model Picker Data Model (Include Disabled)

**Files:**
- Modify: `apps/web/src/components/chat/ModelPickerModal.tsx`

**Step 1: Refactor option building into explicit groups**

- Replace the current `buildOptions()` filter that drops disabled channels/models.
- New output should include:
  - Enabled channels group first, then disabled channels.
  - Each group includes all models (enabled + disabled).
  - Each channel group includes computed flags:
    - `isChannelDisabled`
    - `needsDefaultModel` (`channel.isDefault && channel.enabled && !channel.defaultModelId`)

**Step 2: Run typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS

**Step 3: Commit**

Run:
```bash
git add apps/web/src/components/chat/ModelPickerModal.tsx
git commit -m "feat(web): show disabled channels/models in model picker"
```

---

### Task 2: Update Modal UI (Badges + Disabled Styling + Non-Interactive Rows)

**Files:**
- Modify: `apps/web/src/components/chat/ModelPickerModal.tsx`

**Step 1: Add badges consistent with Settings**

- Channel header badges:
  - `Default` (existing) should become `默认` (or keep consistent with Settings label)
  - `已禁用`
  - `缺少默认模型`
- Model row badges:
  - `默认`
  - `已禁用`
  - `已选`

**Step 2: Disable interaction for disabled items**

- If channel disabled: all rows appear disabled; clicks are ignored.
- If model disabled: that row appears disabled; click ignored.
- Styling:
  - `cursor: not-allowed`
  - reduced opacity
  - keep truncation to avoid layout breakage

**Step 3: Run typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS

**Step 4: Commit**

Run:
```bash
git add apps/web/src/components/chat/ModelPickerModal.tsx
git commit -m "feat(web): align model picker badges and disabled interactions"
```

---

### Task 3: Surface Conversation Model Errors Inside Modal + Guided Fix Link

**Files:**
- Modify: `apps/web/src/components/chat/ChatHeader.tsx`
- Modify: `apps/web/src/components/chat/ModelPickerModal.tsx`

**Step 1: Plumb the invalid reason into the modal**

- When `getEffectiveModelForConversation()` returns `{ ok: false, scope: 'conversation' }`:
  - Pass `reason` into `ModelPickerModal` as a new optional prop, e.g. `initialNotice`.
- In the modal:
  - Render a compact alert/banner at the top with the reason text.
  - Provide a button linking to `/settings?tab=channels&focus=default` (reuse `buildSettingsLink()`).

**Step 2: Run typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS

**Step 3: Commit**

Run:
```bash
git add apps/web/src/components/chat/ChatHeader.tsx apps/web/src/components/chat/ModelPickerModal.tsx
git commit -m "feat(web): show model fix guidance inside picker modal"
```

---

### Task 4: Sync Button Warning Semantics (No Auto Fix)

**Files:**
- Modify: `apps/web/src/components/chat/ModelPickerModal.tsx`

**Step 1: Treat `{ success: true, error }` as warning**

- If `result.success === true` and `result.error` exists:
  - Show a warning notification (or inline message) with the server-provided string.
- If `result.success === false`:
  - Show the concrete error string; do not attempt provider switching or fallback models.

**Step 2: Run typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS

**Step 3: Commit**

Run:
```bash
git add apps/web/src/components/chat/ModelPickerModal.tsx
git commit -m "feat(web): improve model sync feedback in picker"
```

---

### Task 5: Manual QA Checklist

**Step 1: Start web**

Run: `pnpm --filter web dev`
Expected: Next dev server starts on `http://localhost:3001`

**Step 2: Scenarios**

- Disable a model in Settings -> Channels:
  - Open Chat model picker and confirm the model is visible with `已禁用` and not selectable.
- Disable a channel in Settings -> Channels:
  - Open Chat model picker and confirm the channel group is visible with `已禁用` and not selectable.
- Default channel missing default model (`缺少默认模型`):
  - Confirm badge appears in both Settings and modal.
- Conversation points to a removed/disabled model:
  - ChatHeader shows "对话模型异常"
  - Open modal and see the reason banner + "去设置" link

