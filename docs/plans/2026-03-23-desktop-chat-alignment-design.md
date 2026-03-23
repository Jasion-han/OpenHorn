# Desktop Chat Alignment Design

**Status:** Approved

**Date:** 2026-03-23

## Goal

Align the desktop app with the current Web app interaction model so the default desktop experience is the same two-panel chat workspace:

- left sidebar for conversations and navigation
- middle chat area for chat and inline agent mode

The desktop app must stop presenting the legacy IDE-like `FileTree + EditorPane + AgentPane` shell as its primary product surface.

## Product Decision

The Web app is the protected product baseline for layout and interaction semantics at this stage. The desktop app should adapt to that baseline instead of forcing the Web app to refactor for desktop reuse.

This is not a permanent freeze on Web evolution. It is a safety boundary: desktop work must not destabilize existing Web behavior.

## Non-Goals

- Do not preserve the old desktop three-pane IDE workbench.
- Do not introduce a second desktop-only conversation model.
- Do not rewrite the Web store or Web routing to satisfy desktop reuse.
- Do not keep dead compatibility UI once the new desktop shell is in place.
- Do not add mock, placeholder, or speculative features.

## Current State

### Web

The Web app currently renders a stable app shell with:

- [apps/web/src/components/app/AppShellLayout.tsx](/Users/han/Project/OpenHorn/apps/web/src/components/app/AppShellLayout.tsx)
- [apps/web/src/components/app/LeftSidebar.tsx](/Users/han/Project/OpenHorn/apps/web/src/components/app/LeftSidebar.tsx)
- [apps/web/src/components/ChatArea.tsx](/Users/han/Project/OpenHorn/apps/web/src/components/ChatArea.tsx)

This is the reference shape the desktop app should match visually and structurally.

### Desktop

The desktop app still renders an outdated IDE-style shell from:

- [apps/desktop/src/App.tsx](/Users/han/Project/OpenHorn/apps/desktop/src/App.tsx)
- [apps/desktop/src/components/FileTree.tsx](/Users/han/Project/OpenHorn/apps/desktop/src/components/FileTree.tsx)
- [apps/desktop/src/components/EditorPane.tsx](/Users/han/Project/OpenHorn/apps/desktop/src/components/EditorPane.tsx)
- [apps/desktop/src/components/AgentPane.tsx](/Users/han/Project/OpenHorn/apps/desktop/src/components/AgentPane.tsx)
- [apps/desktop/src/stores/ideStore.ts](/Users/han/Project/OpenHorn/apps/desktop/src/stores/ideStore.ts)

These files represent the wrong product direction and should not survive as the default desktop experience.

## Architecture

### Principle

Use the same visible product model on Web and desktop, but keep runtime integration isolated.

- Shared first: visual structure, component semantics, message presentation, design system.
- Isolated first: routing, data fetching, sidecar/Tauri integration, local desktop state.

### Why

The Web app and desktop app run in different environments:

- Web uses browser + HTTP/SSE + server APIs.
- Desktop uses Tauri + sidecar + local system capabilities.

Trying to force both apps onto one store or one transport layer now would create the highest risk of breaking the already-working Web app.

## Target Desktop Shape

### Primary shell

The desktop app should open into:

- a left conversation sidebar visually aligned with Web
- a middle chat area visually aligned with Web

Settings remain available, but the default product surface is the chat workspace, not an IDE workbench.

### Desktop-only capability surface

Desktop-specific capabilities remain, but only as supporting capabilities:

- sidecar connection status
- workspace selection
- future local-context attachment into chat

They should appear as desktop-specific context controls inside the new shell, not as separate panes.

## Code Sharing Strategy

### Safe to share now

- `ui` primitives and theme tokens
- pure presentational chat components after they are isolated from Web-only imports
- pure utility functions and shared types

### Must remain separated for now

- Web route structure
- Web app shell orchestration
- Web chat store implementation
- desktop sidecar client
- desktop Tauri integration
- local workspace state

### Future unification target

Define one shared chat domain shape, then let each platform implement an adapter:

- Web adapter: server HTTP/SSE
- Desktop adapter: server APIs plus desktop local integrations

That gives us visual parity now without forcing risky runtime coupling.

## Deletion Policy

This work must remove obsolete code instead of leaving legacy UI behind.

Expected deletions once replacement lands:

- [apps/desktop/src/components/FileTree.tsx](/Users/han/Project/OpenHorn/apps/desktop/src/components/FileTree.tsx)
- [apps/desktop/src/components/EditorPane.tsx](/Users/han/Project/OpenHorn/apps/desktop/src/components/EditorPane.tsx)
- [apps/desktop/src/components/AgentPane.tsx](/Users/han/Project/OpenHorn/apps/desktop/src/components/AgentPane.tsx)

The old [apps/desktop/src/stores/ideStore.ts](/Users/han/Project/OpenHorn/apps/desktop/src/stores/ideStore.ts) should be either:

- deleted entirely, or
- replaced with narrower stores for desktop shell state and local integration state

No dead compatibility layer should remain after the new desktop shell becomes the default.

## Data Flow Decision

For the first desktop alignment phase:

- conversations, messages, channels, settings, and chat or agent execution remain server-backed
- desktop keeps its own adapter layer for runtime differences
- desktop does not introduce a second local conversation system

This preserves product consistency between Web and desktop and avoids divergence in chat semantics.

## Testing Strategy

Desktop alignment should be validated by:

- desktop typecheck
- desktop build smoke test
- Playwright or equivalent runtime verification for the desktop shell when practical
- explicit regression checks that Web routing and Web shell still behave unchanged

The change should be split into small commits:

1. introduce desktop chat shell scaffolding
2. wire desktop chat adapter and store
3. remove legacy desktop IDE panes
4. clean unused code

## Result

After this phase:

- desktop and Web will present the same core product surface
- desktop keeps its platform-specific runtime internals without forcing Web refactors
- legacy desktop IDE UI is removed instead of being left behind as garbage code
