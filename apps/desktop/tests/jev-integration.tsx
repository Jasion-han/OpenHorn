import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "ui";
import { JevSettings } from "../src/components/settings/JevSettings";
import { ReviewWorkspacePanel } from "../src/components/workbench/reviews/ReviewWorkspacePanel";
import { useAuthStore } from "../src/stores/authStore";
import { useBackendStatusStore } from "../src/stores/backendStatusStore";
import { useDesktopShellStore } from "../src/stores/desktopShellStore";
import { useWorkbenchStore } from "../src/stores/workbenchStore";
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
useDesktopShellStore.getState().setActiveView("workbench");
useWorkbenchStore.getState().setTab("reviews");
function Fixture() {
  const [tab, setTab] = useState("settings");
  return (
    <TooltipProvider>
      <main className="min-h-screen bg-background p-6 text-foreground">
        <nav className="mb-5 flex gap-5">
          <button type="button" onClick={() => setTab("settings")}>
            Settings fixture
          </button>
          <button type="button" onClick={() => setTab("reviews")}>
            Reviews fixture
          </button>
        </nav>
        {tab === "settings" ? <JevSettings /> : <ReviewWorkspacePanel />}
      </main>
    </TooltipProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<Fixture />);
