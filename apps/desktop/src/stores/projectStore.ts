import type { Project } from "shared/types";
import { create } from "zustand";
import { createServerApi, type ServerApi } from "../lib/serverApi";
import type { ApiProject } from "../types/chat";
import { useChatStore } from "./chatStore";

/**
 * Sidebar projects: local folders the user added. A conversation filed under a
 * project runs its agent turns with the project's folder as the sidecar
 * workspace root, and the sidebar groups the project's conversations under it.
 *
 * `activeProjectId` is the *scope* for the next new conversation. It follows
 * whatever the user last selected: a project header (scope = that project) or
 * a conversation (scope = that conversation's project, null for a plain one).
 */
export interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  /** Collapsed/expanded state per project id; unknown ids are collapsed. */
  expanded: Record<string, boolean>;
  loading: boolean;
  error: string | null;

  loadProjects: () => Promise<void>;
  /** Opens the folder dialog and adds the picked folder. Null = user cancelled. */
  addProjectFromPicker: () => Promise<Project | null>;
  addProject: (input: { name: string; rootPath: string }) => Promise<Project>;
  renameProject: (id: string, name: string) => Promise<void>;
  toggleStar: (id: string) => Promise<void>;
  /** Removes the folder from the sidebar together with every conversation filed under it. */
  removeProject: (id: string) => Promise<void>;
  setActiveProject: (id: string | null) => void;
  toggleExpanded: (id: string) => void;
  setExpanded: (id: string, open: boolean) => void;
  getProject: (id: string | null | undefined) => Project | null;
}

const EXPANDED_STORAGE_KEY = "openhorn.sidebar.projectsExpanded";

function readExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeExpanded(expanded: Record<string, boolean>) {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(expanded));
  } catch {}
}

function hydrate(project: ApiProject): Project {
  return {
    ...project,
    createdAt: new Date(project.createdAt),
    updatedAt: new Date(project.updatedAt),
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

/** The last path segment, as the default project name for a picked folder. */
export function folderNameFromPath(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return name || trimmed;
}

/** Sidebar order: starred first, then by name (locale-aware), then by creation. */
export function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => {
    if (a.isStarred !== b.isStarred) return a.isStarred ? -1 : 1;
    const byName = a.name.localeCompare(b.name, "zh-Hans-CN", { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

export interface ProjectStoreDeps {
  api?: ServerApi;
  pickFolder?: () => Promise<string | null>;
}

async function defaultPickFolder(): Promise<string | null> {
  const { getTauriSidecarPlatform } = await import("../lib/tauriBridge");
  const platform = await getTauriSidecarPlatform();
  if (!platform) throw new Error("Folder picker is only available in the desktop app");
  return platform.pickWorkspaceDir();
}

export function createProjectStore(deps: ProjectStoreDeps = {}) {
  const api = deps.api ?? createServerApi();
  const pickFolder = deps.pickFolder ?? defaultPickFolder;

  return create<ProjectState>((set, get) => ({
    projects: [],
    activeProjectId: null,
    expanded: readExpanded(),
    loading: false,
    error: null,

    async loadProjects() {
      set({ loading: true, error: null });
      try {
        const { projects } = await api.projects.list();
        set({ projects: sortProjects(projects.map(hydrate)), loading: false });
      } catch (error) {
        set({ loading: false, error: toErrorMessage(error) });
      }
    },

    async addProjectFromPicker() {
      const rootPath = await pickFolder();
      if (!rootPath) return null;
      return get().addProject({ name: folderNameFromPath(rootPath), rootPath });
    },

    async addProject(input) {
      const { project } = await api.projects.create(input);
      const added = hydrate(project);
      set((state) => {
        const known = state.projects.some((item) => item.id === added.id);
        const projects = known
          ? state.projects.map((item) => (item.id === added.id ? added : item))
          : [...state.projects, added];
        // A freshly added folder opens expanded so the user sees where new
        // conversations will land.
        const expanded = { ...state.expanded, [added.id]: true };
        writeExpanded(expanded);
        return { projects: sortProjects(projects), expanded, error: null };
      });
      return added;
    },

    async renameProject(id, name) {
      const nextName = name.trim();
      if (!nextName) return;
      const { project } = await api.projects.update(id, { name: nextName });
      const updated = hydrate(project);
      set((state) => ({
        projects: sortProjects(
          state.projects.map((item) => (item.id === updated.id ? updated : item)),
        ),
      }));
    },

    async toggleStar(id) {
      const current = get().projects.find((item) => item.id === id);
      if (!current) return;
      const { project } = await api.projects.update(id, { isStarred: !current.isStarred });
      const updated = hydrate(project);
      set((state) => ({
        projects: sortProjects(
          state.projects.map((item) => (item.id === updated.id ? updated : item)),
        ),
      }));
    },

    async removeProject(id) {
      await api.projects.delete(id);
      // Mirror the server's delete semantics locally: the project's conversations
      // are gone, so drop them from the list right away; if one of them was open,
      // fall back to the welcome screen.
      useChatStore.setState((chat) => {
        const conversations = chat.conversations.filter((item) => item.projectId !== id);
        if (chat.currentConversation?.projectId === id) {
          return { conversations, currentConversation: null, messages: [] };
        }
        return { conversations };
      });
      set((state) => {
        const expanded = { ...state.expanded };
        delete expanded[id];
        writeExpanded(expanded);
        return {
          projects: state.projects.filter((item) => item.id !== id),
          activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
          expanded,
        };
      });
    },

    setActiveProject(id) {
      set({ activeProjectId: id });
    },

    toggleExpanded(id) {
      get().setExpanded(id, !(get().expanded[id] ?? false));
    },

    setExpanded(id, open) {
      set((state) => {
        const expanded = { ...state.expanded, [id]: open };
        writeExpanded(expanded);
        return { expanded };
      });
    },

    getProject(id) {
      if (!id) return null;
      return get().projects.find((item) => item.id === id) ?? null;
    },
  }));
}

export const useProjectStore = createProjectStore();

// The scope follows the selected conversation, whichever surface selected it
// (sidebar row, search hit, scheduled-run row…). Leaving for the welcome screen
// (currentConversation → null) keeps the scope: "new conversation" from inside a
// project stays in that project until the user leaves it explicitly.
useChatStore.subscribe((state, prev) => {
  const current = state.currentConversation;
  if (!current || current.id === prev.currentConversation?.id) return;
  const scope = current.projectId ?? null;
  if (useProjectStore.getState().activeProjectId !== scope) {
    useProjectStore.getState().setActiveProject(scope);
  }
});

/**
 * Folder the sidecar should run in for a conversation: its project's folder, or
 * null to fall back to the saved/default workspace.
 */
export function resolveProjectRootForConversation(
  conversation: { projectId?: string | null } | null | undefined,
): string | null {
  if (!conversation?.projectId) return null;
  return useProjectStore.getState().getProject(conversation.projectId)?.rootPath ?? null;
}
