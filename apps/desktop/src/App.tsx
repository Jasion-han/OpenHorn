import { useEffect } from "react";
import { Toaster, TooltipProvider } from "ui";
import { DesktopShellLayout } from "./components/app/DesktopShellLayout";
import { DesktopChatArea } from "./components/chat/DesktopChatArea";
import { ScheduledTasksView } from "./components/scheduled-tasks/ScheduledTasksView";
import { SettingsView } from "./components/settings/SettingsView";
import { ThemeListener } from "./components/theme/ThemeListener";
import { startBackgroundTaskRunner } from "./lib/backgroundTaskRunner";
import { getTauriSidecarPlatform, hasOverlayTitleBar } from "./lib/tauriBridge";
import { useAuthStore } from "./stores/authStore";
import { useDesktopShellStore } from "./stores/desktopShellStore";
import { useSidecarStore } from "./stores/sidecarStore";

export function App() {
  const activeView = useDesktopShellStore((state) => state.activeView);
  const authReady = useAuthStore((state) => state.ready);
  const bootstrapAuth = useAuthStore((state) => state.bootstrap);

  useEffect(() => {
    if (hasOverlayTitleBar()) {
      document.documentElement.dataset.titlebar = "overlay";
    }
  }, []);

  useEffect(() => {
    const handleLinkClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.href;
      if (!href || href === "#" || href.startsWith("javascript:")) return;
      if (
        href.startsWith("http://localhost") ||
        href.startsWith("https://localhost") ||
        href.startsWith("tauri://")
      )
        return;
      e.preventDefault();
      import("@tauri-apps/plugin-shell")
        .then((mod) => mod.open(href))
        .catch(() => window.open(href, "_blank"));
    };
    document.addEventListener("click", handleLinkClick);
    return () => document.removeEventListener("click", handleLinkClick);
  }, []);

  useEffect(() => {
    void bootstrapAuth();
  }, [bootstrapAuth]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const platform = await getTauriSidecarPlatform();
      if (cancelled) return;
      useSidecarStore
        .getState()
        .attachPlatform(
          platform,
          platform === null ? "sidecar runtime requires the desktop shell" : undefined,
        );
      if (platform !== null) {
        void useSidecarStore.getState().start();
        startBackgroundTaskRunner();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!authReady) {
    return (
      <div className="flex h-dvh w-dvw items-center justify-center gap-3 bg-gradient-to-br from-background via-background to-muted/20">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <ThemeListener />
      <Toaster />
      <DesktopShellLayout activeView={activeView}>
        {activeView === "settings" ? (
          <SettingsView />
        ) : activeView === "scheduled-tasks" ? (
          <ScheduledTasksView />
        ) : (
          <DesktopChatArea />
        )}
      </DesktopShellLayout>
    </TooltipProvider>
  );
}
