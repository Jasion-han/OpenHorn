# Chat Model Picker Consistency Design

**Date:** 2026-03-12

## Goal

Make the Chat "Select Model" modal consistent with Settings -> Channels regarding channel/model availability, states, and fix paths, while keeping behavior strict (no auto fallback, no auto provider/model switching).

## Background / Current Issues

- Chat model picker currently hides:
  - Disabled channels (`channel.enabled=false`)
  - Disabled models (`model.enabled=false`)
  This leads to confusion when a conversation references a model that later becomes disabled/removed: the picker appears to "lose" items.
- ChatHeader already uses strict resolution via `getEffectiveModelForConversation()` and guided fix links to Settings.
- Settings -> Channels is the single place to:
  - Enable/disable channels and models
  - Set default channel + default model
  - Sync models and see diagnostics/errors
- We want to avoid duplicating edit logic in Chat. Chat should be selection + guidance only.

## Non-Goals

- Do not add channel/model editing (enable/disable/default) inside the Chat modal.
- Do not auto-test channels, auto-fallback to another model, or auto-switch providers.
- Do not change the server-side strict default behavior (already enforced).

## Proposed UX (Recommended / Approved)

### 1) Visibility Rules

- Show all enabled channels in normal styling.
- Also show disabled channels, but visually disabled and non-interactive.
- Within each channel group:
  - Show all models (enabled and disabled).
  - Disabled models are visible but non-interactive.

### 2) Interaction Rules

- A model row is selectable only when:
  - `channel.enabled === true`
  - `model.enabled === true`
- Clicking a disabled channel/model does nothing.
- No auto fallback: if selection fails, surface the concrete error message.

### 3) Status Badges (Align with Settings)

Channel group header:
- `默认` when `channel.isDefault === true`
- `已禁用` when `channel.enabled === false`
- `缺少默认模型` when `channel.isDefault && channel.enabled && !channel.defaultModelId`

Model row:
- `默认` when `model.isDefault === true`
- `已禁用` when `model.enabled === false`
- `已选` when it matches the current conversation's effective selection

### 4) Guided Fix Path

- When ChatHeader determines the model is invalid:
  - Keep the existing behavior:
    - If scope is global: link to `/settings?tab=channels&focus=default`
    - If scope is conversation: open the modal to allow fixing per-conversation selection
- Additionally, when opening the modal while the conversation model is invalid:
  - Show the reason text from `getEffectiveModelForConversation()` at the top of the modal.
  - Provide a "Go to Channels" button that navigates to Settings guided fix.

### 5) Sync Button Behavior

- Keep the manual "Sync" action in the modal.
- After sync:
  - Refresh channels from server.
  - If sync returns `{ success: false }`, show the concrete error message.
  - If sync returns `{ success: true, error: string }`, treat as warning (synced but requires attention), and surface that message.
- Do not auto-switch provider or attempt fallback models.

## Data Flow / Single Source of Truth

- Channels/models list and states come from `api.channels.list()` and server payload `ApiChannel.models`.
- Effective selection and error reasoning comes from `getEffectiveModelForConversation()`; Chat modal consumes its "reason" string for inline guidance.
- Settings remains the only place for mutations of channel/model flags and defaults.

## Error Handling / Copy

- Always prefer server-provided error string for sync failures.
- For selection errors:
  - Show `error.message` if present; otherwise show a generic "无法更新模型选择".
- Do not mask errors by switching to other providers/models.

## Acceptance Criteria

- A disabled channel/model that exists in Settings is also visible in Chat model picker.
- Disabled items are clearly labeled and cannot be selected.
- When a conversation references a disabled/removed model, the modal can still explain the situation and direct the user to Settings to fix defaults.
- No duplicated "edit" logic appears in Chat; it remains selection-only.

## Testing Notes

- Web typecheck should pass.
- Add lightweight unit tests for the "build option groups" logic if feasible; otherwise cover via manual QA:
  - Create channel + models, disable a model, verify it still appears but cannot be selected.
  - Disable a channel, verify it still appears but entire group is disabled.
  - Make the conversation point to a removed model (by syncing to delete model), verify modal shows reason and Settings link.

