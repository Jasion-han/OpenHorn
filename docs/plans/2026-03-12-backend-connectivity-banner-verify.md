# Backend Connectivity Banner Verify

## Run

```bash
cd /Users/han/Project/OpenHorn
pnpm dev:server
```

```bash
cd /Users/han/Project/OpenHorn
pnpm dev:web
```

Open: `http://localhost:3001`

## Verify Offline

1. Stop server (3000).
2. Refresh Settings / Chat / Agent.
3. Expected:
   - Header shows `后端离线` with `Retry`.
   - Notifications do not spam; only one network-error toast within ~10s.

## Verify Recovery (Soft Refresh)

1. Start server (3000) again.
2. Click `Retry` in the header.
3. Expected:
   - Header offline badge disappears.
   - A success toast `连接已恢复` appears.
   - Current page data repopulates automatically (Channels/Workspaces/Sessions).
   - No full page reload (chat/agent input should not be cleared by a reload).

