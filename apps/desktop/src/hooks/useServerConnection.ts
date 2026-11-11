import { serverConnectionNotice, useBackendStatusStore } from "../stores/backendStatusStore";

/**
 * Connection state for components: `ready` gates server writes, `loaded` tells
 * real data from not-yet-loaded defaults, `notice` picks the message to show
 * instead.
 */
export function useServerConnection() {
  const status = useBackendStatusStore((state) => state.status);
  const loaded = useBackendStatusStore((state) => state.loaded);
  const loading = useBackendStatusStore((state) => state.loading);
  const notice = serverConnectionNotice({ status, loaded, loading });
  return { ready: notice === null, loaded, notice };
}
