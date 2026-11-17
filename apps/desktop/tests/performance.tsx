import { createRoot } from "react-dom/client";
import { Toaster, TooltipProvider } from "ui";
import { App } from "../src/App";
import { DesktopLeftSidebar } from "../src/components/app/DesktopLeftSidebar";
import { DesktopMarkdownMessage } from "../src/components/chat/DesktopMarkdownMessage";
import { THEME_MODE_CHANGE_EVENT } from "../src/lib/theme";
import { useAuthStore } from "../src/stores/authStore";
import { useBackendStatusStore } from "../src/stores/backendStatusStore";
import { useChatStore } from "../src/stores/chatStore";
import { useProjectStore } from "../src/stores/projectStore";
import "../src/styles/globals.css";

const params = new URLSearchParams(location.search);
const count = Number(params.get("count") ?? 344);
const conversations = Array.from({ length: count }, (_, index) => ({
  id: `perf-${index}`,
  title: `Perf conversation ${String(index).padStart(6, "0")}`,
  channelId: null,
  modelId: null,
  contextLength: 4096,
  defaultMode: "agent" as const,
  lastMode: "agent" as const,
  isPinned: index < 3,
  forceWebSearch: false,
  projectId: index >= count - 12 ? "perf-project" : null,
  createdAt: new Date(Date.now() - index * 60_000),
  updatedAt: new Date(),
}));
const projects = [
  {
    id: "perf-project",
    userId: "perf-user",
    name: "Perf project",
    rootPath: "/synthetic/project",
    isStarred: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];
const user = { id: "perf-user", username: "Performance", email: "perf@openhorn.local" };
Object.assign(window, {
  perfFixture: {
    conversations,
    projects,
    user,
    select: (index: number) => useChatStore.getState().selectConversation(`perf-${index}`),
    toggleTheme: () => {
      document.documentElement.classList.toggle("dark");
      window.dispatchEvent(new Event(THEME_MODE_CHANGE_EVENT));
    },
  },
});
function Selected() {
  const current = useChatStore((state) => state.currentConversation);
  return <output data-testid="selected">{current?.title ?? "No selection"}</output>;
}
if (params.get("mode") === "sidebar") {
  useAuthStore.setState({ user, ready: true });
  useBackendStatusStore.getState().markUp();
  useBackendStatusStore.setState({ loaded: true });
  useChatStore.setState({ conversations, channels: [] });
  useProjectStore.setState({ projects, expanded: {} });
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing performance root");
const observer = new MutationObserver(() => {
  if (
    useChatStore.getState().conversations.length !== count ||
    !root.querySelector('button[aria-label="统一搜索"]')
  )
    return;
  observer.disconnect();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => Object.assign(window, { perfReadyAt: performance.now() })),
  );
});
observer.observe(root, { childList: true, subtree: true });
createRoot(root).render(
  params.get("mode") === "markdown" ? (
    <div style={{ padding: 24 }}>
      <DesktopMarkdownMessage
        content={"```javascript\nconst stable = 42;\nconsole.log(stable);\n```"}
      />
    </div>
  ) : params.get("mode") === "sidebar" ? (
    <TooltipProvider>
      <div className="flex h-screen bg-background text-foreground">
        <aside className="w-[272px] shrink-0 border-r">
          <DesktopLeftSidebar />
        </aside>
        <main className="p-6">
          <Selected />
        </main>
      </div>
      <Toaster />
    </TooltipProvider>
  ) : (
    <App />
  ),
);
