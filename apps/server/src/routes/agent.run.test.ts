import { afterAll, expect, mock, test } from "bun:test";
// These `import * as` namespaces are LIVE views: once this file's in-test `mock.module(...)`
// calls run, they would reflect the mocked exports. So snapshot each into a plain object at
// module-eval time (before any test runs a mock) to capture the REAL modules. `mock.restore()`
// does NOT unregister `mock.module()`, so re-register these real snapshots in afterAll to stop
// this file's mocks leaking into later test files.
import * as realAgentServiceNs from "../services/agentService";
import * as realAgentTaskServiceNs from "../services/agentTaskService";
import * as realAuthServiceNs from "../services/authService";
import * as realAutoTitleServiceNs from "../services/autoTitleService";
import * as realChannelAgentCheckServiceNs from "../services/channelAgentCheckService";
import * as realChannelServiceNs from "../services/channelService";

const realAgentService = { ...realAgentServiceNs };
const realAgentTaskService = { ...realAgentTaskServiceNs };
const realAuthService = { ...realAuthServiceNs };
const realAutoTitleService = { ...realAutoTitleServiceNs };
const realChannelAgentCheckService = { ...realChannelAgentCheckServiceNs };
const realChannelService = { ...realChannelServiceNs };

afterAll(() => {
  mock.module("../services/authService", () => realAuthService);
  mock.module("../services/agentService", () => realAgentService);
  mock.module("../services/agentTaskService", () => realAgentTaskService);
  mock.module("../services/channelService", () => realChannelService);
  mock.module("../services/channelAgentCheckService", () => realChannelAgentCheckService);
  mock.module("../services/autoTitleService", () => realAutoTitleService);
});

test("POST /sessions/:id/run returns compatibility error before starting SSE run", async () => {
  let runAgentCalled = false;
  const runtimeCalls: Array<Record<string, unknown>> = [];

  mock.module("../services/authService", () => ({
    verifyToken: async () => ({ userId: "user-1" }),
    getUserById: async () => ({ id: "user-1" }),
    // requireUser resolves the request user via getUserFromToken (JWT verify +
    // tokenVersion revocation check). Mock it so the default agent router
    // authenticates instead of returning 401.
    getUserFromToken: async () => ({ id: "user-1" }),
  }));

  mock.module("../services/agentService", () => ({
    getAgentSessions: async () => [],
    getAgentSessionById: async () => ({
      id: "session-1",
      userId: "user-1",
      title: "Test",
      status: "active",
      channelId: "channel-1",
      modelId: "gpt-5.4",
    }),
    createAgentSession: async () => ({ id: "session-1" }),
    updateAgentSessionStatus: async () => ({ success: true }),
    updateAgentSessionChannel: async () => ({ success: true }),
    renameAgentSession: async () => ({ success: true }),
    deleteAgentSession: async () => ({ success: true }),
    getAgentEvents: async () => ({ events: [] }),
    deleteAgentEvent: async () => true,
    buildAgentRuntimeContext: async () => ({
      channelId: "channel-1",
      modelId: "gpt-5.4",
      globalSystemPrompt: undefined,
      liveSystemContext: undefined,
    }),
    runAgentWithConfig: async function* () {},
    runAgent: async function* () {
      runAgentCalled = true;
      yield { type: "text", content: "should not run" };
    },
  }));

  mock.module("../services/agentTaskService", () => ({
    listAgentTasks: async () => [],
    getAgentTaskById: async () => null,
    getAgentTaskDetail: async () => null,
    updateAgentTask: async () => ({ id: "task-1" }),
    listAgentTaskEvents: async () => [],
    listAgentArtifacts: async () => [],
    createAgentTask: async () => ({ id: "task-1" }),
    createAgentRun: async () => ({ id: "run-1" }),
    createAgentTaskEvent: async () => ({ id: "event-1" }),
    setAgentPlanSteps: async () => [],
    createAgentApprovalRequest: async () => ({ id: "approval-1" }),
    respondToAgentApproval: async () => ({ id: "approval-1" }),
    getLatestApprovalForTask: async () => null,
    getLatestRunForTask: async () => null,
    updateAgentPlanStepStatuses: async () => [],
    createAgentArtifact: async () => ({ id: "artifact-1" }),
    updateAgentRunStatus: async () => ({ id: "run-1" }),
    updateAgentTaskStatus: async () => ({ id: "task-1" }),
  }));

  mock.module("../services/channelService", () => ({
    getChannels: async () => [],
    getResolvedChannelForConversation: async () => ({
      channel: { id: "channel-1", provider: "openai" },
      modelId: "gpt-5.4",
    }),
    getChannelRuntimeCredentialsById: async () => ({
      channel: { id: "channel-1", provider: "openai", baseUrl: "https://relay.example.com" },
      apiKey: "test-key",
    }),
  }));

  mock.module("../services/channelAgentCheckService", () => ({
    resolveAgentRuntime: async (params: Record<string, unknown>) => {
      runtimeCalls.push(params);
      return {
        success: false as const,
        error:
          "该渠道支持普通聊天接口，但不兼容 Claude Agent SDK，无法用于 Agent 模式。它仍可用于普通聊天。",
        attempts: [],
      };
    },
    getAgentCapabilityModeFromSuccessResult: () => "claude_sdk",
    describeAgentRuntimeSelection: () => "Using fallback-model",
  }));

  mock.module("../services/autoTitleService", () => ({
    generateAutoTitle: async () => "Title",
  }));

  try {
    const { default: agent } = await import(`./agent?case=${crypto.randomUUID()}`);

    const response = await agent.request("/sessions/session-1/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "token=test-token",
      },
      body: JSON.stringify({ prompt: "hello" }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "该渠道支持普通聊天接口，但不兼容 Claude Agent SDK，无法用于 Agent 模式。它仍可用于普通聊天。",
    );
    expect(runAgentCalled).toBe(false);
    expect(runtimeCalls).toEqual([
      {
        userId: "user-1",
        requestedChannelId: "channel-1",
        requestedModelId: "gpt-5.4",
        bypassCache: true,
      },
    ]);
  } finally {
    mock.restore();
  }
});
