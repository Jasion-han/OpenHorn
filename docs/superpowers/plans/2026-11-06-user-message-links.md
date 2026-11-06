# User Message Links Implementation Plan

**Goal:** Make HTTP(S) URLs in user messages clickable without changing stored text, whitespace, slash-command chips or message copying.
**Architecture:** Parse URL spans with linkify-it, render raw text around inline links, and route explicit clicks to the existing web preview store. Use a small More menu for browser open/copy. Reuse viewport-relative scroll anchors for web tabs as well as attachments.
**Spec:** User approved single-click right preview, browser open/copy actions, original URL display, Chinese punctuation boundaries, selection-safe clicks and loading only on interaction.

- [x] Add pure URL-span tests: multiple links, Chinese/ASCII punctuation, balanced parentheses, Unicode, query/hash, protocol allow-list and unchanged source reconstruction.
- [x] Render user text and slash chips with link actions; block duplicate global navigation; support keyboard, Ctrl/Cmd click, text selection and context menu.
- [x] Extend existing scroll-origin handling to web previews without changing existing assistant/file link callers.
- [x] Verify actual user bubbles and virtualized long history in isolated browser tests; run desktop tests, typecheck, Biome and build; update/restart the desktop bundle.

No automatic requests for URLs, favicons or metadata. No real message sends, model calls, Git commits or unrelated changes.

## Validation

609 desktop tests, full workspace typecheck, touched-file Biome, user-message browser acceptance and attachment scroll regression passed. Debug Tauri bundle rebuilt and restarted. Native UI verification used the existing historical message: all three original URLs became links, and clicking the GitHub URL loaded its repository in the right-hand native web preview. No new message or model call.
