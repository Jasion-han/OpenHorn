# Settings Guided Fix Default Model Verify

## Setup

```bash
cd /Users/han/Project/OpenHorn
pnpm dev:server
pnpm dev:web
```

Open: `http://localhost:3001`

## Verify Guided Navigation

1. Ensure there is no valid global default model (e.g. no channels, or default channel exists but no default model).
2. From header, click `Set default model`.
3. Expected:
   - Navigates to `/settings?tab=channels&focus=default`.
   - Settings selects `Channels` tab automatically.
   - If channels exist: the selected target channel card expands and scrolls into view.
   - If no channels: the "Add channel" modal opens automatically.
4. Refresh the page once.
5. Expected:
   - The modal/auto-expand does not repeatedly trigger (focus params are cleared).

## Verify "Keep Last Provider"

1. Open the "Add channel" modal.
2. Change Provider to a non-default option (e.g. `Anthropic`).
3. Close the modal.
4. Re-open the modal.
5. Expected:
   - Provider remains the last selected value.

