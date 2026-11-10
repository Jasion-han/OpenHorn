import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster, TooltipProvider } from "ui";
import { DesktopLeftSidebar } from "../src/components/app/DesktopLeftSidebar";
import { LibraryView } from "../src/components/library/LibraryView";
import { useAuthStore } from "../src/stores/authStore";
import { useBackendStatusStore } from "../src/stores/backendStatusStore";
import { useChatStore } from "../src/stores/chatStore";
import { useDesktopShellStore } from "../src/stores/desktopShellStore";
import { useLibraryDraftStore } from "../src/stores/libraryDraftStore";
import { useLibraryStore } from "../src/stores/libraryStore";
import { useProjectStore } from "../src/stores/projectStore";

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
useDesktopShellStore.getState().setActiveView("library");

Object.assign(window, {
  libraryTest: {
    draft: () => useLibraryDraftStore.getState(),
    target: (id: string) => useLibraryStore.getState().openDocument(id),
    scope: (id: string | null) => useProjectStore.getState().setActiveProject(id),
    pending: () => useDesktopShellStore.getState().pendingPrompt,
    mode: () => useChatStore.getState().composerMode,
    leave: () => useDesktopShellStore.getState().setActiveView("chat"),
    back: () => {
      useDesktopShellStore.getState().setPendingPrompt(null);
      useDesktopShellStore.getState().setActiveView("library");
    },
    account: () =>
      useAuthStore.setState({
        user: { id: "another-browser-user", username: "Other", email: "other@test.invalid" },
      }),
  },
});
function Fixture() {
  const view = useDesktopShellStore((state) => state.activeView);
  const pending = useDesktopShellStore((state) => state.pendingPrompt);
  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background text-foreground">
        <DesktopLeftSidebar />
        <main className="min-w-0 flex-1">
          {view === "library" ? (
            <LibraryView />
          ) : (
            <section className="p-6">
              <button
                type="button"
                onClick={() => {
                  useDesktopShellStore.getState().setPendingPrompt(null);
                  useDesktopShellStore.getState().setActiveView("library");
                }}
              >
                Back fixture
              </button>
              <pre data-testid="handoff" className="whitespace-pre-wrap">
                {pending?.text}
              </pre>
            </section>
          )}
        </main>
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
