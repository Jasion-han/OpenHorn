# Settings Guided Fix For Default Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make “Set default model” flows land users directly in `Settings -> Channels` and focus the right channel, with a one-time URL-driven guide and remembered provider in the “Add channel” modal.

**Architecture:** Use URL params (`tab`, `focus`) to drive Settings tab selection and ChannelSettings focus behavior. Persist the last used provider/baseUrl in `localStorage` and restore when opening the create-channel modal.

**Tech Stack:** Next.js (App Router), Mantine, Zustand, TypeScript.

---

### Task 1: Add A Reusable Settings Link Helper

**Files:**
- Create: `apps/web/src/lib/settings-link.ts`
- Modify: `apps/web/src/components/app/AppHeader.tsx`
- Modify: `apps/web/src/components/chat/ChatHeader.tsx`
- Modify: `apps/web/src/components/ChatArea.tsx`
- Modify: `apps/web/src/components/settings/AgentSettings.tsx`

**Steps**
1. Create `buildSettingsLink({ tab, focus })` returning a string URL.
2. Replace hard-coded `/settings` links with `buildSettingsLink({ tab: 'channels', focus: 'default' })`.
3. Run `pnpm --filter web typecheck`.
4. Commit.

### Task 2: Make Settings Tabs URL-Controlled

**Files:**
- Modify: `apps/web/src/app/(app)/settings/page.tsx`

**Steps**
1. Use `useSearchParams()` to read `tab`.
2. Make Mantine Tabs controlled (`value` + `onChange`).
3. Default to `channels` if no param or unknown.
4. Run typecheck and commit.

### Task 3: ChannelSettings Focus Guide (One-Time)

**Files:**
- Modify: `apps/web/src/components/settings/ChannelSettings.tsx`

**Steps**
1. Read `focus` from `useSearchParams()`.
2. After channels are loaded, apply focus rule:
   - default enabled channel else latest updated enabled channel else open create modal.
3. Expand target channel and `scrollIntoView`.
4. Clear URL params using `router.replace()` after applying.
5. Add a badge `缺少默认模型` for default channel when `defaultModelId` is null.
6. Run typecheck and commit.

### Task 4: Remember Last Provider In Add-Channel Modal

**Files:**
- Modify: `apps/web/src/components/settings/ChannelSettings.tsx`

**Steps**
1. Store `lastProvider` and `lastBaseUrl` in `localStorage` on change.
2. On mount/open modal, restore them (safe guard for SSR).
3. Ensure “reset form” does not wipe persisted preference (only clears fields).
4. Run typecheck and commit.

### Task 5: Manual Verification

**Files:**
- Create: `docs/plans/2026-03-12-settings-guided-fix-default-model-verify.md`

**Steps**
1. Describe manual steps from Header/Chat/Agent links to focused Channels.
2. Commit.

