// Actual runner/store/ownership with a closed synthetic API surface. No network,
// model, native host, credentials or normal application profile is involved.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScheduledTask, ScheduledTaskRun } from "shared/types";
import type { SidecarClient } from "./sidecarClient";

const [owned, scenario] = process.argv.slice(2);
const now = 1_700_000_000_000;
Date.now = () => now;
const count = scenario === "collision" ? 2 : 1;
const tasks: ScheduledTask[] = Array.from({ length: count }, (_, index) => ({
  id: `task-${index}`,
  userId: "fixture-user",
  title: `Synthetic task ${index}`,
  prompt: `Synthetic prompt ${index}`,
  frequency: "daily",
  time: "12:00",
  enabled: true,
  notifyOnComplete: false,
  createdAt: new Date(now),
  updatedAt: new Date(now),
}));
const runs: ScheduledTaskRun[] = tasks.map((task, index) => ({
  id: `run-${index}`,
  taskId: task.id,
  userId: "fixture-user",
  status: "pending",
  conversationId: `conversation-${index}`,
  startedAt: new Date(now),
}));
const conversations = runs.map((_run, index) => ({
  id: `conversation-${index}`,
  title: "Synthetic scheduled conversation",
  channelId: "fixture-channel",
  modelId: "fixture-model",
  contextLength: 4096,
  defaultMode: "agent" as const,
  lastMode: "agent" as const,
  isPinned: false,
  forceWebSearch: false,
  projectId: scenario.startsWith("project-") ? "fixture-project" : null,
  createdAt: new Date(now),
  updatedAt: new Date(now),
}));
const saved: Array<Record<string, unknown>> = [];
const completed: Array<Record<string, unknown>> = [];
const unknownRequests: string[] = [];
let projectLoads = 0;
let releaseProjects!: () => void;
let projectsRequested!: () => void;
const projectGate = new Promise<void>((resolve) => {
  releaseProjects = resolve;
});
const projectStarted = new Promise<void>((resolve) => {
  projectsRequested = resolve;
});
const project = {
  id: "fixture-project",
  userId: "fixture-user",
  name: "Synthetic project",
  rootPath: "/fixture/project",
  isStarred: false,
  createdAt: new Date(now),
  updatedAt: new Date(now),
};
let finished!: () => void;
const completion = new Promise<void>((resolve) => {
  finished = resolve;
});
let changeWorkspace: (() => void) | undefined;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["http://localhost:3002", "http://127.0.0.1:3002"].includes(url.origin)) {
    unknownRequests.push(url.origin + url.pathname);
    throw new Error("Unexpected synthetic API origin");
  }
  if (url.pathname === "/scheduled-tasks") return Response.json({ tasks });
  if (url.pathname === "/scheduled-tasks/runs") return Response.json({ runs });
  const claim = /^\/scheduled-tasks\/runs\/(run-\d+)\/claim$/.exec(url.pathname);
  if (claim) {
    const run = runs.find((run) => run.id === claim[1]);
    if (!run) throw new Error("Unknown synthetic claim");
    run.status = "running";
    return Response.json({ claimed: true });
  }
  const complete = /^\/scheduled-tasks\/runs\/(run-\d+)\/complete$/.exec(url.pathname);
  if (complete) {
    const body = JSON.parse(String(init?.body));
    completed.push({ id: complete[1], ...body });
    const run = runs.find((run) => run.id === complete[1]);
    if (!run) throw new Error("Unknown synthetic completion");
    run.status = body.status;
    if (completed.length === count) finished();
    return Response.json({ success: true });
  }
  if (url.pathname === "/conversations") return Response.json({ conversations });
  if (url.pathname === "/projects") {
    projectLoads++;
    if (scenario === "project-cold") {
      projectsRequested();
      await projectGate;
    }
    return Response.json({ projects: scenario === "project-cold" ? [project] : [] });
  }
  if (url.pathname === "/channels/fixture-channel/credentials")
    return Response.json({
      credentials: {
        apiKey: "synthetic-only",
        protocol: "openai",
        modelId: "fixture-model",
        baseUrl: null,
      },
    });
  if (url.pathname === "/mcp/servers") return Response.json({ servers: [] });
  if (url.pathname === "/settings") {
    changeWorkspace?.();
    return Response.json({ settings: {} });
  }
  if (/^\/messages\/conversation-\d+$/.test(url.pathname)) return Response.json({ messages: [] });
  if (url.pathname === "/messages/sync-sidecar") {
    const body = JSON.parse(String(init?.body));
    saved.push(body);
    return Response.json({
      userMessageId: `saved-user-${body.conversationId}`,
      assistantMessageId: `saved-assistant-${body.conversationId}`,
    });
  }
  unknownRequests.push(url.pathname);
  throw new Error(`Unexpected synthetic API path: ${url.pathname}`);
}) as typeof fetch;

const { useChatStore } = await import("../stores/chatStore");
const { useScheduledTaskStore } = await import("../stores/scheduledTaskStore");
const { useSidecarStore } = await import("../stores/sidecarStore");
const { useProjectStore } = await import("../stores/projectStore");
useChatStore.getState().reset();
const channel = {
  id: "fixture-channel",
  userId: "fixture-user",
  name: "Synthetic",
  provider: "openai",
  protocol: "openai" as const,
  enabled: true,
  isDefault: true,
  hasApiKey: true,
  defaultModelId: "fixture-model",
  models: [
    {
      id: "fixture-model-row",
      channelId: "fixture-channel",
      modelId: "fixture-model",
      displayName: "Synthetic",
      enabled: true,
      isDefault: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
  ],
  createdAt: new Date(now),
  updatedAt: new Date(now),
};
const pairs: string[][] = [];
const seed = useChatStore.getState().seedConversationMessages;
useChatStore.setState({
  channels: [channel],
  conversations,
  seedConversationMessages: (id, messages) => {
    pairs.push(messages.map((message) => message.id));
    seed(id, messages);
  },
});
useScheduledTaskStore.setState({ tasks, runs });
if (scenario === "project-workspace")
  useProjectStore.setState({
    projects: [
      {
        id: "fixture-project",
        userId: "fixture-user",
        name: "Synthetic project",
        rootPath: "/fixture/project",
        isStarred: false,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      },
    ],
  });

const workspaceRequests: string[] = [];
const agentRoots: Array<string | undefined> = [];
let currentRoot = "/previous/project";
let allStarted!: () => void;
const allAgents = new Promise<void>((resolve) => {
  allStarted = resolve;
});
let agentCalls = 0;
const client = {
  setWorkspace: async (root: string) => {
    workspaceRequests.push(root);
    if (scenario === "workspace-failure") throw new Error("Synthetic unavailable workspace");
    currentRoot = root === "/fixture/project" ? "/canonical/project" : "/canonical/default";
    return { workspaceRoot: currentRoot };
  },
  runAgent: async (input: Parameters<SidecarClient["runAgent"]>[0]) => {
    const index = agentCalls++;
    agentRoots.push(input.workspaceRoot);
    if (agentCalls === count) allStarted();
    void allAgents.then(() => {
      input.onEvent({
        type: "execution_event",
        taskId: `synthetic-run-${index}`,
        runId: `synthetic-run-${index}`,
        eventType: "text",
        content: `answer-${input.prompt}`,
      });
      input.onDone?.(`synthetic-run-${index}`);
      input.onEvent({
        type: "done",
        taskId: `synthetic-run-${index}`,
        runId: `synthetic-run-${index}`,
      });
    });
    return `synthetic-run-${index}`;
  },
  cancelRun: async () => {},
  respondApproval: async () => {},
} as unknown as SidecarClient;
useSidecarStore.setState({ status: "ready", client, workspaceRoot: currentRoot });
if (scenario === "project-workspace" || scenario === "project-cold")
  changeWorkspace = () => {
    currentRoot = "/another/project";
    useSidecarStore.setState({ workspaceRoot: currentRoot });
  };
// The public startup sweep is exercised; recurring wall-clock polling is not.
globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
const { startBackgroundTaskRunner } = await import("./backgroundTaskRunner");
const timeout = setTimeout(() => {
  throw new Error("Synthetic runner did not settle");
}, 2000);
startBackgroundTaskRunner();
let callsBeforeProjects: number | null = null;
if (scenario === "project-cold") {
  const first = await Promise.race([
    projectStarted.then(() => "requested"),
    completion.then(() => "completed-before-projects"),
  ]);
  if (first === "requested") {
    callsBeforeProjects = agentCalls;
    releaseProjects();
  }
}
await completion;
clearTimeout(timeout);
await Promise.resolve();
await writeFile(
  path.join(owned, "result.json"),
  JSON.stringify({
    saved,
    completed,
    pairs,
    agentCalls,
    agentRoots,
    workspaceRequests,
    unknownRequests,
    projectLoads,
    callsBeforeProjects,
  }),
);
