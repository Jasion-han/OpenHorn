import { FolderOpen } from "lucide-react";
import { cn } from "ui";
import { useSidecarStore } from "../../stores/sidecarStore";

/**
 * Short helper to show a path truncated from the left ("…/foo/bar")
 * so the trailing directory name (the part the user actually
 * recognizes) is always visible.
 *
 * Exported for unit tests.
 */
export function formatWorkspacePath(full: string, max = 32): string {
  if (full.length <= max) return full;
  return `…${full.slice(-(max - 1))}`;
}

/**
 * Chat-header badge that shows the currently-selected sidecar workspace
 * root and, when clicked, opens the native folder picker to switch it.
 *
 * Visibility rules:
 *   - Hidden entirely when the sidecar runtime is "unsupported" (e.g.
 *     running under vite dev without a Tauri shell). The browser-only
 *     environment has nothing to show for this badge.
 *   - In every other status we still render the badge; clicks are
 *     disabled until the sidecar is "ready" so users can see that the
 *     feature exists but is booting.
 */
export function DesktopSidecarWorkspaceBadge() {
  const status = useSidecarStore((state) => state.status);
  const workspaceRoot = useSidecarStore((state) => state.workspaceRoot);
  const lastError = useSidecarStore((state) => state.lastError);
  const pickAndSetWorkspace = useSidecarStore((state) => state.pickAndSetWorkspace);

  if (status === "unsupported") {
    return null;
  }

  const isReady = status === "ready";
  const disabled = !isReady;
  const label = workspaceRoot
    ? formatWorkspacePath(workspaceRoot)
    : isReady
      ? "选择工作目录"
      : statusLabel(status);

  const title = workspaceRoot
    ? workspaceRoot
    : isReady
      ? "点击选择本地 Agent 运行的工作目录"
      : sidecarTitle(status, lastError);

  return (
    <button
      type="button"
      data-testid="sidecar-workspace-badge"
      onClick={() => {
        if (!disabled) void pickAndSetWorkspace();
      }}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-background/60 px-2 py-1 text-xs",
        "text-foreground/70 transition-colors titlebar-no-drag",
        isReady
          ? "hover:border-foreground/25 hover:bg-background/90 hover:text-foreground"
          : "cursor-not-allowed opacity-60",
      )}
    >
      <FolderOpen size={14} className="shrink-0" />
      <span className="max-w-[220px] truncate">{label}</span>
    </button>
  );
}

function statusLabel(status: ReturnType<typeof useSidecarStore.getState>["status"]): string {
  switch (status) {
    case "idle":
      return "本地运行未启动";
    case "starting":
      return "正在启动本地运行";
    case "connecting":
      return "正在连接本地运行";
    case "ready":
      return "本地运行就绪";
    case "error":
      return "本地运行异常";
    default:
      return "本地运行";
  }
}

function sidecarTitle(
  status: ReturnType<typeof useSidecarStore.getState>["status"],
  lastError: string | null,
): string {
  if (status === "error" && lastError) {
    return `本地 Agent 运行启动失败：${lastError}`;
  }
  if (status === "idle") {
    return "本地 Agent 运行尚未启动";
  }
  if (status === "starting" || status === "connecting") {
    return "本地 Agent 运行正在就绪...";
  }
  return "本地 Agent 运行";
}
