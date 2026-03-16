import { create } from 'zustand';
import type { SidecarClient } from '../lib/sidecarClient';

export type SidecarStatus = 'idle' | 'loading' | 'connected' | 'error';

export type FsEntry = {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size?: number;
  mtimeMs?: number;
};

export type EditorTab = {
  path: string;
  content: string;
  dirty: boolean;
};

type IdeState = {
  sidecarStatus: SidecarStatus;
  sidecarError: string;
  client: SidecarClient | null;

  workspaceRootInput: string;
  currentDir: string;
  entries: FsEntry[];

  tabs: EditorTab[];
  activePath: string | null;

  setSidecarStatus: (status: SidecarStatus) => void;
  setSidecarError: (error: string) => void;
  setClient: (client: SidecarClient | null) => void;
  setWorkspaceRootInput: (value: string) => void;

  setCurrentDir: (dir: string) => void;
  loadDir: (dir: string) => Promise<void>;
  openFile: (filePath: string) => Promise<void>;
  setActivePath: (filePath: string) => void;
  updateActiveContent: (content: string) => void;
  saveActiveFile: () => Promise<void>;
  closeTab: (filePath: string) => void;
};

export const useIdeStore = create<IdeState>((set, get) => ({
  sidecarStatus: 'idle',
  sidecarError: '',
  client: null,

  workspaceRootInput: '',
  currentDir: '.',
  entries: [],

  tabs: [],
  activePath: null,

  setSidecarStatus: (status) => set({ sidecarStatus: status }),
  setSidecarError: (error) => set({ sidecarError: error }),
  setClient: (client) => set({ client }),
  setWorkspaceRootInput: (value) => set({ workspaceRootInput: value }),

  setCurrentDir: (dir) => set({ currentDir: dir }),

  loadDir: async (dir) => {
    const { client } = get();
    if (!client) throw new Error('Sidecar not connected');
    const result = await client.request<{ entries: FsEntry[] }>('fs.list', { dir });
    set({ currentDir: dir, entries: result.entries });
  },

  openFile: async (filePath) => {
    const { client, tabs } = get();
    if (!client) throw new Error('Sidecar not connected');
    const existing = tabs.find((t) => t.path === filePath);
    if (existing) {
      set({ activePath: filePath });
      return;
    }
    const result = await client.request<{ content: string }>('fs.read', { path: filePath });
    const nextTabs = [{ path: filePath, content: result.content, dirty: false }, ...tabs];
    set({ tabs: nextTabs, activePath: filePath });
  },

  setActivePath: (filePath) => set({ activePath: filePath }),

  updateActiveContent: (content) => {
    const { activePath, tabs } = get();
    if (!activePath) return;
    set({
      tabs: tabs.map((t) => (t.path === activePath ? { ...t, content, dirty: true } : t)),
    });
  },

  saveActiveFile: async () => {
    const { client, activePath, tabs } = get();
    if (!client) throw new Error('Sidecar not connected');
    if (!activePath) return;
    const tab = tabs.find((t) => t.path === activePath);
    if (!tab) return;
    await client.request('fs.write', { path: tab.path, content: tab.content });
    set({
      tabs: tabs.map((t) => (t.path === tab.path ? { ...t, dirty: false } : t)),
    });
  },

  closeTab: (filePath) => {
    const { tabs, activePath } = get();
    const nextTabs = tabs.filter((t) => t.path !== filePath);
    const nextActive = activePath === filePath ? (nextTabs[0]?.path ?? null) : activePath;
    set({ tabs: nextTabs, activePath: nextActive });
  },
}));

export function parentDir(dir: string): string {
  if (dir === '.' || dir === '') return '.';
  const normalized = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 1) return '.';
  return parts.slice(0, -1).join('/');
}

export function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

export function languageFromPath(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'typescript';
    case 'js':
      return 'javascript';
    case 'jsx':
      return 'javascript';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    default:
      return undefined;
  }
}
