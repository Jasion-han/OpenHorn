import { describe, expect, test } from "bun:test";
import type { ServerApi } from "../lib/serverApi";
import type { ApiProject } from "../types/chat";
import { useChatStore } from "./chatStore";
import {
  createProjectStore,
  folderNameFromPath,
  resolveProjectRootForConversation,
  sortProjects,
  useProjectStore,
} from "./projectStore";

function makeApi() {
  const rows = new Map<string, ApiProject>();
  let seq = 0;
  const projectsApi: ServerApi["projects"] = {
    list: async () => ({ projects: Array.from(rows.values()) }),
    create: async ({ name, rootPath }) => {
      const existing = Array.from(rows.values()).find((row) => row.rootPath === rootPath);
      if (existing) return { project: existing };
      seq += 1;
      const now = new Date(2026, 8, seq).toISOString();
      const project: ApiProject = {
        id: `p${seq}`,
        userId: "u",
        name,
        rootPath,
        isStarred: false,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(project.id, project);
      return { project };
    },
    update: async (id, data) => {
      const current = rows.get(id);
      if (!current) throw new Error("Project not found");
      const project = { ...current, ...data };
      rows.set(id, project);
      return { project };
    },
    delete: async (id) => {
      rows.delete(id);
      return { success: true };
    },
  };
  return { projects: projectsApi } as unknown as ServerApi;
}

describe("projectStore", () => {
  test("folderNameFromPath takes the last segment on either separator", () => {
    expect(folderNameFromPath("/Users/han/Project/OpenHorn")).toBe("OpenHorn");
    expect(folderNameFromPath("/Users/han/Project/OpenHorn/")).toBe("OpenHorn");
    expect(folderNameFromPath("C:\\work\\demo")).toBe("demo");
  });

  test("addProjectFromPicker names the project after the folder and opens it expanded", async () => {
    const store = createProjectStore({
      api: makeApi(),
      pickFolder: async () => "/tmp/demo/alpha",
    });
    const added = await store.getState().addProjectFromPicker();
    expect(added?.name).toBe("alpha");
    expect(store.getState().projects).toHaveLength(1);
    expect(store.getState().expanded[added?.id ?? ""]).toBe(true);
  });

  test("a cancelled picker adds nothing", async () => {
    const store = createProjectStore({ api: makeApi(), pickFolder: async () => null });
    expect(await store.getState().addProjectFromPicker()).toBe(null);
    expect(store.getState().projects).toHaveLength(0);
  });

  test("adding the same folder twice keeps a single row", async () => {
    const store = createProjectStore({ api: makeApi() });
    const first = await store.getState().addProject({ name: "a", rootPath: "/tmp/a" });
    const second = await store.getState().addProject({ name: "a-again", rootPath: "/tmp/a" });
    expect(second.id).toBe(first.id);
    expect(store.getState().projects).toHaveLength(1);
  });

  test("starred projects sort first, then by name", async () => {
    const store = createProjectStore({ api: makeApi() });
    await store.getState().addProject({ name: "beta", rootPath: "/tmp/beta" });
    const zeta = await store.getState().addProject({ name: "zeta", rootPath: "/tmp/zeta" });
    await store.getState().addProject({ name: "alpha", rootPath: "/tmp/alpha" });
    expect(store.getState().projects.map((p) => p.name)).toEqual(["alpha", "beta", "zeta"]);

    await store.getState().toggleStar(zeta.id);
    expect(store.getState().projects.map((p) => p.name)).toEqual(["zeta", "alpha", "beta"]);
    expect(sortProjects(store.getState().projects)[0].isStarred).toBe(true);
  });

  test("removeProject clears the scope and drops its conversations locally", async () => {
    const store = createProjectStore({ api: makeApi() });
    const project = await store.getState().addProject({ name: "p", rootPath: "/tmp/p" });
    store.getState().setActiveProject(project.id);

    const now = new Date();
    const filed = {
      id: "c1",
      title: "in project",
      contextLength: 4096,
      defaultMode: "agent" as const,
      lastMode: "agent" as const,
      isPinned: false,
      projectId: project.id,
      createdAt: now,
      updatedAt: now,
    };
    useChatStore.setState({
      conversations: [
        filed,
        {
          id: "c2",
          title: "plain",
          contextLength: 4096,
          defaultMode: "agent",
          lastMode: "agent",
          isPinned: false,
          projectId: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      currentConversation: filed,
    });

    await store.getState().removeProject(project.id);
    expect(store.getState().projects).toHaveLength(0);
    expect(store.getState().activeProjectId).toBe(null);
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(["c2"]);
    expect(useChatStore.getState().currentConversation).toBe(null);
  });

  test("the scope follows the selected conversation's project", async () => {
    const now = new Date();
    useProjectStore.setState({ projects: [], activeProjectId: null });
    const filed = {
      id: "scope-1",
      title: "filed",
      contextLength: 4096,
      defaultMode: "agent" as const,
      lastMode: "agent" as const,
      isPinned: false,
      projectId: "proj-x",
      createdAt: now,
      updatedAt: now,
    };
    useChatStore.setState({ currentConversation: filed });
    expect(useProjectStore.getState().activeProjectId).toBe("proj-x");

    // Going back to the welcome screen keeps the scope (new conversation stays
    // in the project until the user leaves it explicitly).
    useChatStore.setState({ currentConversation: null });
    expect(useProjectStore.getState().activeProjectId).toBe("proj-x");

    useChatStore.setState({ currentConversation: { ...filed, id: "scope-2", projectId: null } });
    expect(useProjectStore.getState().activeProjectId).toBe(null);
  });

  test("resolveProjectRootForConversation maps a filed conversation to its folder", async () => {
    useProjectStore.setState({
      projects: [
        {
          id: "proj-root",
          userId: "u",
          name: "root",
          rootPath: "/tmp/root",
          isStarred: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    expect(resolveProjectRootForConversation({ projectId: "proj-root" })).toBe("/tmp/root");
    expect(resolveProjectRootForConversation({ projectId: null })).toBe(null);
    expect(resolveProjectRootForConversation({ projectId: "missing" })).toBe(null);
    expect(resolveProjectRootForConversation(null)).toBe(null);
  });
});
