# OpenHorn Chat Global Default Design

## Goal

Chat always uses the global default channel + default model. No per-conversation or per-message selection.

## Scope

- Use `channels.isDefault` and `channel_models.isDefault` for Chat routing
- Ignore `conversations.channelId` for Chat requests
- Remove any UI logic that binds a conversation to a channel

## Out of Scope

- Per-conversation model selection
- Per-message model selection

## Server Behavior

- Chat endpoints resolve channel via `getResolvedChannelForUser(userId, null)`
- If no default channel or no enabled model, return `error: No channel configured`
- Conversation creation ignores `channelId`

## Client Behavior

- Sidebar create conversation does not pass `channelId`
- No channel/model selectors in Chat UI
- Users set default channel/model only in Settings
