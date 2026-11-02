import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "ui";
import { DesktopChatArea } from "../../src/components/chat/DesktopChatArea";
import { getChatLabel } from "../../src/lib/i18n/agent";
import type { SidecarClient } from "../../src/lib/sidecarClient";
import { useBackendStatusStore } from "../../src/stores/backendStatusStore";
import { useChatStore } from "../../src/stores/chatStore";
import { useGenUiStore } from "../../src/stores/genUiStore";
import { useSidecarStore } from "../../src/stores/sidecarStore";
import type { Message } from "../../src/types/chat";

type ChatInput = Parameters<SidecarClient["chatStream"]>[0];
type AgentInput = Parameters<SidecarClient["runAgent"]>[0];
let active: ChatInput | null = null;
let activeAgent: AgentInput | null = null;
let agentRuns = 0;
const agentWorkspaceRoots: Array<string | undefined> = [];
let workspaceUnavailable = false;
let runs = 0;
const cancelled: string[] = [];
const approvals: Array<{ toolUseId: string; allow: boolean }> = [];
const regenerateMessage = useChatStore.getState().regenerateMessage;
const editUserMessage = useChatStore.getState().editUserMessage;
let heldRerun = false;
let settledRerun = false;
let releaseRerun: (() => void) | null = null;
const client = {
  async runAgent(input: AgentInput) {
    activeAgent = input;
    agentWorkspaceRoots.push(input.workspaceRoot);
    return `fixture-agent-${++agentRuns}`;
  },
  async setWorkspace(root: string) {
    if (workspaceUnavailable) throw new Error("fixture workspace unavailable");
    return { workspaceRoot: root || "/fixture/workspace" };
  },
  async chatStream(input: ChatInput) {
    active = input;
    if (input.protocol === "acp") throw new Error("fixture ACP requires Agent mode");
    return `fixture-${++runs}`;
  },
  async cancelRun(id: string) {
    cancelled.push(id);
  },
  async respondApproval(toolUseId: string, allow: boolean) {
    approvals.push({ toolUseId, allow });
  },
} as unknown as SidecarClient;

const root = createRoot(document.getElementById("root") as HTMLElement);
const conversation = {
  id: "failure-conversation",
  title: "Failure regression",
  channelId: "fixture-channel",
  modelId: "fixture-model",
  contextLength: 4096,
  defaultMode: "chat" as const,
  lastMode: "chat" as const,
  forceWebSearch: false,
  isPinned: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const api = {
  labels: {
    retry: getChatLabel("chat.action.regenerate"),
    edit: getChatLabel("chat.action.edit"),
    stop: "Stop",
    workspaceUnavailable: getChatLabel("chat.run.workspaceUnavailable"),
    sidecarNotReady: getChatLabel("chat.error.sidecarNotReady"),
  },
  start(protocol: "openai" | "acp" = "openai", welcome = false) {
    flushSync(() => root.render(null));
    active = null;
    activeAgent = null;
    agentRuns = 0;
    agentWorkspaceRoots.length = 0;
    workspaceUnavailable = false;
    runs = 0;
    cancelled.length = 0;
    approvals.length = 0;
    heldRerun = false;
    settledRerun = false;
    releaseRerun = null;
    useBackendStatusStore.getState().markUp();
    // The developer's uncommitted connection gate may expose a separate
    // first-load bit. The committed store only needs markUp().
    if ("loaded" in useBackendStatusStore.getState()) {
      useBackendStatusStore.setState((state) => ({ ...state, loaded: true }));
    }
    useChatStore.getState().reset();
    useChatStore.setState({
      regenerateMessage,
      editUserMessage,
      conversations: [conversation],
      currentConversation: welcome ? null : conversation,
      composerMode: "chat",
      channels: [
        {
          id: "fixture-channel",
          userId: "fixture-user",
          name: "Fixture",
          provider: "openai",
          protocol,
          enabled: true,
          isDefault: true,
          defaultModelId: "fixture-model",
          models: [
            {
              id: "fixture-model-row",
              channelId: "fixture-channel",
              modelId: "fixture-model",
              displayName: "Fixture model",
              enabled: true,
              isDefault: true,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
          ],
          hasApiKey: true,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
    });
    useSidecarStore.setState({ status: "ready", client });
    useGenUiStore.setState({ enabled: true, composerRequest: null });
    flushSync(() =>
      root.render(
        <TooltipProvider>
          <DesktopChatArea />
        </TooltipProvider>,
      ),
    );
  },
  ready: () => active !== null,
  agentReady: () => activeAgent !== null,
  agentEmit(content: string) {
    activeAgent?.onEvent({ type: "execution_event", eventType: "text", content });
  },
  agentDone(eventFirst = false) {
    // SidecarClient publishes its terminal callback before the projected event.
    if (eventFirst) activeAgent?.onEvent({ type: "done" });
    activeAgent?.onDone("fixture-agent");
    if (!eventFirst) activeAgent?.onEvent({ type: "done" });
  },
  agentFail: () => activeAgent?.onError("fixture Agent failed"),
  workspaceUnavailable() {
    workspaceUnavailable = true;
    useSidecarStore.setState({ workspaceRoot: "/fixture/previous-project" });
  },
  disconnectSidecar: (keepClient = false) =>
    useSidecarStore.setState({ ...(!keepClient ? { client: null } : {}), status: "error" }),
  reconnectSidecar: () => useSidecarStore.setState({ client, status: "ready" }),
  agentApproval() {
    activeAgent?.onApproval({
      runId: `fixture-agent-${agentRuns}`,
      toolUseId: "fixture-approval",
      toolName: "fixture-shell",
      toolInput: { command: "fixture approval command" },
    });
  },
  seedMessages(messages: Message[]) {
    useChatStore
      .getState()
      .replaceMessages(
        messages.map((message) => ({ ...message, createdAt: new Date(message.createdAt) })),
      );
  },
  showConversation(id: string) {
    const next = { ...conversation, id, title: `Fixture ${id}` };
    useChatStore.setState((state) => ({
      conversations: state.conversations.some((item) => item.id === id)
        ? state.conversations
        : [...state.conversations, next],
      currentConversation: next,
      messages: state.messages.filter((message) => message.conversationId === id),
    }));
  },
  deferRerun(kind: "retry" | "edit", reject: boolean) {
    const gate = new Promise<void>((resolve) => {
      releaseRerun = resolve;
    });
    const delayResponse = async (response: Response) => {
      // A response may already be buffered while asynchronous transport/setup
      // work finishes. Its continuation still belongs to the stopped turn.
      const buffered = new Response(await response.text(), {
        status: response.status,
        headers: response.headers,
      });
      heldRerun = true;
      await gate;
      settledRerun = true;
      if (reject) throw new Error("fixture delayed rerun failed");
      return buffered;
    };
    if (kind === "retry") {
      useChatStore.setState({
        regenerateMessage: async (...args) => delayResponse(await regenerateMessage(...args)),
      });
    } else {
      useChatStore.setState({
        editUserMessage: async (...args) => delayResponse(await editUserMessage(...args)),
      });
    }
  },
  releaseRerun: () => releaseRerun?.(),
  protocol(protocol: "openai" | "acp") {
    useChatStore.setState((state) => ({
      channels: state.channels.map((channel) => ({ ...channel, protocol })),
    }));
  },
  mode: (mode: "chat" | "agent") => useChatStore.getState().setComposerMode(mode),
  policy: (enabled: boolean) => useGenUiStore.getState().setEnabled(enabled),
  emit(content: string) {
    void active?.onEvent({ type: "execution_event", eventType: "text", content });
  },
  fail: () => active?.onError("fixture stream interrupted"),
  done: () => active?.onDone("fixture"),
  snapshot: () => ({
    runs,
    agentRuns,
    agentWorkspaceRoots,
    cancelled,
    approvals,
    heldRerun,
    settledRerun,
    error: useChatStore.getState().error,
    streaming: useChatStore.getState().isStreaming,
    loading: useChatStore.getState().isLoading,
    streamingConversationId: useChatStore.getState().streamingConversationId,
    messages: useChatStore.getState().messages,
    policy: useGenUiStore.getState().enabled,
    chatMessages: active?.messages ?? null,
    agentRequest: activeAgent
      ? {
          prompt: activeAgent.prompt,
          systemPrompt: activeAgent.systemPrompt,
          permissionMode: activeAgent.permissionMode,
        }
      : null,
  }),
  async reload() {
    await useChatStore.getState().loadMessages(conversation.id);
  },
  remount() {
    flushSync(() => root.render(null));
    flushSync(() =>
      root.render(
        <TooltipProvider>
          <DesktopChatArea />
        </TooltipProvider>,
      ),
    );
  },
};
Object.assign(window, { failureChat: api });
api.start();
