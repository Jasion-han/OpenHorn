import { create } from "zustand";
import type { SidecarClient } from "../lib/sidecarClient";

export type SidecarStatus = "idle" | "loading" | "connected" | "error";
export type DesktopActiveView = "chat" | "settings";

export interface DesktopShellState {
  activeView: DesktopActiveView;
  sidebarCollapsed: boolean;
  sidecarStatus: SidecarStatus;
  sidecarError: string;
  client: SidecarClient | null;
  workspaceRootInput: string;

  setActiveView: (view: DesktopActiveView) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidecarStatus: (status: SidecarStatus) => void;
  setSidecarError: (error: string) => void;
  setClient: (client: SidecarClient | null) => void;
  setWorkspaceRootInput: (value: string) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  activeView: "chat" as DesktopActiveView,
  sidebarCollapsed: false,
  sidecarStatus: "idle" as SidecarStatus,
  sidecarError: "",
  client: null as SidecarClient | null,
  workspaceRootInput: "",
};

export function createDesktopShellStore() {
  return create<DesktopShellState>((set) => ({
    ...INITIAL_STATE,
    setActiveView: (activeView) => set({ activeView }),
    setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
    setSidecarStatus: (sidecarStatus) => set({ sidecarStatus }),
    setSidecarError: (sidecarError) => set({ sidecarError }),
    setClient: (client) => set({ client }),
    setWorkspaceRootInput: (workspaceRootInput) => set({ workspaceRootInput }),
    reset: () => set({ ...INITIAL_STATE }),
  }));
}

export const useDesktopShellStore = createDesktopShellStore();
