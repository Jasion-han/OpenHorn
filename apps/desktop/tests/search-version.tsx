import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { Toaster, TooltipProvider } from "ui";
import { DesktopLeftSidebar } from "../src/components/app/DesktopLeftSidebar";
import { WorkbenchView } from "../src/components/workbench/WorkbenchView";
import { useAuthStore } from "../src/stores/authStore";
import { useBackendStatusStore } from "../src/stores/backendStatusStore";
import { useChatStore } from "../src/stores/chatStore";
import { useDesktopShellStore } from "../src/stores/desktopShellStore";
import { useProjectStore } from "../src/stores/projectStore";
import "../src/styles/globals.css";

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
useDesktopShellStore.getState().setActiveView("workbench");
void useProjectStore.getState().loadProjects();
void useChatStore.getState().loadConversations();
Object.assign(window, {
  searchVersionTest: {
    handoff: (text: string, autoSend = false) => {
      const id = useChatStore.getState().currentConversation?.id;
      if (id)
        useDesktopShellStore
          .getState()
          .setPendingPrompt({ text, files: [], conversationId: id, autoSend });
    },
    logout: () => useAuthStore.getState().setUser(null),
  },
});
const realChat = new URLSearchParams(window.location.search).has("realChat");
const RealChat = lazy(async () => ({
  default: (await import("../src/components/chat/DesktopChatArea")).DesktopChatArea,
}));
function Fixture() {
  const view = useDesktopShellStore((s) => s.activeView);
  const conversation = useChatStore((s) => s.currentConversation);
  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background text-foreground">
        <DesktopLeftSidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {view === "workbench" ? (
            <WorkbenchView />
          ) : realChat ? (
            <Suspense fallback={null}>
              <RealChat />
            </Suspense>
          ) : (
            <section className="p-6">
              <h1>{conversation?.title || "Synthetic welcome"}</h1>
              <button
                type="button"
                onClick={() => useDesktopShellStore.getState().setActiveView("workbench")}
              >
                Workbench fixture
              </button>
            </section>
          )}
        </main>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
