import { createRoot } from "react-dom/client";
import { Toaster, TooltipProvider } from "ui";
import { DesktopLeftSidebar } from "../src/components/app/DesktopLeftSidebar";
import { DesktopChatArea } from "../src/components/chat/DesktopChatArea";
import { useAuthStore } from "../src/stores/authStore";
import { useBackendStatusStore } from "../src/stores/backendStatusStore";
import { useChatStore } from "../src/stores/chatStore";
import { useConversationDraftStore } from "../src/stores/conversationDraftStore";
import { useDesktopShellStore } from "../src/stores/desktopShellStore";
import { useSidecarStore } from "../src/stores/sidecarStore";
import "../src/styles/globals.css";
const now = new Date();
useAuthStore.setState({
  user: {
    id: "reviews-browser-user",
    username: "Synthetic",
    email: "reviews-browser@test.invalid",
  },
  ready: true,
});
useBackendStatusStore.getState().markUp();
useBackendStatusStore.setState({ loaded: true });
useChatStore.setState({
  channels: [
    {
      id: "reviews-browser-channel",
      userId: "reviews-browser-user",
      name: "Synthetic API",
      provider: "openai",
      protocol: "openai",
      hasApiKey: true,
      enabled: true,
      isDefault: true,
      defaultModelId: "synthetic-model",
      createdAt: now,
      updatedAt: now,
      models: [
        {
          id: "reviews-browser-model",
          channelId: "reviews-browser-channel",
          modelId: "synthetic-model",
          displayName: "Synthetic model",
          enabled: true,
          isDefault: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
  ],
});

useSidecarStore.setState({ status: "ready", client: null });
useChatStore.setState({ composerMode: "chat" });
useDesktopShellStore.getState().setActiveView("chat");
void useChatStore.getState().loadConversations();
Object.assign(window, {
  welcomeTest: {
    diagnostics: () => {
      const state = useChatStore.getState();
      return {
        current: state.currentConversation,
        loading: state.isLoading,
        streaming: state.isStreaming,
        mode: state.composerMode,
        error: state.error,
        pending: useDesktopShellStore.getState().pendingPrompt,
      };
    },
    pending: () => useDesktopShellStore.getState().pendingPrompt,
    current: () => useChatStore.getState().currentConversation?.id,
    draft: (id: string) => useConversationDraftStore.getState().drafts[id],
    welcome: () => {
      useChatStore.getState().startNewConversation();
      useDesktopShellStore.getState().setActiveView("chat");
    },
  },
});
function Fixture() {
  const view = useDesktopShellStore((s) => s.activeView);
  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background text-foreground">
        <DesktopLeftSidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {view === "chat" ? <DesktopChatArea /> : <section>Fixture navigation</section>}
        </main>
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
