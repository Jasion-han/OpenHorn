import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster, TooltipProvider } from "ui";
import { DesktopLeftSidebar } from "../src/components/app/DesktopLeftSidebar";
import { AgentSettings } from "../src/components/settings/AgentSettings";
import { DataTransferSettings } from "../src/components/settings/DataTransferSettings";
import { GeneralSettings } from "../src/components/settings/GeneralSettings";
import { McpSettings } from "../src/components/settings/McpSettings";
import type { SidecarClient } from "../src/lib/sidecarClient";
import { useAuthStore } from "../src/stores/authStore";
import { useBackendStatusStore } from "../src/stores/backendStatusStore";
import { useChatStore } from "../src/stores/chatStore";
import { useDesktopShellStore } from "../src/stores/desktopShellStore";
import { useSidecarStore } from "../src/stores/sidecarStore";
import "../src/styles/globals.css";

useAuthStore.setState({
  user: { id: "fixture-user", username: "Synthetic", email: "fixture@openhorn.local" },
  ready: true,
});
useBackendStatusStore.getState().markUp();
useBackendStatusStore.setState({ loaded: true });
useDesktopShellStore.getState().openSettings("general");
useChatStore.setState({ conversations: [], channels: [] });
const probeFixture = { hold: false, calls: 0, release: null as (() => void) | null };
Object.assign(window, { probeFixture });
useSidecarStore.setState({
  status: "ready",
  client: {
    async testMcpServer() {
      probeFixture.calls++;
      if (probeFixture.hold)
        await new Promise<void>((done) => {
          probeFixture.release = done;
        });
      return { ok: true, toolCount: 1, toolNames: ["synthetic-tool"] };
    },
  } as unknown as SidecarClient,
});
function Fixture() {
  const [tab, setTab] = useState("general");
  const [show, setShow] = useState(true);
  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background text-foreground">
        <aside className="w-64 shrink-0 border-r">
          <DesktopLeftSidebar />
        </aside>
        <main className="min-w-0 flex-1 overflow-auto p-6">
          <nav className="mb-4 flex gap-3">
            <button
              type="button"
              onClick={() => {
                setTab("agent");
                setShow(true);
              }}
            >
              Agent fixture
            </button>
            <button
              type="button"
              onClick={() => {
                setTab("mcp");
                setShow(true);
                useDesktopShellStore.getState().openSettings("mcp");
              }}
            >
              MCP fixture
            </button>
            <button
              type="button"
              onClick={() => {
                setTab("general");
                setShow(true);
                useDesktopShellStore.getState().openSettings("general");
              }}
            >
              General fixture
            </button>
            <button
              type="button"
              onClick={() => {
                setTab("data");
                setShow(true);
                useDesktopShellStore.getState().openSettings("data");
              }}
            >
              Data fixture
            </button>
            <button
              type="button"
              onClick={() => {
                setShow(false);
                useDesktopShellStore.getState().setActiveView("chat");
              }}
            >
              Leave fixture
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event("openhorn:backend-up"))}
            >
              Reconnect fixture
            </button>
          </nav>
          {show ? (
            tab === "general" ? (
              <GeneralSettings />
            ) : tab === "agent" ? (
              <AgentSettings />
            ) : tab === "mcp" ? (
              <McpSettings />
            ) : (
              <DataTransferSettings />
            )
          ) : (
            <p>Outside settings</p>
          )}
        </main>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
