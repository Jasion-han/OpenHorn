import { useEffect } from "react";
import { Toaster } from "ui";
import { DesktopAuthScreen } from "./components/auth/DesktopAuthScreen";
import { SettingsView } from "./components/settings/SettingsView";
import { DesktopShellLayout } from "./components/app/DesktopShellLayout";
import { DesktopChatArea } from "./components/chat/DesktopChatArea";
import { ThemeListener } from "./components/theme/ThemeListener";
import { UNAUTHORIZED_EVENT } from "./lib/serverApi";
import { useAuthStore } from "./stores/authStore";
import { useChatStore } from "./stores/chatStore";
import { useDesktopShellStore } from "./stores/desktopShellStore";

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

  return (
    <>
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
    </>
  );
}
