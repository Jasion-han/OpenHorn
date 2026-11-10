import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RecipeRequirements } from "shared/types";
import { Toaster, TooltipProvider } from "ui";
import { DesktopChatArea } from "../src/components/chat/DesktopChatArea";
import { MessageActionBar } from "../src/components/chat/DesktopMessageActionBar";
import { ScheduledTasksView } from "../src/components/scheduled-tasks/ScheduledTasksView";
import { ArtifactSaveDialog } from "../src/components/workbench/ArtifactSaveDialog";
import { WorkbenchView } from "../src/components/workbench/WorkbenchView";
import type { SidecarClient } from "../src/lib/sidecarClient";
import { THEME_MODE_CHANGE_EVENT } from "../src/lib/theme";
import { useAuthStore } from "../src/stores/authStore";
import { useBackendStatusStore } from "../src/stores/backendStatusStore";
import { useChatStore } from "../src/stores/chatStore";
import { useDesktopShellStore } from "../src/stores/desktopShellStore";
import { useProjectStore } from "../src/stores/projectStore";
import { useScheduledTaskStore } from "../src/stores/scheduledTaskStore";
import { useSidecarStore } from "../src/stores/sidecarStore";
import { useWorkbenchStore } from "../src/stores/workbenchStore";
import type { Message } from "../src/types/chat";
import "../src/styles/globals.css";

const date = new Date("2026-11-06T00:00:00Z");
const conversation = {
  id: "source-conversation",
  title: "Synthetic source",
  channelId: "fixture-channel",
  modelId: "fixture-model",
  contextLength: 8192,
  defaultMode: "agent" as const,
  lastMode: "agent" as const,
  forceWebSearch: false,
  isPinned: false,
  createdAt: date,
  updatedAt: date,
};
const source: Message = {
  id: "source-message",
  conversationId: conversation.id,
  role: "assistant",
  mode: "agent",
  content:
    "# Saved report\n\nOriginal 中文 content.\n\n```html-ui\n<button onclick=\"this.textContent='Changed'\">Inspect</button>\n```",
  agentRun: {
    status: "completed",
    summary: "",
    steps: [
      {
        type: "text",
        content:
          "# Saved report\n\nOriginal 中文 content.\n\n```html-ui\n<button onclick=\"this.textContent='Changed'\">Inspect</button>\n```",
      },
    ],
  },
  createdAt: date,
};
const channels = [
  {
    id: "fixture-channel",
    userId: "fixture-user",
    name: "Synthetic channel",
    provider: "openai",
    protocol: "openai" as const,
    enabled: true,
    isDefault: true,
    defaultModelId: "fixture-model",
    models: [
      {
        id: "fixture-model-row",
        channelId: "fixture-channel",
        modelId: "fixture-model",
        displayName: "Synthetic model",
        enabled: true,
        isDefault: true,
        createdAt: date,
        updatedAt: date,
      },
    ],
    hasApiKey: true,
    createdAt: date,
    updatedAt: date,
  },
];
const runs: unknown[] = [];
const client = {
  async runAgent(input: unknown) {
    runs.push(input);
    return "synthetic-run";
  },
  async cancelRun() {},
  async setWorkspace(root: string) {
    return { workspaceRoot: root || "/fixture/default" };
  },
  async respondApproval() {},
} as unknown as SidecarClient;
useAuthStore.setState({
  user: { id: "fixture-user", username: "Synthetic", email: "fixture@example.invalid" },
  ready: true,
});
useBackendStatusStore.getState().markUp();
useBackendStatusStore.setState({ loaded: true });
useChatStore.setState({
  channels,
  conversations: [conversation],
  currentConversation: conversation,
  messages: [source],
  composerMode: "agent",
});
useProjectStore.setState({
  projects: [
    {
      id: "fixture-project",
      userId: "fixture-user",
      name: "Synthetic project",
      rootPath: "/fixture/project",
      isStarred: false,
      createdAt: date,
      updatedAt: date,
    },
  ],
});
useSidecarStore.setState({
  status: "ready",
  client,
  ensureWorkspace: async (root) => root || "/fixture/default",
});
useDesktopShellStore.getState().setActiveView("workbench");
function Fixture() {
  const view = useDesktopShellStore((s) => s.activeView);
  const pending = useDesktopShellStore((s) => s.pendingPrompt);
  const sourceId = useWorkbenchStore((s) => s.artifactMessageId);
  const [realChat, setRealChat] = useState(false);
  const [fixtureMessage, setFixtureMessage] = useState(source);
  Object.assign(window, {
    workbenchTest: {
      runs: () => runs,
      pending: () => useDesktopShellStore.getState().pendingPrompt,
      source: () => source,
      showReply: (conversationId: string) => {
        setFixtureMessage({ ...source, id: "continuation-reply", conversationId });
        setRealChat(false);
        useDesktopShellStore.getState().setActiveView("chat");
      },
      openTasks: () => useDesktopShellStore.getState().openScheduledTasks("tasks"),
      reloadTasks: () => useScheduledTaskStore.getState().loadTasks(),
      navigate: () => useDesktopShellStore.getState().setActiveView("settings"),
      show: () => {
        setRealChat(false);
        useDesktopShellStore.getState().setActiveView("workbench");
      },
      dark: () => {
        document.documentElement.classList.toggle("dark");
        window.dispatchEvent(new Event(THEME_MODE_CHANGE_EVENT));
      },
      mountDraft: (draft: {
        text: string;
        files: File[];
        conversationId: string;
        autoSend?: boolean;
      }) => {
        runs.length = 0;
        const target = { ...conversation, id: draft.conversationId };
        useChatStore.setState({
          channels,
          conversations: [conversation, target],
          currentConversation: target,
          messages: [],
          composerMode: "agent",
          isStreaming: false,
          streamingMessageId: null,
        });
        useDesktopShellStore.getState().setPendingPrompt(draft);
        useDesktopShellStore.getState().setActiveView("chat");
        setRealChat(true);
      },
      startRealChat: (
        target: string,
        text = "Target-bound handoff",
        requirements?: RecipeRequirements,
      ) => {
        runs.length = 0;
        useChatStore.setState({
          channels,
          conversations: [conversation],
          currentConversation: conversation,
          messages: [],
          composerMode: "agent",
          isStreaming: false,
          streamingMessageId: null,
        });
        useDesktopShellStore
          .getState()
          .setPendingPrompt({ text, files: [], conversationId: target, requirements });
        useDesktopShellStore.getState().setActiveView("chat");
        setRealChat(true);
      },
    },
  });
  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-background text-foreground">
        <div data-testid="fixture-controls" className="flex shrink-0 gap-3 p-2">
          <button
            type="button"
            onClick={() => {
              setRealChat(false);
              useDesktopShellStore.getState().setActiveView("workbench");
            }}
          >
            Workbench fixture
          </button>
          <button
            type="button"
            onClick={() => {
              setRealChat(false);
              useDesktopShellStore.getState().setActiveView("chat");
            }}
          >
            Source fixture
          </button>
        </div>
        <main className="min-h-0 flex-1">
          {view === "workbench" ? (
            <WorkbenchView />
          ) : view === "scheduled-tasks" ? (
            <StrictMode>
              <ScheduledTasksView />
            </StrictMode>
          ) : realChat ? (
            <DesktopChatArea />
          ) : (
            <section className="p-6 group">
              <pre data-testid="handoff">{JSON.stringify(pending)}</pre>
              <MessageActionBar
                message={fixtureMessage}
                canEdit={false}
                canRetry={false}
                canDelete={false}
                isStreaming={false}
                onEdit={() => {}}
                onRetry={() => {}}
                onDelete={() => {}}
              />
            </section>
          )}
        </main>
        <ArtifactSaveDialog
          messageId={sourceId}
          onClose={() => useWorkbenchStore.getState().setArtifactMessageId(null)}
          onSaved={() => useWorkbenchStore.getState().refreshArtifacts()}
        />
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
