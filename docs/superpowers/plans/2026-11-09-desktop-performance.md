# Desktop performance measurement and optimization

**Goal:** Measure cold UI startup and large-sidebar behavior, then improve confirmed bottlenecks while preserving interaction and state.

**Baseline method:** Production build with real App/sidebar components, fresh Chrome contexts, CPU throttle4, synthetic API data at344/5000 conversations, three repetitions. Record first-ready paint independently of Playwright locators, decoded JS bytes, DOM count, selection-to-paint and scroll frame p95. This is a browser UI benchmark, not a measurement of native process/sidecar startup.

**Observed:** Sidebar5000 renders about35019 nodes and4988 conversation rows; selected-conversation updates take about90–116ms. Startup loads about1.87MB JS including the full Prism highlighter even on the welcome view.

**Design:** Reuse existing @tanstack/react-virtual for the unbounded ordinary conversation groups, retaining date headings, item identity, focused/menu rows and keyboard reachability. Leave bounded project pages and small pinned/task sections in place. Split highlighter into a cached dynamic module with the exact existing plain-code fallback and theme/line-number behavior. Defer secondary app routes only if measurements justify it. No dependency/backend/schema changes.

**Constraints:** Preserve project grouping, streaming indicators, rename/pin/move/delete menus, search semantics, drafts and preview sandbox. No provider calls, data mutations, Git actions or external deployment.

- [x] Save corrected baseline with3 repetitions and no unexpected requests.
- [x] Implement measured sidebar rendering optimization and code-highlight loading split.
- [x] Add actual-browser regressions for long scroll, selection, keyboard/menu focus, project expansion, search and code rendering/themes/copy; compare identical benchmarks.
- [x] Run desktop suite, types/format, related browser regressions and native bundle/inspection.
- [x] Record measurements with limits and preserve evidence and durable boundaries.

**Verified outcome:** 12 valid production samples per side; 344-conversation app UI median1332.9→593.1ms, 5000-conversation app4250.9→639ms. Standalone sidebar5000 nodes35020→258 and selection105.1→31.6ms; initial decoded JS1866813→1216264 bytes. Four added production checks and106 existing browser PASS groups, Desktop657, workspace types/format and macOS bundle passed. Native344-history scroll/return confirmed. Report: `docs/2026-11-09_desktop-performance.md`. No model calls in synthetic tests or real-history mutations.
