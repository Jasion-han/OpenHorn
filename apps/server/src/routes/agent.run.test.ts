import { expect, mock, test } from "bun:test";

test("POST /sessions/:id/run returns compatibility error before starting SSE run", async () => {
  let runAgentCalled = false;
  const originalFetch = globalThis.fetch;

  mock.module("../services/authService", () => ({
    verifyToken: async () => ({ userId: "user-1" }),
    getUserById: async () => ({ id: "user-1" }),
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
    getResolvedChannelForConversation: async () => ({
      channel: { id: "channel-1", provider: "anthropic" },
      modelId: "gpt-5.4",
    }),
    getChannelRuntimeCredentialsById: async () => ({
      channel: { id: "channel-1", provider: "anthropic", baseUrl: "https://relay.example.com" },
      apiKey: "test-key",
    }),
  }));

  mock.module("../services/autoTitleService", () => ({
    generateAutoTitle: async () => "Title",
  }));

  globalThis.fetch = mock(
    async () => new Response("missing", { status: 404 }),
  ) as unknown as typeof fetch;

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
    expect(await response.text()).toBe("该渠道不支持 Anthropic /v1/messages 接口（返回 404）。");
    expect(runAgentCalled).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    mock.restore();
  }
});
