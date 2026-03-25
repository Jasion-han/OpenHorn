# Desktop-Web Parity Design

**Date:** 2026-03-25

**Goal:** Bring the desktop app's `login`, `shell`, `sidebar`, `chat`, and `settings` views into visual and behavioral parity with the current web app before taking on any new desktop-specific work.

## Scope

This work covers the desktop app only.

Included:
- Login screen layout, copy, tab switching, loading, error display, and post-login flow
- Shell layout spacing, panel chrome, compact settings layout behavior, and sidebar collapse behavior
- Conversation sidebar interactions including create, search, select, pin, rename, delete, and settings entry state
- Chat page behavior including header state, empty state, message layout, message actions, composer controls, model picker entry, web-search toggle, and streaming affordances
- Settings navigation, tab defaults, tab switching behavior, and sub-view presentation
- Supporting desktop state synchronization needed to match the web flow

Excluded:
- New product features
- Server-side behavior changes unless required to satisfy an existing web contract already used by desktop
- Large shared-component extraction unless parity work is blocked without it

## Success Criteria

- A user can log into desktop with the same flow and visible states as the web app
- The desktop shell, sidebar, chat area, and settings screen match the web app's current layout rhythm and interaction model on desktop-sized viewports
- Conversation actions behave the same as web, including selection, loading, pinning, rename submission, and delete confirmation
- Composer controls and chat-level actions behave the same as web for enabled, disabled, and streaming states
- Desktop passes type checking and the main flows are exercised with Playwright

## Constraints

- The repository already contains unrelated in-progress changes; parity work must avoid reverting or disturbing them
- The desktop app can keep desktop-specific plumbing where necessary, but visible behavior should follow the web app as the source of truth
- Validation will happen against the current code in `apps/web`, not against older screenshots or assumptions

## Approach

Use the web app as the canonical reference and align the desktop app view by view.

1. Normalize low-risk views first: login, shell, settings
2. Align sidebar and conversation flow next because many chat behaviors depend on it
3. Align chat area and composer last, after conversation state transitions behave like web
4. Validate with desktop typecheck and Playwright-driven interaction checks

## Design Decisions

### 1. Web is the behavioral source of truth

The desktop app should not invent alternate flows for common actions such as creating a conversation, selecting a conversation, or toggling composer modes. Where desktop currently diverges, it should move closer to the web implementation unless there is a desktop-only technical requirement.

### 2. Keep implementation localized

This round prioritizes parity over abstraction. Shared extraction is acceptable only if a local desktop fix would otherwise duplicate complex web logic or create obvious maintenance risk.

### 3. Match visible states, not just static layout

Parity includes:
- initial loading
- disabled button states
- destructive confirmation flow
- current selection/highlight rules
- stream-time controls
- settings tab synchronization

### 4. Verify with running UI

Static review is not enough. Playwright should be used to inspect the desktop UI while logged in and to confirm that the user-visible flow matches the web app.

## Validation Plan

- Run `pnpm --filter desktop typecheck`
- Run the desktop UI locally
- Use Playwright to validate:
  - login with provided credentials
  - create conversation
  - switch between conversations
  - rename, pin, and delete a conversation
  - open settings and switch tabs
  - return to chat and send a message if the backend is available

## Risks

- The desktop chat area has evolved separately from the web `ChatArea`, so parity changes may span more than one file
- Existing uncommitted desktop work may overlap with parity edits and must be preserved carefully
- Some web interactions rely on router behavior; desktop equivalents need explicit state handling to avoid subtle drift
