import { cn } from "ui";
import { agentPanelLabels, getAgentActionLabel } from "../../lib/i18n/agent";
import type { ApiAgentApproval } from "../../types/chat";

/**
 * Renders a pending tool_approval inline. The agent has paused execution
 * because it wants to run a sensitive tool (typically a Bash command),
 * and the user must explicitly allow or reject it.
 *
 * Real fields surfaced (all coming from the server):
 *   - approval.title          : English short heading from server
 *   - approval.description    : English risk reason from server
 *   - payload.toolName        : exact tool identifier
 *   - payload.toolInput       : raw tool input record
 *   - payload.blockedPath     : optional path that triggered the block
 *   - payload.decisionReason  : optional secondary risk note
 *
 * Tool input is shown via summarizeToolInput so commands and paths show
 * inline; full payload is rendered as JSON in a collapsible <details>
 * for transparency.
 */
export function DesktopAgentToolApprovalPanel({
  approval,
  submitting,
  submitError,
  onApprove,
  onReject,
}: {
  approval: ApiAgentApproval;
  submitting: boolean;
  submitError: string | null;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
}) {
  if (approval.type !== "tool_approval" || approval.status !== "pending") return null;

  const payload = isRecord(approval.payload) ? approval.payload : null;
  const toolName = typeof payload?.toolName === "string" ? payload.toolName : null;
  const toolInput = isRecord(payload?.toolInput) ? (payload.toolInput as Record<string, unknown>) : null;
  const blockedPath =
    typeof payload?.blockedPath === "string" && payload.blockedPath.trim()
      ? payload.blockedPath
      : null;
  const decisionReason =
    typeof payload?.decisionReason === "string" && payload.decisionReason.trim()
      ? payload.decisionReason
      : null;
  const inputSummary = toolInput ? summarizeToolInput(toolInput) : null;

  return (
    <section
      data-testid="agent-tool-approval-panel"
      className="mt-1 rounded-lg border border-amber-300/60 bg-amber-50/30 px-3 py-2.5"
    >
      <header className="flex items-center justify-between gap-2 pb-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-foreground/55">
          {agentPanelLabels.toolApprovalHeading}
        </span>
        {toolName ? (
          <code className="rounded bg-foreground/8 px-1.5 py-0.5 text-[10px] text-foreground/65">
            {toolName}
          </code>
        ) : null}
      </header>

      {inputSummary ? (
        <div className="mb-2 rounded bg-background/60 px-2 py-1.5 font-mono text-xs leading-5 text-foreground/80 break-all">
          {inputSummary}
        </div>
      ) : null}

      {decisionReason ? (
        <p className="mb-1 text-xs text-foreground/60">{decisionReason}</p>
      ) : approval.description ? (
        <p className="mb-1 text-xs text-foreground/60">{approval.description}</p>
      ) : null}

      {blockedPath ? (
        <p className="mb-2 text-xs text-foreground/55">
          path: <code className="text-foreground/70">{blockedPath}</code>
        </p>
      ) : null}

      {toolInput ? (
        <details className="mb-2">
          <summary className="cursor-pointer text-xs text-foreground/50 hover:text-foreground/70">
            {getAgentActionLabel("viewDetails")}
          </summary>
          <pre className="mt-1 overflow-x-auto rounded bg-foreground/5 px-2 py-1.5 text-[11px] leading-5 text-foreground/75">
            {safeStringify(toolInput)}
          </pre>
        </details>
      ) : null}

      <p className="mb-2 text-xs text-foreground/60">{agentPanelLabels.toolApprovalHint}</p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="agent-tool-allow"
          onClick={() => onApprove(approval.id)}
          disabled={submitting}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium transition-colors",
            "bg-emerald-600 text-white hover:bg-emerald-700",
            "disabled:opacity-60 disabled:cursor-not-allowed",
          )}
        >
          {submitting ? agentPanelLabels.approvalSubmitting : getAgentActionLabel("allow")}
        </button>
        <button
          type="button"
          data-testid="agent-tool-deny"
          onClick={() => onReject(approval.id)}
          disabled={submitting}
          className={cn(
            "rounded-md border px-3 py-1 text-xs font-medium transition-colors",
            "border-border/60 text-foreground/70 hover:bg-foreground/5",
            "disabled:opacity-60 disabled:cursor-not-allowed",
          )}
        >
          {getAgentActionLabel("deny")}
        </button>
        {submitError ? (
          <span className="text-xs text-destructive/80">
            {agentPanelLabels.approvalSubmitFailed}: {submitError}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
