# OpenHorn Channels Phase 1 Design

## Goal

Build a global user-level channel system that supports multiple models per channel and can be shared by future Chat and Agent flows.

## Scope

- Global user-level channels only
- Multiple models under each channel
- Default channel and default model per channel
- Server-side encrypted API keys
- Channel connection test and model sync

## Out of Scope

- Workspace-private channels
- Team sharing and permissions
- Full model capability matrix UI
- Chat and Agent UI refactor beyond basic channel consumption

## Data Model

- `channels`
  - `id`
  - `userId`
  - `name`
  - `provider`
  - `baseUrl`
  - `apiKey`
  - `enabled`
  - `isDefault`
  - `createdAt`
  - `updatedAt`
- `channel_models`
  - `id`
  - `channelId`
  - `modelId`
  - `displayName`
  - `enabled`
  - `isDefault`
  - `createdAt`
  - `updatedAt`

## API Shape

- `GET /channels`
- `GET /channels/:id`
- `POST /channels`
- `PUT /channels/:id`
- `DELETE /channels/:id`
- `POST /channels/:id/test`
- `POST /channels/:id/fetch-models`
- `GET /channels/:id/models`
- `PUT /channels/:id/models`
- `POST /channels/:id/set-default`
- `POST /channels/:id/models/:modelId/set-default`

## UX

- Create the channel first with provider credentials
- Test the connection from the channel card
- Fetch models after the channel is valid
- Manage enabled/default model state in the channel details area

## Migration

- Add `enabled` to `channels`
- Add `channel_models`
- If an existing channel has a legacy `model`, create a default `channel_models` record for it during runtime migration
