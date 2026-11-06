# Inline Local Path References

**Goal:** Make standalone local paths in assistant inline code actionable, preserving code appearance and original content. Files preview on the right; directories open in the file manager; menus open/reveal/copy paths. Missing/deleted files show their actual current state.
**Architecture:** Recognize exact absolute/home/file-URI path references using the existing line-range parser. Add a main-webview-only native read/inspect/open/reveal surface for explicit local UI interaction, without changing Sidecar workspace permissions or file:// shell scope. Reuse the attachment viewer for file formats and the existing origin scroll anchor for local path tabs.

- [x] Parser unit cases: screenshot path, spaces/Unicode, file URI, home paths, line ranges; reject commands, URLs, multiline code.
- [x] Native read-only local path operations, regular-file/size checks, safe default opening and directory handling; structured error codes and native tests.
- [x] Inline path link with context/menu actions and local preview tab, current-file read, missing-state rendering, original-path opening and source position restoration.
- [x] Browser interaction tests, desktop/native tests, typecheck/Biome/build; restart and inspect the actual screenshot conversation.

No file creation/deletion from path clicks, no shell command execution, no model calls, no Git commits. Byte previews capped at 20 MiB; larger files retain original-path opening. Remote webviews cannot call the native path commands.

## Validation

- Desktop Bun: 612 passed; Rust: 52 passed. Workspace typecheck, touched-file Biome, rustfmt, whitespace and Tauri debug bundle build passed.
- Local-path browser suite passed recognition, current bytes, repeat-click deletion checks, original open/reveal/copy, folder and large-file handling, narrow dialogs and virtualized scroll restoration (300 → 300 → 300 px).
- Existing user-message links, attachment scroll and complete attachment preview browser suites passed. Test servers disable watch/HMR to avoid unrelated Rust build outputs triggering reloads during QA.
- Restarted the built macOS app and opened the historical “在下载目录创建TXT文件” conversation. `/Users/han/Downloads/hello.txt` is clickable; the native preview reports that the file no longer exists. Closed the preview successfully. No historical file was recreated and no messages were sent.
- Existing-file viewer behavior is covered by native filesystem tests and browser IPC fixtures; the native historical UI check specifically verified the missing-file case.
