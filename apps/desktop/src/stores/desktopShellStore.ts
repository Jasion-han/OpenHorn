import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DesktopActiveView = "chat" | "settings";

export interface DesktopShellState {
  activeView: DesktopActiveView;
  sidebarCollapsed: boolean;

  setActiveView: (view: DesktopActiveView) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  activeView: "chat" as DesktopActiveView,
  sidebarCollapsed: false,
};

export function createDesktopShellStore() {
  return create<DesktopShellState>()(
    persist(
      (set) => ({
        ...INITIAL_STATE,
        setActiveView: (activeView) => set({ activeView }),
        setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
        reset: () => set({ ...INITIAL_STATE }),
      }),
      {
        name: "openhorn.desktop.shell",
        partialize: (state) => ({
          sidebarCollapsed: state.sidebarCollapsed,
        }),
      },
    ),
  );
}

export const useDesktopShellStore = createDesktopShellStore();
