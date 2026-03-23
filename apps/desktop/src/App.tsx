import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { SettingsView } from "./components/settings/SettingsView";
import { readSavedWorkspaceRoot } from "./components/settings/DesktopGeneralSettings";
import { DesktopShellLayout } from "./components/app/DesktopShellLayout";
import { DesktopChatArea } from "./components/chat/DesktopChatArea";
import { ThemeListener } from "./components/theme/ThemeListener";
import { SidecarClient } from "./lib/sidecarClient";
import { useDesktopShellStore } from "./stores/desktopShellStore";

export function App() {
  const activeView = useDesktopShellStore((state) => state.activeView);
  const setClient = useDesktopShellStore((state) => state.setClient);
  const setSidecarStatus = useDesktopShellStore((state) => state.setSidecarStatus);
  const setSidecarError = useDesktopShellStore((state) => state.setSidecarError);
  const setWorkspaceRootInput = useDesktopShellStore((state) => state.setWorkspaceRootInput);

  useEffect(() => {
    let disposed = false;

    async function connectSidecar() {
      setSidecarStatus("loading");
      setSidecarError("");

      try {
        const info = await invoke<{ ws_url: string; token: string } | null>("get_sidecar_info");
        if (!info) throw new Error("Sidecar not ready");

        const nextClient = new SidecarClient({ wsUrl: info.ws_url, token: info.token });
        await nextClient.connect();
        if (disposed) {
          nextClient.disconnect();
          return;
        }
        setClient(nextClient);
        setSidecarStatus("connected");
      } catch (error) {
        if (disposed) return;
        setClient(null);
        setSidecarStatus("error");
        setSidecarError(error instanceof Error ? error.message : "Failed to connect");
      }
    }

    void connectSidecar();

    return () => {
      disposed = true;
    };
  }, [setClient, setSidecarError, setSidecarStatus]);

  useEffect(() => {
    const saved = readSavedWorkspaceRoot();
    if (saved) setWorkspaceRootInput(saved);
  }, [setWorkspaceRootInput]);

  return (
    <>
      <ThemeListener />
      <DesktopShellLayout activeView={activeView}>
        {activeView === "settings" ? <SettingsView /> : <DesktopChatArea />}
      </DesktopShellLayout>
    </>
  );
}
