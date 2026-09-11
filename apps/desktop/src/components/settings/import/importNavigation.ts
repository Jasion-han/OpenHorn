import type { ImportPartItem } from "shared/types";
import { useChatStore } from "../../../stores/chatStore";
import { type DesktopSettingsTab, useDesktopShellStore } from "../../../stores/desktopShellStore";
import { useProjectStore } from "../../../stores/projectStore";

const SETTINGS_TABS: DesktopSettingsTab[] = [
  "general",
  "import",
  "channels",
  "credentials",
  "agent",
  "mcp",
  "skill",
  "appearance",
  "data",
];

function asSettingsTab(id: string | undefined): DesktopSettingsTab | null {
  return id && (SETTINGS_TABS as string[]).includes(id) ? (id as DesktopSettingsTab) : null;
}

/** Whether an item link has a destination the desktop can navigate to. */
export function importLinkHasAction(link: ImportPartItem["link"]): boolean {
  if (!link) return false;
  if (link.kind === "prompt") return false;
  if (link.kind === "conversation" || link.kind === "project") return Boolean(link.id);
  return true;
}

/**
 * Jumps to whatever an import record item points at. Conversations leave the
 * settings view; everything else switches the settings tab in place.
 */
export async function openImportLink(link: NonNullable<ImportPartItem["link"]>): Promise<void> {
  const shell = useDesktopShellStore.getState();
  switch (link.kind) {
    case "conversation": {
      if (!link.id) return;
      const chat = useChatStore.getState();
      if (!chat.conversations.some((conversation) => conversation.id === link.id)) {
        await chat.loadConversations();
      }
      shell.setActiveView("chat");
      await useChatStore.getState().selectConversation(link.id);
      return;
    }
    case "mcp":
      shell.setSettingsTab("mcp");
      return;
    case "skill":
      shell.setSettingsTab("skill");
      return;
    case "channel":
      shell.setSettingsTab("channels");
      return;
    case "settings-tab":
      shell.setSettingsTab(asSettingsTab(link.id) ?? "general");
      return;
    case "project": {
      if (!link.id) return;
      const projects = useProjectStore.getState();
      projects.setActiveProject(link.id);
      projects.setExpanded(link.id, true);
      shell.setActiveView("chat");
      return;
    }
    case "prompt":
      return;
  }
}
