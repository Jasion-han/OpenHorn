# Preview Scroll Anchor Fix

**Goal:** Closing/collapsing an attachment preview returns the clicked attachment to the vertical viewport position it occupied at click time.
**Root cause:** Right panel width changes reflow dynamically measured virtual message rounds. Keeping scrollTop and TanStack's existing generic compensation cannot retain a specific attachment within a long round.
**Approach:** Capture the clicked attachment's stable message/round identity and viewport-relative offset before opening the preview. Pin that virtual round and restore the anchor after panel layout and asynchronous measurements. Manual chat scrolling suspends automatic correction; close/collapse re-arms the original click anchor. Conversation changes and explicit send/retry scroll targets cancel old restoration.

- [x] Reproduce drift with real TanStack virtualization, long rounds and actual attachment buttons.
- [x] Add original-click metadata and a bounded, cancellable scroll-anchor hook; preserve normal scrolling/streaming behavior.
- [x] Verify open/close, collapse/reopen, drag resize, attachment replacement, manual scrolling, delayed height changes and conversation cancellation.
- [x] Run relevant/full desktop checks, build and update the desktop bundle.

No commits. Preserve unrelated dirty changes. No arbitrary scrollIntoView or retained scrollTop-only restoration.

## Confirmed additional requirement

The user rejected forcing another save just to view/open an attachment. System opening now uses its own `open_attachment` native command and reuses a managed cache without a Save dialog. Explicit export is under More → Save As. Managed originals are byte-checked before reuse; externally modified copies are preserved.

## Verification

- Real TanStack long-round fixture reproduced 300px → 1188px on open and 588px on close before the fix; after the fix all three positions were 300px.
- Regression passes open/close, drag, delayed height growth, manual scroll + return, collapse/reopen, replacement anchor, conversation cancellation and explicit new-scroll ownership.
- Existing attachment browser suite passes, including separate native open/export IPC and full-byte download; nested menu cleanup is checked by later keyboard/removal interactions.
- 602 desktop tests, 49 Rust tests, full workspace typecheck and touched-file formatting passed; debug Tauri app built and restarted.
- Actual native UI: selected a synthetic local text fixture before sending, previewed it in the right panel, clicked Use Default App, and observed original content in TextEdit with a managed cache URL and no Save dialog. Closed the test document, removed the pending attachment and restored the left sidebar. No model call or message send.

SELF-REVIEW: native direct-open has UI evidence; exact numeric scroll acceptance is from the real virtualized browser fixture. Historical metadata-only Agent attachments still cannot recover missing bytes; cache opening does not silently change that contract. No commits.
