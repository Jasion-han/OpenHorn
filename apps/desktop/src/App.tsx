import { useEffect } from "react";
import { Toaster, TooltipProvider } from "ui";
import { DesktopAuthScreen } from "./components/auth/DesktopAuthScreen";
import { SettingsView } from "./components/settings/SettingsView";
import { DesktopShellLayout } from "./components/app/DesktopShellLayout";
import { DesktopChatArea } from "./components/chat/DesktopChatArea";
import { ThemeListener } from "./components/theme/ThemeListener";
import { UNAUTHORIZED_EVENT } from "./lib/serverApi";
import { getTauriSidecarPlatform } from "./lib/tauriBridge";
import { useAuthStore } from "./stores/authStore";
import { useChatStore } from "./stores/chatStore";
import { useDesktopShellStore } from "./stores/desktopShellStore";
import { useSidecarStore } from "./stores/sidecarStore";

export function App() {
  const activeView = useDesktopShellStore((state) => state.activeView);
  const setActiveView = useDesktopShellStore((state) => state.setActiveView);
  const authReady = useAuthStore((state) => state.ready);
  const user = useAuthStore((state) => state.user);
  const bootstrapAuth = useAuthStore((state) => state.bootstrap);
  const logout = useAuthStore((state) => state.logout);
  const resetChat = useChatStore((state) => state.reset);

  useEffect(() => {
    void bootstrapAuth();

    const handleUnauthorized = () => {
      void logout({ skipRequest: true });
      resetChat();
      setActiveView("chat");
    };

    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    };
  }, [bootstrapAuth, logout, resetChat, setActiveView]);

  // Sidecar bootstrap. We attach the platform bridge once per app mount.
  // When running under plain Vite (no Tauri runtime) getTauriSidecarPlatform
  // returns null and the store parks in "unsupported". When running under
  // Tauri we kick off start() which spawns the sidecar binary and
  // performs the WS handshake in the background. The component does not
  // block on the result — the sidecar runtime is opt-in for individual
  // agent tasks (see the Composer "run locally" switch).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const platform = await getTauriSidecarPlatform();
      if (cancelled) return;
      useSidecarStore.getState().attachPlatform(
        platform,
        platform === null ? "sidecar runtime requires the desktop shell" : undefined,
      );
      if (platform !== null) {
        void useSidecarStore.getState().start();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <ThemeListener />
      <Toaster />
      {!authReady ? (
        <div className="flex h-dvh w-dvw items-center justify-center gap-3 bg-gradient-to-br from-background via-background to-muted/20">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">正在检查登录状态...</p>
        </div>
      ) : !user ? (
        <DesktopAuthScreen />
      ) : (
        <DesktopShellLayout activeView={activeView}>
          {activeView === "settings" ? <SettingsView /> : <DesktopChatArea />}
        </DesktopShellLayout>
      )}
    </TooltipProvider>
  );
}
