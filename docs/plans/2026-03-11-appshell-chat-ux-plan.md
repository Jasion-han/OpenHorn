# AppShell + Chat UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a cohesive logged-in AppShell (nav/header) + auth gating, then rework Chat into a responsive two-pane layout with better interaction and states.

**Architecture:** Use Next.js route groups to isolate authenticated routes under `/(app)`. Add a shared `AppShell` layout with a client-side auth bootstrap. Add a nested chat layout that uses `AppShell.Aside` for conversations and `AppShell.Main` for the chat area.

**Tech Stack:** Next.js App Router, Mantine, Zustand, Hono API.

---

### Task 1: Add authenticated route group and AppShell skeleton

**Files:**
- Create: `apps/web/src/app/(app)/layout.tsx`
- Create: `apps/web/src/components/app/AppShellLayout.tsx`
- Create: `apps/web/src/components/app/AppNav.tsx`
- Create: `apps/web/src/components/app/AppHeader.tsx`
- Modify: `apps/web/src/app/chat/page.tsx`
- Modify: `apps/web/src/app/agent/page.tsx`
- Modify: `apps/web/src/app/settings/page.tsx`

**Step 1: Implement `/(app)/layout.tsx`**
- Wrap children with `AppShellLayout`.
- Keep public pages (`/`, `/login`) outside this group.

**Step 2: Implement `AppShellLayout`**
- Mantine `AppShell` with responsive navbar + header.
- Navbar links to `/chat`, `/agent`, `/settings`.

**Step 3: Move pages under `/(app)`**
- Change the routes by moving existing pages into `apps/web/src/app/(app)/...` or by re-exporting from the new path.

**Step 4: Manual verification**
- Run: `cd apps/web && pnpm dev`
- Visit `/chat` and confirm AppShell is visible.

---

### Task 2: Add auth bootstrap + gating

**Files:**
- Create: `apps/web/src/components/auth/AuthBootstrap.tsx`
- Modify: `apps/web/src/app/(app)/layout.tsx`
- Modify: `apps/web/src/app/login/page.tsx`
- Modify: `apps/web/src/stores/authStore.ts`

**Step 1: Implement `AuthBootstrap`**
- On mount, call `api.auth.me()`.
- If user returned: `useAuthStore.setUser(user)`.
- Else: `useAuthStore.logout()` and redirect to `/login`.

**Step 2: Ensure logout hits server**
- Update `logout()` to also call `api.auth.logout()` (best-effort), then clear store.

**Step 3: Manual verification**
- Open `/chat` without being logged in: should redirect to `/login`.
- Login then refresh: should stay logged in and allow `/chat`.

---

### Task 3: Add header status (default channel/model) + user menu

**Files:**
- Modify: `apps/web/src/components/app/AppHeader.tsx`
- Modify: `apps/web/src/stores/chatStore.ts`
- Modify: `apps/web/src/lib/default-channel.ts`

**Step 1: Ensure channels are loaded once**
- On entering `/(app)` routes, load channels in a single place (header bootstrap or store init).

**Step 2: Header UI**
- Show a badge for default provider/model.
- If missing: show a compact warning + link to `/settings`.
- User menu: username + "Logout".

**Step 3: Manual verification**
- Toggle default channel in settings; header badge updates after refresh or re-fetch.

---

### Task 4: Rework Chat into a nested two-pane layout

**Files:**
- Create: `apps/web/src/app/(app)/chat/layout.tsx`
- Modify: `apps/web/src/app/(app)/chat/page.tsx`
- Create: `apps/web/src/components/chat/ChatAside.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx` (move logic into ChatAside or delete if unused)

**Step 1: Implement `chat/layout.tsx`**
- `AppShell.Aside` contains `ChatAside` (conversation list).
- Main contains the page content.

**Step 2: Implement `ChatAside`**
- Search + create + select + delete with confirm.
- Load messages on select.

**Step 3: Manual verification**
- Create/select/delete conversations.
- Works on narrow viewport (aside collapses or stacks).

---

### Task 5: Improve ChatArea composer + scroll reliability

**Files:**
- Modify: `apps/web/src/components/ChatArea.tsx`

**Step 1: Switch input to multi-line**
- Use `Textarea` with Enter-to-send and Shift+Enter newline.

**Step 2: Fix scroll targeting**
- Use Mantine `ScrollArea` `viewportRef` to auto-scroll reliably.

**Step 3: Error UX**
- Prefer `notifications` (Mantine) or a consistent inline alert in composer instead of `alert()`.

**Step 4: Manual verification**
- Streaming still works.
- Attachments chips still work.
- Autoscroll follows new tokens.

---

### Task 6: Quick visual polish pass (lightweight)

**Files:**
- Modify: `apps/web/src/theme.ts`
- Modify: `apps/web/src/app/layout.tsx`

**Step 1: Add a subtle background**
- Set a neutral background for app pages.

**Step 2: Typography**
- Optionally introduce a headings font via `next/font/google` and set `theme.fontFamilyHeadings`.

**Step 3: Manual verification**
- Contrast and spacing look consistent across Chat/Agent/Settings.

---

## Notes

- Keep changes incremental: first AppShell + gating, then Chat layout, then polish.
- Do not tackle Agent SDK runtime issues in this plan.
