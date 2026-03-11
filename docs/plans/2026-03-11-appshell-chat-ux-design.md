# AppShell + Chat UX Design

**Goal:** Turn the current demo-like UI into a coherent, product-like shell and a solid Chat experience (global navigation, auth gating, responsive layout, better states).

**Scope (Phase 1):**
- Add a logged-in AppShell (nav + header + main).
- Add auth bootstrap + route gating (redirect to `/login` when not authenticated).
- Rework Chat into an AppShell-integrated, responsive two-pane experience.

**Out of Scope (Phase 1):**
- New visual identity / full redesign of every page.
- Rich message rendering (Markdown, code highlighting) beyond basic readability.
- Agent runtime compatibility fixes (SDK vs third-party gateways).

---

## Route Structure

- Public:
  - `/` landing
  - `/login` login/register
- Authenticated (grouped):
  - `/(app)/chat/*`
  - `/(app)/agent/*`
  - `/(app)/settings/*`

This keeps all "needs login" pages under a single layout with auth gating and shared navigation.

---

## AppShell Layout

**Layout:** `apps/web/src/app/(app)/layout.tsx`

- Mantine `AppShell`:
  - `AppShell.Navbar`: global navigation (Chat / Agent / Settings).
  - `AppShell.Header`: page title + default channel badge + user menu (logout).
  - `AppShell.Main`: nested route content.
- Responsive:
  - Desktop: navbar visible.
  - Mobile: navbar collapses into a drawer toggle.

**State shown in header:**
- Global default channel/model badge (derived from channel list).
- If no default channel/model: compact warning + link to `/settings`.

---

## Auth Bootstrap + Route Gating

Problem today:
- `useAuthStore` is persisted client-side, but can be stale/out of sync with server cookie.

**Proposed:**
- `AuthBootstrap` client component runs once in `/(app)/layout.tsx`:
  - Calls `GET /auth/me` (includes cookie).
  - If user returned: `useAuthStore.setUser(user)`
  - Else: `useAuthStore.logout()` then redirect to `/login`
- `LoginPage`:
  - If already authenticated (store or `/auth/me`): redirect to `/chat`.

This avoids "looks logged out but cookie exists" and provides consistent gating.

---

## Chat UX

### Layout

Use a nested layout for Chat:
- `apps/web/src/app/(app)/chat/layout.tsx`
  - `AppShell.Aside`: conversation list (search + create + list).
  - `AppShell.Main`: chat content (messages + composer).

Why:
- Global nav stays global; chat list becomes contextual without fighting for left-nav space.

### Conversation List

Refactor the existing `Sidebar` into a re-usable chat aside component:
- Search (client filter).
- Create (inline input + create button, later can be modal).
- Select loads messages.
- Delete includes confirm.
- Pinned indicator remains (phase 2: pin/unpin action).

### Composer

- Multi-line input (Textarea):
  - Enter sends, Shift+Enter newline.
- Attachments chips:
  - Show selected files with remove.
  - Disable controls while uploading/streaming.
- Clear, non-intrusive errors:
  - Toast notifications for upload/send failures.
  - Keep minimal fallback text in assistant bubble if needed.

### Scroll Behavior

Current issue risk:
- Mantine `ScrollArea` ref is not the viewport; autoscroll can be unreliable.

Proposed:
- Use `viewportRef` and auto-scroll on new messages and while streaming.

---

## Visual Direction (Phase 1, lightweight)

- Reduce "demo" feel:
  - AppShell chrome (header + nav) with subtle borders and spacing.
  - Content background uses a soft neutral instead of flat white.
  - Message bubbles: consistent radius, readable line-height, max-width.

Keep changes minimal and consistent with Mantine defaults to avoid a large style rewrite.

---

## Success Criteria

- Navigating between Chat/Agent/Settings feels cohesive.
- Unauthenticated users are redirected to `/login`.
- Chat has a stable two-pane layout with clear empty states.
- Attachments UI feels integrated (chips + disabled states).
- Autoscroll and streaming feel reliable.
