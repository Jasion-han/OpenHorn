import { useChatStore } from "../stores/chatStore";
import { useProjectStore } from "../stores/projectStore";
import { useScheduledTaskStore } from "../stores/scheduledTaskStore";
import { useWorkbenchStore } from "../stores/workbenchStore";

/** Refresh metadata after a confirmed import, without starting models or scheduled runs. */
export async function refreshImportedResources() {
  await Promise.allSettled([
    useChatStore.getState().loadConversations({ background: true }),
    useChatStore.getState().loadChannels(),
    useProjectStore.getState().loadProjects(),
    useScheduledTaskStore.getState().loadTasks(),
  ]);
  useWorkbenchStore.getState().refreshArtifacts();
}
