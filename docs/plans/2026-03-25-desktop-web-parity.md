# Desktop-Web Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the desktop app match the web app's current desktop UI and behavior for login, shell, sidebar, chat, and settings.

**Architecture:** Treat the web app as the canonical behavior source and adjust desktop view logic to mirror it. Keep the work localized to `apps/desktop` unless parity requires consuming an existing shared contract from `packages/shared` or the server.

**Tech Stack:** React 19, Zustand, Vite, Tauri desktop shell, Tailwind utilities, shared `ui` workspace package, Playwright for browser-based verification

---

### Task 1: Record the approved design and establish parity references

**Files:**
- Create: `docs/plans/2026-03-25-desktop-web-parity-design.md`
- Modify: `docs/plans/2026-03-25-desktop-web-parity.md`
- Reference: `apps/web/src/app/login/page.tsx`
- Reference: `apps/web/src/components/app/AppShellLayout.tsx`
- Reference: `apps/web/src/components/chat/ChatAside.tsx`
- Reference: `apps/web/src/components/chat/ChatHeader.tsx`
- Reference: `apps/web/src/components/composer/PromaComposer.tsx`
- Reference: `apps/web/src/app/(app)/settings/page.tsx`

**Step 1:** Confirm the approved desktop parity scope is captured in the design document.

**Step 2:** Use the web files above as the canonical references for all subsequent parity changes.

**Step 3:** Commit only the plan documents.

Run:
```bash
git add docs/plans/2026-03-25-desktop-web-parity-design.md docs/plans/2026-03-25-desktop-web-parity.md
git commit -m "docs: add desktop web parity plan"
```

Expected: a commit containing only the two new planning documents.

### Task 2: Align desktop login and shell chrome with web

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/components/auth/DesktopAuthScreen.tsx`
- Modify: `apps/desktop/src/components/app/DesktopShellLayout.tsx`
- Modify: `apps/desktop/src/components/app/DesktopLeftSidebar.tsx`
- Reference: `apps/web/src/app/login/page.tsx`
- Reference: `apps/web/src/components/app/AppShellLayout.tsx`
- Reference: `apps/web/src/components/app/LeftSidebar.tsx`

**Step 1:** Compare desktop login loading and auth screen behavior against the web login page.

**Step 2:** Make the desktop login view match the web layout, tab behavior, copy, spacing, and submission states while keeping desktop auth store wiring intact.

**Step 3:** Make the desktop shell container and sidebar panel chrome match the web shell's desktop layout behavior.

**Step 4:** Verify sidebar footer settings entry state and shell padding behavior match the web app.

**Step 5:** Run desktop typecheck after this slice.

Run:
```bash
pnpm --filter desktop typecheck
```

Expected: no TypeScript errors from the login and shell updates.

### Task 3: Align conversation sidebar flow and state transitions

**Files:**
- Modify: `apps/desktop/src/components/app/DesktopLeftSidebar.tsx`
- Modify: `apps/desktop/src/stores/chatStore.ts`
- Modify: `apps/desktop/src/lib/chatAdapter.ts`
- Modify: `apps/desktop/src/types/chat.ts`
- Reference: `apps/web/src/components/chat/ChatAside.tsx`
- Reference: `apps/web/src/stores/chatStore.ts`

**Step 1:** Compare the desktop conversation store APIs and sidebar action flow to the web equivalents.

**Step 2:** Make desktop create/select conversation behavior mirror web, including current-conversation updates and message loading expectations.

**Step 3:** Align rename, pin, and delete behavior so optimistic updates, fallbacks, and confirmations match web behavior where appropriate.

**Step 4:** Verify empty, filtered, active, and grouped sidebar states match web.

**Step 5:** Run desktop typecheck after the sidebar flow changes.

Run:
```bash
pnpm --filter desktop typecheck
```

Expected: no TypeScript errors from sidebar state alignment.

### Task 4: Align chat header, chat area, and composer behavior

**Files:**
- Modify: `apps/desktop/src/components/chat/DesktopChatArea.tsx`
- Modify: `apps/desktop/src/components/chat/DesktopChatHeader.tsx`
- Modify: `apps/desktop/src/components/chat/DesktopComposer.tsx`
- Modify: `apps/desktop/src/components/chat/DesktopModelPickerModal.tsx`
- Modify: `apps/desktop/src/components/chat/DesktopAttachmentPreviewItem.tsx`
- Modify: `apps/desktop/src/components/chat/DesktopMarkdownMessage.tsx`
- Reference: `apps/web/src/components/ChatArea.tsx`
- Reference: `apps/web/src/components/chat/ChatHeader.tsx`
- Reference: `apps/web/src/components/composer/PromaComposer.tsx`

**Step 1:** Identify desktop-only visual or interaction drift in header, empty state, message actions, composer controls, and model-picker entry points.

**Step 2:** Update desktop chat header and empty state to match web titles, spacing, and sidebar toggle behavior.

**Step 3:** Update composer behavior to match web disabled states, file handling, mode switching, model button state, and streaming stop/send controls.

**Step 4:** Adjust any message or message-action presentation needed for parity with the web experience.

**Step 5:** Run desktop typecheck after chat-area changes.

Run:
```bash
pnpm --filter desktop typecheck
```

Expected: no TypeScript errors from chat-area parity work.

### Task 5: Align settings navigation and tab state behavior

**Files:**
- Modify: `apps/desktop/src/components/settings/SettingsView.tsx`
- Modify: `apps/desktop/src/components/settings/GeneralSettings.tsx`
- Modify: `apps/desktop/src/components/settings/ChannelSettings.tsx`
- Modify: `apps/desktop/src/components/settings/AgentSettings.tsx`
- Modify: `apps/desktop/src/components/settings/AppearanceSettings.tsx`
- Modify: `apps/desktop/src/stores/desktopShellStore.ts`
- Reference: `apps/web/src/app/(app)/settings/page.tsx`
- Reference: `apps/web/src/components/settings/GeneralSettings.tsx`
- Reference: `apps/web/src/components/settings/ChannelSettings.tsx`
- Reference: `apps/web/src/components/settings/AgentSettings.tsx`
- Reference: `apps/web/src/components/settings/AppearanceSettings.tsx`

**Step 1:** Ensure desktop settings default-tab and tab-switch behavior mirror the web settings page.

**Step 2:** Align settings container spacing and sub-view presentation with the web app.

**Step 3:** Adjust any desktop settings child view that visibly diverges from its web counterpart.

**Step 4:** Run desktop typecheck after settings parity changes.

Run:
```bash
pnpm --filter desktop typecheck
```

Expected: no TypeScript errors from settings updates.

### Task 6: Verify running flows with Playwright and fix remaining parity gaps

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/components/**/*`
- Modify: `apps/desktop/src/stores/**/*`

**Step 1:** Start the required local services for desktop UI verification.

**Step 2:** Use Playwright to log in with the provided credentials and walk through the core parity flow:
- login
- create conversation
- switch conversation
- rename conversation
- pin conversation
- delete conversation
- open settings and switch tabs
- return to chat

**Step 3:** Patch any remaining user-visible parity gaps discovered during live verification.

**Step 4:** Run final desktop typecheck.

Run:
```bash
pnpm --filter desktop typecheck
```

Expected: no TypeScript errors after live verification fixes.

### Task 7: Final review and handoff

**Files:**
- Review: `apps/desktop/src/App.tsx`
- Review: `apps/desktop/src/components/app/DesktopShellLayout.tsx`
- Review: `apps/desktop/src/components/app/DesktopLeftSidebar.tsx`
- Review: `apps/desktop/src/components/auth/DesktopAuthScreen.tsx`
- Review: `apps/desktop/src/components/chat/DesktopChatArea.tsx`
- Review: `apps/desktop/src/components/chat/DesktopChatHeader.tsx`
- Review: `apps/desktop/src/components/chat/DesktopComposer.tsx`
- Review: `apps/desktop/src/components/settings/SettingsView.tsx`

**Step 1:** Review the final diff to make sure parity edits stayed scoped to the desktop app and did not revert unrelated changes.

**Step 2:** Summarize what now matches the web app and note any residual gaps that require future work.

**Step 3:** Commit the implementation in focused slices once verification is complete.

Run:
```bash
git status --short
```

Expected: only intentional desktop parity changes remain uncommitted or ready for focused commits.
