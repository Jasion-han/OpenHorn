import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DesktopActiveView = "chat" | "settings";
export type DesktopSettingsTab = "general" | "channels" | "credentials" | "agent" | "appearance";

export interface DesktopShellState {
  activeView: DesktopActiveView;
  sidebarCollapsed: boolean;
  settingsTab: DesktopSettingsTab;

  setActiveView: (view: DesktopActiveView) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSettingsTab: (tab: DesktopSettingsTab) => void;
  openSettings: (tab?: DesktopSettingsTab) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  activeView: "chat" as DesktopActiveView,
  sidebarCollapsed: false,
  settingsTab: "channels" as DesktopSettingsTab,
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
        reset: () => set({ ...INITIAL_STATE }),
      }),
      {
        name: "openhorn.desktop.shell",
        partialize: (state) => ({
          sidebarCollapsed: state.sidebarCollapsed,
          settingsTab: state.settingsTab,
        }),
      },
    ),
  );
}

export const useDesktopShellStore = createDesktopShellStore();
