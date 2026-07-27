import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DesktopActiveView = "chat" | "settings";
export type DesktopSettingsTab =
  | "general"
  | "channels"
  | "credentials"
  | "agent"
  | "mcp"
  | "skill"
  | "appearance";

export interface DesktopShellState {
  activeView: DesktopActiveView;
  sidebarCollapsed: boolean;
  settingsTab: DesktopSettingsTab;
  fullAccessEnabled: boolean;
  /**
   * Draft composed on the welcome screen before any conversation existed. The
   * welcome screen creates the conversation and parks it here; the chat area
   * picks it up once that conversation is current and sends it. Deliberately not
   * persisted — a draft that outlived a restart would send itself unprompted,
   * and File handles do not survive serialization anyway.
   *
   * Mode and web-search are NOT carried here: they seed the conversation at
   * creation time. Correcting them afterwards would be too late — the store
   * update inside `createConversation` flushes the chat area's effects (and
   * hence the send) before the welcome screen's `await` even resumes.
   */
  pendingPrompt: { text: string; files: File[] } | null;

  setActiveView: (view: DesktopActiveView) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSettingsTab: (tab: DesktopSettingsTab) => void;
  openSettings: (tab?: DesktopSettingsTab) => void;
  toggleFullAccess: () => void;
  setPendingPrompt: (prompt: { text: string; files: File[] } | null) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  activeView: "chat" as DesktopActiveView,
  sidebarCollapsed: false,
  settingsTab: "channels" as DesktopSettingsTab,
  fullAccessEnabled: false,
  pendingPrompt: null as { text: string; files: File[] } | null,
};

export function createDesktopShellStore() {
  return create<DesktopShellState>()(
    persist(
      (set) => ({
        ...INITIAL_STATE,
        setActiveView: (activeView) => set({ activeView }),
        setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
        setSettingsTab: (settingsTab) => set({ settingsTab }),
        openSettings: (settingsTab = "channels") =>
          set({
            activeView: "settings",
            settingsTab,
          }),
        toggleFullAccess: () => set((state) => ({ fullAccessEnabled: !state.fullAccessEnabled })),
        setPendingPrompt: (pendingPrompt) => set({ pendingPrompt }),
        reset: () => set({ ...INITIAL_STATE }),
      }),
      {
        name: "openhorn.desktop.shell",
        // sidebarCollapsed is deliberately NOT persisted: collapsing is a
        // temporary "give me room" gesture, so every launch starts expanded
        // rather than reopening into whatever state the last session ended in.
        partialize: (state) => ({
          settingsTab: state.settingsTab,
          fullAccessEnabled: state.fullAccessEnabled,
        }),
      },
    ),
  );
}

export const useDesktopShellStore = createDesktopShellStore();
