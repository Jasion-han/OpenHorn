import { create } from "zustand";

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
  return create<DesktopShellState>((set) => ({
    ...INITIAL_STATE,
    setActiveView: (activeView) => set({ activeView }),
    setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
    setSidecarStatus: (sidecarStatus) => set({ sidecarStatus }),
    reset: () => set({ ...INITIAL_STATE }),
  }));
}

export const useDesktopShellStore = createDesktopShellStore();
