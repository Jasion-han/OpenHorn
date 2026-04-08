# Agent Streaming Output Design

Date: 2026-04-08

## Goal

Improve Agent-mode output so users see process and正文 as truly streaming, while keeping every displayed step and text grounded in real runtime events or real model output.

This design is intentionally narrow. It only covers Agent-mode streaming behavior. It does not change chat mode, approval UX, model selection UX, or tool protocol compatibility.

## Problem

The current Agent path has two different upstream behaviors:

1. Some channels/models emit real incremental text events.
2. Some channels/models emit only coarse snapshots or a final block of text.

This creates two user-facing problems:

1. Process updates can appear before正文, but正文 may still arrive as a sudden block.
2. When upstream lacks incremental text, the UI can feel stalled even though the task is progressing.

## Non-Goals

- No fake thoughts, fake tool calls, or fixed process templates.
- No hardcoded summary text beyond existing status translations.
- No protocol-specific branching based only on model name.
- No rewrite of the server SSE contract in this iteration.

## Approaches Considered

### A. Real-source-first with frontend smoothing

Use real incremental events whenever they exist. When upstream only returns a real full snapshot or final result, release that real text progressively on the frontend with a short cadence.

Pros:

- Preserves truthfulness.
- Minimal protocol change.
- Improves perceived streaming without inventing content.

Cons:

- Cannot recreate missing reasoning/tool detail if upstream never emitted it.

### B. Fully normalized frontend visual streaming

Force all text through an aggressive frontend smoother regardless of whether the upstream emitted real deltas or full snapshots.

Pros:

- Very consistent visual feel.

Cons:

- Can blur real event boundaries.
- Makes it harder to distinguish true incremental output from reconstructed pacing.

### C. Server-side synthetic delta generation

Convert non-incremental upstream text into many SSE deltas on the server.

Pros:

- Centralized behavior across clients.

Cons:

- Larger protocol surface.
- Higher regression risk on the existing Agent runtime path.

## Decision

Use Approach A.

The system should always prefer the most truthful source available:

1. Real text deltas from upstream.
2. Real text snapshots from upstream.
3. Real final text replayed progressively on the frontend if no earlier increments exist.

## Design

## 1. Data Layers

There are three layers:

1. Runtime truth layer
   - Task events, tool events, text deltas, text snapshots, final result.
2. Output state layer
   - Tracks the best current real text, citations, and task status.
3. Presentation layer
   - Renders process lines immediately.
   - Renders正文 continuously, either from true deltas or from paced release of a true snapshot.

## 2. Process Rendering

Process lines must only come from real task events.

Rules:

- Show process items as soon as the real event arrives.
- Keep the currently active item visually emphasized.
- Keep failed and waiting states expanded for diagnosis.
- Collapse completed process content naturally after task completion according to existing collapse rules.

## 3. Body Rendering

正文 rendering has two valid modes:

### Mode A: Native incremental mode

If the runtime produces real text deltas, render them as they arrive.

### Mode B: Smoothed snapshot mode

If the runtime only provides a real text snapshot or final result, the UI may release that exact text in small chunks over time.

Rules:

- The displayed text must be a prefix of the real returned text or an exact merge of known real snapshots.
- No generated filler words.
- No inferred reasoning.
- Short outputs should bypass slow pacing.
- Once the task reaches a terminal state, flush the full final real text immediately.

## 4. Merge Rules

When multiple real text sources arrive over time:

1. Prefer the most complete real text.
2. If a new real snapshot supersedes the displayed text, replace the buffered target with the newer real snapshot.
3. Never duplicate overlapping text while merging.
4. Preserve citations from the best available real source.

## 5. Failure and Waiting States

If the task fails or waits:

- Keep process content expanded.
- Stop any remaining paced release.
- Surface the real error text immediately.

## 6. Validation

Success for this iteration means:

1. Agent messages begin execution as early as possible once auto-start data is available.
2. Process lines appear immediately from real events.
3.正文 no longer appears as a single sudden block when only a real final text is available.
4. No fake intermediate steps are shown.
5. Terminal success and terminal failure both flush to a stable final display without text jumping backward.

## Testing Plan

Cover three cases:

1. Real delta case
   - Upstream emits text incrementally.
   - Expect direct streaming with no artificial delay.
2. Snapshot-only case
   - Upstream emits only full text or final result.
   - Expect paced release of the exact returned text.
3. Failure case
   - Upstream returns a real error.
   - Expect process to stay expanded and the real error to show immediately.

## Risks

- Over-smoothing can make short outputs feel slower than necessary.
- Merging snapshot text incorrectly can produce repeated prefixes.
- A terminal flush must not fight with any in-flight pacing timer.

## Implementation Scope

Expected touch points:

- `apps/desktop/src/components/chat/DesktopAgentTaskCard.tsx`
- `apps/desktop/src/components/chat/DesktopStreamingMarkdownMessage.tsx`
- `apps/desktop/src/lib/textStreamSmoother.ts`
- `apps/desktop/src/lib/agentOutput.ts`

Server changes are not required for this iteration unless a targeted bug fix is discovered during implementation.
