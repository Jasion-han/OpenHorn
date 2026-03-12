# Chat UI Default Model Indicator Design

## Goal

Show the global default provider + model in the Chat input area, and guide users to settings when missing.

## Scope

- Display `Provider · Model` near the input area
- Show an inline warning banner when default channel/model is missing
- Disable send action when not configured
- Centralize default-channel resolution to avoid duplicate checks

## Out of Scope

- Allow changing channel/model from Chat
- Auto-refresh via push events

## Data Source

- `api.channels.list()` for global channels
- default channel: `isDefault === true`
- default model: `models.find(m => m.isDefault)`

## UX

- Input area shows `Provider · Model` in a subtle badge or text
- If missing:
  - show banner “未配置默认渠道或模型，请先完成设置”
  - add “去设置” button linking to `/settings`
  - disable send button

## Error Handling

- If channels cannot be loaded, show banner “无法获取默认渠道，请重试”
