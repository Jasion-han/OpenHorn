import { cn } from "ui";
import { agentPanelLabels, getAgentActionLabel } from "../../lib/i18n/agent";
import type { SidecarApprovalRequest } from "../../lib/sidecarClient";

/**
 * Inline banner shown just above the composer whenever the sidecar
 * runtime has something the user must see — a pending tool approval,
 * a recent sidecar-level error, or a sidecar run still in progress.
 *
 * We deliberately keep this component separate from the main message
 * list: sidecar runs stream into the existing assistant message
 * through chatStore, so the bubble-side rendering is already
 * correct. This panel handles the out-of-band bits (approvals +
 * errors) that don't fit cleanly inside a single message bubble.
 */
export function DesktopSidecarRuntimePanel({
  pendingApproval,
  lastError,
  isBusy,
  onApprove,
  onReject,
  onCancel,
}: {
  pendingApproval: SidecarApprovalRequest | null;
  lastError: string | null;
  isBusy: boolean;
  onApprove: (toolUseId: string) => void;
  onReject: (toolUseId: string) => void;
  onCancel: () => void;
}) {
  if (!pendingApproval && !lastError && !isBusy) return null;

  return (
    <div
      data-testid="sidecar-runtime-panel"
      className={cn(
        "mb-2 rounded-lg border bg-background/80 px-3 py-2 text-sm",
        pendingApproval
          ? "border-amber-300/60"
          : lastError
            ? "border-destructive/50"
            : "border-border/50",
      )}
    >
      {pendingApproval ? (
        <SidecarApprovalForm
          approval={pendingApproval}
          onApprove={onApprove}
          onReject={onReject}
        />
      ) : lastError ? (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-destructive/80">本地运行出错：{lastError}</span>
        </div>
      ) : isBusy ? (
        <div className="flex items-center justify-between gap-3 text-xs text-foreground/70">
          <span>本地 Agent 正在执行...</span>
          <button
            type="button"
            data-testid="sidecar-runtime-cancel"
            onClick={onCancel}
            className={cn(
              "rounded-md border px-2 py-0.5 text-xs font-medium",
              "border-destructive/40 text-destructive/85 hover:bg-destructive/5",
            )}
          >
            {getAgentActionLabel("stop")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SidecarApprovalForm({
  approval,
  onApprove,
  onReject,
}: {
  approval: SidecarApprovalRequest;
  onApprove: (toolUseId: string) => void;
  onReject: (toolUseId: string) => void;
}) {
  const inputSummary = summarizeToolInput(approval.toolInput);

  return (
    <div>
      <header className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-foreground/55">
          {agentPanelLabels.toolApprovalHeading}
        </span>
        <code className="rounded bg-foreground/8 px-1.5 py-0.5 text-[10px] text-foreground/65">
          {approval.toolName || "tool"}
        </code>
      </header>

      {inputSummary ? (
        <div className="mb-2 rounded bg-foreground/5 px-2 py-1.5 font-mono text-xs leading-5 text-foreground/80 break-all">
          {inputSummary}
        </div>
      ) : null}

      {approval.decisionReason ? (
        <p className="mb-1 text-xs text-foreground/60">{approval.decisionReason}</p>
      ) : null}

      {approval.blockedPath ? (
        <p className="mb-2 text-xs text-foreground/55">
          path: <code className="text-foreground/70">{approval.blockedPath}</code>
        </p>
      ) : null}

      <p className="mb-2 text-xs text-foreground/60">{agentPanelLabels.toolApprovalHint}</p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="sidecar-approval-allow"
          onClick={() => onApprove(approval.toolUseId)}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium transition-colors",
            "bg-emerald-600 text-white hover:bg-emerald-700",
          )}
        >
          {getAgentActionLabel("allow")}
        </button>
        <button
          type="button"
          data-testid="sidecar-approval-deny"
          onClick={() => onReject(approval.toolUseId)}
          className={cn(
            "rounded-md border px-3 py-1 text-xs font-medium transition-colors",
            "border-border/60 text-foreground/70 hover:bg-foreground/5",
          )}
        >
          {getAgentActionLabel("deny")}
        </button>
      </div>
    </div>
  );
}

function summarizeToolInput(input: Record<string, unknown>): string | null {
  if (typeof input.command === "string" && input.command.trim()) return input.command.trim();
  if (typeof input.cmd === "string" && input.cmd.trim()) return input.cmd.trim();
  if (typeof input.file_path === "string" && input.file_path.trim()) return input.file_path.trim();
  if (typeof input.path === "string" && input.path.trim()) return input.path.trim();
  if (typeof input.url === "string" && input.url.trim()) return input.url.trim();
  if (typeof input.query === "string" && input.query.trim()) return input.query.trim();
  return null;
}
