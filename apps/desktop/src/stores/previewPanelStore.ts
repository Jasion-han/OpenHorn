import { create } from "zustand";

/**
 * Right-hand preview panel: workspace files (code view) and web pages
 * (embedded Tauri child webview) opened from links in assistant replies.
 */

export type PreviewTab =
  | {
      id: string;
      kind: "file";
      path: string;
      line?: number;
      endLine?: number;
      conversationId: string | null;
    }
  | {
      id: string;
      kind: "web";
      url: string;
      title?: string;
      loading: boolean;
      /** Native history availability, refreshed after page loads. */
      canGoBack: boolean;
      canGoForward: boolean;
    };

type FilePreviewTab = Extract<PreviewTab, { kind: "file" }>;
type WebPreviewTab = Extract<PreviewTab, { kind: "web" }>;

/** Fields a tab may be patched with (web tabs: url/title/loading/history from page events). */
export type PreviewTabPatch = Partial<Omit<FilePreviewTab, "id" | "kind">> &
  Partial<Omit<WebPreviewTab, "id" | "kind">>;

export const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "openhorn.previewPanel.width";
export const PREVIEW_PANEL_DEFAULT_WIDTH = 480;
export const PREVIEW_PANEL_MIN_WIDTH = 360;
export const PREVIEW_PANEL_MAX_WINDOW_RATIO = 0.7;

export interface PreviewPanelState {
  isOpen: boolean;
  /**
   * Collapsed = open but tucked away: the column is hidden (not unmounted, so
   * web tabs keep their child webview and history) and an expand button takes
   * its place. Deliberately not persisted, like the sidebar's collapsed state.
   */
  collapsed: boolean;
  width: number;
  tabs: PreviewTab[];
  activeTabId: string | null;

  openFile: (params: {
    path: string;
    line?: number;
    endLine?: number;
    conversationId?: string | null;
  }) => void;
  openUrl: (url: string) => void;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  closePanel: () => void;
  collapsePanel: () => void;
  expandPanel: () => void;
  togglePanel: () => void;
  setWidth: (width: number) => void;
  updateTab: (id: string, patch: PreviewTabPatch) => void;
}

let fallbackIdCounter = 0;

/** Tab ids double as Tauri webview labels, so they must stay `[A-Za-z0-9_-]`. */
export function generatePreviewTabId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID().replace(/[^A-Za-z0-9_-]/g, "");
  }
  fallbackIdCounter += 1;
  return `tab-${fallbackIdCounter}`;
}

/** Clamps a requested width to [MIN, 70% of the window]. */
export function clampPreviewPanelWidth(width: number, windowWidth: number): number {
  const max = Math.max(
    PREVIEW_PANEL_MIN_WIDTH,
    Math.floor(windowWidth * PREVIEW_PANEL_MAX_WINDOW_RATIO),
  );
  if (!Number.isFinite(width)) return PREVIEW_PANEL_DEFAULT_WIDTH;
  return Math.min(max, Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.round(width)));
}

function readPersistedWidth(): number {
  try {
    const raw = localStorage.getItem(PREVIEW_PANEL_WIDTH_STORAGE_KEY);
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch {}
  return PREVIEW_PANEL_DEFAULT_WIDTH;
}

function persistWidth(width: number) {
  try {
    localStorage.setItem(PREVIEW_PANEL_WIDTH_STORAGE_KEY, String(width));
  } catch {}
}

function currentWindowWidth(): number {
  return typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 1440;
}

/** Closing the active tab activates its nearest neighbour (right, then left). */
function pickNextActive(tabs: PreviewTab[], closedIndex: number): string | null {
  if (tabs.length === 0) return null;
  const next = tabs[Math.min(closedIndex, tabs.length - 1)];
  return next ? next.id : null;
}

export function createPreviewPanelStore(options?: { initialWidth?: number }) {
  return create<PreviewPanelState>()((set, get) => ({
    isOpen: false,
    collapsed: false,
    width: clampPreviewPanelWidth(
      options?.initialWidth ?? readPersistedWidth(),
      currentWindowWidth(),
    ),
    tabs: [],
    activeTabId: null,

    openFile: ({ path, line, endLine, conversationId = null }) => {
      const { tabs } = get();
      const existing = tabs.find((tab) => tab.kind === "file" && tab.path === path);
      if (existing) {
        set({
          isOpen: true,
          collapsed: false,
          activeTabId: existing.id,
          tabs: tabs.map((tab) =>
            tab.id === existing.id && tab.kind === "file"
              ? { ...tab, line, endLine, conversationId }
              : tab,
          ),
        });
        return;
      }
      const id = generatePreviewTabId();
      set({
        isOpen: true,
        collapsed: false,
        activeTabId: id,
        tabs: [...tabs, { id, kind: "file", path, line, endLine, conversationId }],
      });
    },

    openUrl: (url) => {
      const { tabs } = get();
      const existing = tabs.find((tab) => tab.kind === "web" && tab.url === url);
      if (existing) {
        set({ isOpen: true, collapsed: false, activeTabId: existing.id });
        return;
      }
      const id = generatePreviewTabId();
      set({
        isOpen: true,
        collapsed: false,
        activeTabId: id,
        tabs: [
          ...tabs,
          { id, kind: "web", url, loading: true, canGoBack: false, canGoForward: false },
        ],
      });
    },

    activateTab: (id) => {
      if (!get().tabs.some((tab) => tab.id === id)) return;
      set({ activeTabId: id, isOpen: true, collapsed: false });
    },

    closeTab: (id) => {
      const { tabs, activeTabId, collapsed } = get();
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return;
      const remaining = tabs.filter((tab) => tab.id !== id);
      const nextActive = activeTabId === id ? pickNextActive(remaining, index) : activeTabId;
      const stillOpen = remaining.length > 0;
      set({
        tabs: remaining,
        activeTabId: nextActive,
        isOpen: stillOpen,
        collapsed: stillOpen && collapsed,
      });
    },

    closePanel: () => set({ isOpen: false, collapsed: false, tabs: [], activeTabId: null }),

    collapsePanel: () => {
      if (get().isOpen) set({ collapsed: true });
    },

    expandPanel: () => {
      if (get().isOpen) set({ collapsed: false });
    },

    togglePanel: () => {
      const { isOpen, collapsed } = get();
      if (isOpen) set({ collapsed: !collapsed });
    },

    setWidth: (width) => {
      const clamped = clampPreviewPanelWidth(width, currentWindowWidth());
      set({ width: clamped });
      persistWidth(clamped);
    },

    updateTab: (id, patch) => {
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? ({ ...tab, ...patch } as PreviewTab) : tab)),
      }));
    },
  }));
}

export const usePreviewPanelStore = createPreviewPanelStore();
