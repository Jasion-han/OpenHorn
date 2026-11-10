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
function Fixture() {
  const view = useDesktopShellStore((s) => s.activeView);
  const conversation = useChatStore((s) => s.currentConversation);
  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background text-foreground">
        <DesktopLeftSidebar />
        <main className="min-w-0 flex-1">
          {view === "workbench" ? (
            <WorkbenchView />
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
