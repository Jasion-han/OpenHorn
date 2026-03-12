# Agent Header Default Model Design

**Date:** 2026-03-12

## Goal

Make the Agent page show the effective global default `Provider · Model` (same semantics as Chat), and provide a clear fix path when the default channel/model is missing or invalid.

## Background

- Agent runtime currently always uses the global default channel/model on the server (`getResolvedChannelForUser(userId, null)`).
- Chat already displays effective model state and offers a guided Settings fix path.
- Users report the Agent page feels split from Chat; missing defaults are not obvious until "Run" fails.

## Non-Goals

- No per-session model selection inside Agent.
- No automatic testing, fallback models, or provider switching.

## Proposed UX (Recommended)

### Header Display

In Agent page top-right area (same row as Workspace selector):

- If a usable global default exists:
  - Show a small badge `继承默认`
  - Show a compact, truncating `Button` (or `Badge`) with label `${provider} · ${modelId}`
  - Clicking it navigates to Settings -> Channels (guided focus to default), so users can adjust defaults.
- If no usable global default exists:
  - Show a `Button` "去设置默认模型" linking to `/settings?tab=channels&focus=default`

### Run Guard

Before starting a run:

- If no usable global default exists:
  - Do not start the SSE request.
  - Show a clear error notification: "未配置可用的默认渠道/默认模型，请先在设置中完成配置。"
  - Provide the Settings fix link in the UI (header button already covers this).

## Data / Logic Source of Truth

- Fetch channels via `api.channels.list()` in Agent page bootstrap.
- Resolve effective default via existing `getGlobalDefaultChannel(channels)` (strict: requires enabled channel + enabled default model).

## Acceptance Criteria

- Agent header shows `Provider · Model` when defaults are configured, and remains readable on narrow screens (truncation, no layout overflow).
- When defaults are missing, Agent header shows "去设置默认模型" and "Run" produces a clear error without silent no-op.
- No automatic fallback or provider switching occurs.

