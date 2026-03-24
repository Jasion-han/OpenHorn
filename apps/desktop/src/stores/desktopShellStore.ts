import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SidecarStatus = "idle" | "loading" | "connected" | "error";
export type DesktopActiveView = "chat" | "settings";

export interface DesktopShellState {
  activeView: DesktopActiveView;
  sidebarCollapsed: boolean;
  sidecarStatus: SidecarStatus;

  setActiveView: (view: DesktopActiveView) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidecarStatus: (status: SidecarStatus) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  activeView: "chat" as DesktopActiveView,
  sidebarCollapsed: false,
  sidecarStatus: "idle" as SidecarStatus,
};

export function createDesktopShellStore() {
  return create<DesktopShellState>()(
    persist(
      (set) => ({
        ...INITIAL_STATE,
        setActiveView: (activeView) => set({ activeView }),
        setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
        setSidecarStatus: (sidecarStatus) => set({ sidecarStatus }),
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
