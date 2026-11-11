import { useAuthStore } from "../stores/authStore";
import { BACKEND_UP_EVENT, useBackendStatusStore } from "../stores/backendStatusStore";
import { useChatStore } from "../stores/chatStore";
import { useImportStore } from "../stores/importStore";
import { useProjectStore } from "../stores/projectStore";
import { useScheduledTaskStore } from "../stores/scheduledTaskStore";
import { useWelcomeSuggestionStore } from "../stores/welcomeSuggestionStore";
import { getDesktopBackendBase } from "./backendBase";
import { syncScheduledRunsAfterLoad } from "./backgroundTaskRunner";
import { getSidebarLabel } from "./i18n/agent";
import { hideNotification, notifySuccess } from "./notify";
import { createRequiredStateLoader } from "./requiredStateLoader";
import { sidecarPersistence } from "./sidecarPersistence";

/**
 * Every piece of server-backed state the desktop shell holds in stores. This is
 * the only place that list lives: first start, the sidebar's Retry and the
 * automatic reconnect all run it through `useBackendStatusStore.connect()`, so
 * a recovery can never restore some of it and leave the rest at defaults.
 *
 * Panels that keep server data in component state (settings pages) are not
 * listed; they mount-load on their own and re-fetch on `BACKEND_UP_EVENT`.
 *
 * Scheduled runs are synced after the load. The server reconciles expired leases
 * when the runner reads the pending queue — see `syncScheduledRunsAfterLoad`.
 *
 * Individual failures are recorded by each store; network failures reach the
 * connection store through the request layer, which is what marks the load as
 * failed and schedules a reconnect.
 */
let identityRevision = 0;
useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) identityRevision++;
});
const stateOwner = () => {
  const id = useAuthStore.getState().user?.id;
  return id ? `${getDesktopBackendBase()}:${id}:${identityRevision}` : null;
};
const loadRequiredState = createRequiredStateLoader({
  owner: stateOwner,
  identity: async () => {
    await useAuthStore.getState().bootstrap();
    const owner = stateOwner();
    if (!owner || useAuthStore.getState().error) throw new Error("server_identity_unavailable");
    return owner;
  },
  groups: [
    { key: "channels", load: () => useChatStore.getState().loadChannels() },
    { key: "conversations", load: () => useChatStore.getState().loadConversations() },
    {
      key: "projects",
      load: async () => {
        await useProjectStore.getState().loadProjects();
        if (useProjectStore.getState().error) throw new Error("project_load_failed");
      },
    },
    {
      key: "tasks",
      load: async () => {
        await useScheduledTaskStore.getState().loadTasks();
        if (useScheduledTaskStore.getState().error) throw new Error("task_load_failed");
      },
    },
    {
      key: "runs",
      load: async () => {
        if (!(await useScheduledTaskStore.getState().loadRuns()))
          throw new Error("run_load_failed");
      },
    },
  ],
});
export async function loadServerState(): Promise<void> {
  await loadRequiredState();
  // Optional helpers do not turn an HTTP failure into a false empty required roster.
  void Promise.allSettled([
    useImportStore.getState().loadPromptTemplates(),
    useWelcomeSuggestionStore.getState().load(),
  ]);
  const recovery = sidecarPersistence as { recover?: () => Promise<void> };
  void recovery.recover?.();
  void syncScheduledRunsAfterLoad();
}

function onReconnected() {
  hideNotification("backend_down");
  notifySuccess(
    getSidebarLabel("sidebar.notify.reconnectedTitle"),
    getSidebarLabel("sidebar.notify.reconnectedBody"),
  );
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BACKEND_UP_EVENT));
}

let started = false;

/** Called once by the app shell. Idempotent so a StrictMode double-mount is harmless. */
export function startServerConnection(): Promise<boolean> {
  const store = useBackendStatusStore.getState();
  if (started) return store.connect();
  started = true;
  return store.start({ loader: loadServerState, onReconnected });
}
