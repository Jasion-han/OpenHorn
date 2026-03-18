import { useEffect, useState } from "react";
import { Button, Input, SettingsCard, SettingsRow, SettingsSection } from "ui";

import { useIdeStore } from "../../stores/ideStore";

const WORKSPACE_ROOT_STORAGE_KEY = "openhorn.desktop.workspaceRoot";

export function readSavedWorkspaceRoot(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(WORKSPACE_ROOT_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveWorkspaceRoot(value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKSPACE_ROOT_STORAGE_KEY, value);
  } catch {
    // ignore
  }
}

export function DesktopGeneralSettings() {
  const workspaceRootInput = useIdeStore((s) => s.workspaceRootInput);
  const setWorkspaceRootInput = useIdeStore((s) => s.setWorkspaceRootInput);

  const [draft, setDraft] = useState(workspaceRootInput);

  useEffect(() => {
    setDraft(workspaceRootInput);
  }, [workspaceRootInput]);

  return (
    <SettingsSection title="通用" description="管理桌面端的基础配置。">
      <SettingsCard divided={false} className="p-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <SettingsRow label="Workspace 默认路径" description="用于快速加载工作区根目录。" />
            <Input
              placeholder="/Users/han/Project/OpenHorn"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setDraft(workspaceRootInput)}
              disabled={draft === workspaceRootInput}
            >
              取消
            </Button>
            <Button
              onClick={() => {
                const next = draft.trim();
                setWorkspaceRootInput(next);
                saveWorkspaceRoot(next);
              }}
            >
              保存
            </Button>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
