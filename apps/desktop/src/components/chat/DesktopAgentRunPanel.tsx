import { CornerDownRight } from "lucide-react";
import { useState } from "react";
import { cn } from "ui";
import { extractToolUrls, summarizeToolInput } from "../../lib/agentToolSummary";
import { formatChatLabel, getChatLabel } from "../../lib/i18n/agent";
import type { ApiAgentRun, ApiAgentRunStep } from "../../types/chat";
import { DesktopAgentTaskMetaLine } from "./DesktopAgentTaskMetaLine";
import { InlineClampStep } from "./DesktopInlineClampStep";

// --- ACP kind label ---
function kindLabel(kind: string | undefined): string {
  switch (kind) {
    case "read":
      return getChatLabel("chat.agent.kind.read");
    case "edit":
      return getChatLabel("chat.agent.kind.edit");
    case "execute":
      return getChatLabel("chat.agent.kind.execute");
    case "search":
      return getChatLabel("chat.agent.kind.search");
    case "think":
      return getChatLabel("chat.agent.kind.think");
    case "fetch":
      return getChatLabel("chat.agent.kind.fetch");
    case "delete":
      return getChatLabel("chat.agent.kind.delete");
    case "move":
      return getChatLabel("chat.agent.kind.move");
    default:
      return getChatLabel("chat.agent.kind.other");
  }
}

// --- ACP status badge ---
function statusBadge(status: string | undefined): {
  label: string;
  className: string;
} {
  switch (status) {
    case "pending":
      return {
        label: getChatLabel("chat.agent.status.pending"),
        className: "text-muted-foreground/50",
      };
    case "in_progress":
      return {
        label: getChatLabel("chat.agent.status.in_progress"),
        className: "text-blue-600",
      };
    case "completed":
      return {
        label: getChatLabel("chat.agent.status.completed"),
        className: "text-emerald-600",
      };
    case "failed":
      return {
        label: getChatLabel("chat.agent.status.failed"),
        className: "text-red-600",
      };
    default:
      return {
        label: status ?? "",
        className: "text-muted-foreground/50",
      };
  }
}

// --- Simple diff preview (red/green text, no Shiki/CodeMirror) ---
function DiffPreview({
  diff,
}: {
  diff: { path: string; oldText: string | null; newText: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const isNewFile = diff.oldText === null || diff.oldText === "";
  const fileName = diff.path.split("/").pop() ?? diff.path;

  // Build a simple line-level diff for display.
  const oldLines = isNewFile ? [] : (diff.oldText ?? "").split("\n");
  const newLines = diff.newText.split("\n");
  // Only show first 20 lines by default; expand to show all.
  const maxPreview = 20;
  const totalLines = oldLines.length + newLines.length;
  const needsTruncation = totalLines > maxPreview && !expanded;

  return (
    <div className="mt-1 ml-3.5 overflow-hidden rounded border border-border/30 text-xs">
      <div className="flex items-center justify-between bg-muted/30 px-2 py-0.5">
        <span className="truncate font-mono text-muted-foreground/70">{fileName}</span>
        {isNewFile && (
          <span className="ml-2 shrink-0 text-emerald-600/70">
            {getChatLabel("chat.agent.diff.newFile")}
          </span>
        )}
      </div>
      <pre className="overflow-x-auto p-1.5 font-mono leading-5">
        {!isNewFile &&
          (needsTruncation ? oldLines.slice(0, Math.floor(maxPreview / 2)) : oldLines).map(
            (line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
              <div key={`old-${i}`} className="text-red-600/60">
                <span className="mr-1 select-none">-</span>
                {line}
              </div>
            ),
          )}
        {(needsTruncation ? newLines.slice(0, Math.floor(maxPreview / 2)) : newLines).map(
          (line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
            <div key={`new-${i}`} className="text-emerald-600/60">
              <span className="mr-1 select-none">+</span>
              {line}
            </div>
          ),
        )}
      </pre>
      {totalLines > maxPreview && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full border-t border-border/20 bg-muted/20 px-2 py-0.5 text-center text-xs text-foreground/50 transition-colors hover:text-foreground/70"
        >
          {expanded ? "Less" : `+${totalLines - maxPreview} lines`}
        </button>
      )}
    </div>
  );
}

// --- ACP plan step rendering ---
function PlanStep({
  entries,
}: {
  entries: Array<{ content: string; priority: string; status: string }>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 0) return null;

  const previewCount = 3;
  const visible = expanded ? entries : entries.slice(0, previewCount);

  const priorityClass = (p: string) => {
    switch (p) {
      case "high":
        return "text-red-600/70";
      case "medium":
        return "text-amber-600/70";
      case "low":
        return "text-muted-foreground/50";
      default:
        return "text-muted-foreground/50";
    }
  };

  const statusIcon = (s: string) => {
    switch (s) {
      case "completed":
        return "done";
      case "in_progress":
        return "...";
      default:
        return "";
    }
  };

  return (
    <div className="py-0.5 text-sm leading-6 text-foreground/42">
      <span className="relative flex items-start gap-2">
        <span
          aria-hidden="true"
          className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-current"
          style={{ opacity: 0.2 }}
        />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{getChatLabel("chat.agent.plan.heading")}</span>
          <div className="mt-0.5 flex flex-col gap-0.5 pl-1">
            {visible.map((entry, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: plan entries are positional
              <div key={`plan-${i}`} className="flex items-start gap-1.5">
                <span className={cn("shrink-0 text-xs leading-6", priorityClass(entry.priority))}>
                  {entry.priority === "high"
                    ? getChatLabel("chat.agent.plan.high")
                    : entry.priority === "low"
                      ? getChatLabel("chat.agent.plan.low")
                      : ""}
                </span>
                <span className="min-w-0 text-foreground/50">{entry.content}</span>
                {statusIcon(entry.status) && (
                  <span className="shrink-0 text-xs text-emerald-600/60">
                    {statusIcon(entry.status)}
                  </span>
                )}
              </div>
            ))}
          </div>
          {entries.length > previewCount && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-0.5 pl-1 text-xs text-foreground/40 transition-colors hover:text-foreground/60"
            >
              {expanded ? "Less" : `+${entries.length - previewCount} more`}
            </button>
          )}
        </span>
      </span>
    </div>
  );
}

// --- ACP context usage bar ---
function ContextUsageBar({
  contextUsage,
}: {
  contextUsage: { used: number; size: number; cost?: { amount: number; currency: string } };
}) {
  if (contextUsage.size <= 0) return null;
  const percent = Math.min(100, Math.round((contextUsage.used / contextUsage.size) * 100));
  const usedK = Math.round(contextUsage.used / 1000);
  const sizeK = Math.round(contextUsage.size / 1000);

  return (
    <div className="flex items-center gap-2 px-1 py-0.5 text-xs text-muted-foreground/60">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted/40">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            percent > 80 ? "bg-amber-500/60" : "bg-blue-500/40",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span>
        {formatChatLabel("chat.agent.contextUsage", {
          used: `${usedK}k`,
          size: `${sizeK}k`,
          percent,
        })}
      </span>
      {contextUsage.cost && (
        <span className="text-muted-foreground/40">
          {formatChatLabel("chat.agent.contextCost", {
            amount: contextUsage.cost.amount.toFixed(3),
            currency: contextUsage.cost.currency,
          })}
        </span>
      )}
    </div>
  );
}

// --- Tool detail step (ACP-specific) ---
function ToolDetailStep({ step }: { step: ApiAgentRunStep }) {
  const title = step.toolName || kindLabel(step.kind);
  const badge = statusBadge(step.status);
  const detail = step.content || summarizeToolInput(step.toolInput);

  return (
    <div className="py-0.5 text-sm leading-6 text-foreground/42">
      <span className="relative flex items-start gap-2">
        <span
          aria-hidden="true"
          className="absolute left-0 top-[8px] h-1.5 w-1.5 rounded-full bg-current opacity-20"
        />
        <div className="min-w-0 flex-1 pl-3.5">
          <span>
            <span className="text-foreground/60">{kindLabel(step.kind)}</span>
            {title !== kindLabel(step.kind) && (
              <span className="text-foreground/42">{` ${title}`}</span>
            )}
            <span className={cn("ml-1.5 text-xs", badge.className)}>{badge.label}</span>
          </span>
          {detail && <span className="text-foreground opacity-32">{` · ${detail}`}</span>}
          {/* File path chips */}
          {step.locations && step.locations.length > 0 && (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {step.locations.map((loc) => (
                <span
                  key={`${loc.path}:${loc.line ?? ""}`}
                  className="inline-flex items-center rounded bg-muted/30 px-1.5 py-0 font-mono text-xs text-foreground/40"
                >
                  {loc.path.split("/").pop()}
                  {loc.line != null && `:${loc.line}`}
                </span>
              ))}
            </div>
          )}
          {/* Diff preview */}
          {step.diff && <DiffPreview diff={step.diff} />}
        </div>
      </span>
    </div>
  );
}

export function AgentRunPanel({
  run,
  hideIdleIndicator = false,
}: {
  run?: ApiAgentRun;
  /**
   * Suppress the "no steps yet" placeholder below. Set by the bubble when it is
   * already showing its own live indicator — two of them at once read as two
   * concurrent activities.
   */
  hideIdleIndicator?: boolean;
}) {
  if (!run) return null;
  const toolCount = run.steps.filter(
    (step) => step.type === "tool_start" || step.type === "tool_detail",
  ).length;
  const hasThinking = run.steps.some((step) => step.type === "text");
  const isInProgress = run.status === "partial" || run.status === "running";
  const shouldRender =
    Boolean(run.error) ||
    toolCount > 0 ||
    hasThinking ||
    isInProgress ||
    Boolean(run.agentInfo) ||
    Boolean(run.contextUsage);
  if (!shouldRender) return null;

  // An in-progress run that has not yet produced any steps, text, or error would
  // otherwise render nothing — causing a brief blank when switching back to an
  // active conversation. Show a minimal working indicator instead.
  if (!run.error && toolCount === 0 && !hasThinking && isInProgress && !run.agentInfo) {
    if (hideIdleIndicator) return null;
    return (
      <section className="mt-0.5 px-1 pt-0 pb-1">
        <DesktopAgentTaskMetaLine text={run.summary?.trim() || "Working"} active />
      </section>
    );
  }

  const presentToolLabel = (toolName: string | null | undefined) => {
    const raw = (toolName ?? "").trim();
    const normalized = raw.toLowerCase();
    if (!normalized) return "Tool";
    // MCP tools (`mcp__<server>__<tool>`) must resolve before the fuzzy includes
    // matches below, or names like `mcp__tavily__tavily_search` show as "Search".
    if (normalized.startsWith("mcp__")) {
      const [, server, ...toolParts] = raw.split("__");
      const tool = toolParts.join("__");
      return server && tool ? `${server} · ${tool}` : "MCP";
    }
    if (normalized.includes("bash") || normalized.includes("terminal") || normalized === "shell") {
      return "Bash";
    }
    // Claude Code's deferred-tool lookup, not a web search. Must beat the
    // fuzzy `includes("search")` below or it shows up as "Search".
    if (normalized === "toolsearch") return "Tool lookup";
    if (normalized.includes("search")) return "Search";
    if (normalized.includes("fetch")) return "Fetch";
    if (normalized.includes("read")) return "Read";
    if (normalized.includes("write")) return "Write";
    if (normalized.includes("browser")) return "Browser";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  };

  const summarizeToolResult = (content: string | null | undefined) => {
    const lines = (content ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^stdout:?$/i.test(line))
      .filter((line) => !/^stderr:?$/i.test(line))
      .filter((line) => !/^exit_?code\s*:/i.test(line));

    if (lines.length === 0) return null;
    const summary = lines.join(" · ").replace(/\s+/g, " ").trim();
    // No hard line/character truncation here: visual collapsing is handled by
    // InlineClampStep (3 lines collapsed, full content when expanded). Keep all
    // lines so the expanded view shows the complete tool result, and only apply
    // a loose safety ceiling to avoid pathologically long strings — never
    // insert an inline ellipsis.
    return summary.length > 8000 ? summary.slice(0, 8000) : summary;
  };

  const statusLabel = (() => {
    switch (run.status) {
      case "completed":
        return "Done";
      case "failed":
        return "Failed";
      case "cancelled":
        return "Cancelled";
      default:
        return "Running";
    }
  })();

  const statusClassName = (() => {
    switch (run.status) {
      case "completed":
        return "text-emerald-700";
      case "failed":
        return "text-orange-700";
      case "cancelled":
        return "text-slate-700";
      default:
        return "text-blue-700";
    }
  })();

  const displayTitle =
    toolCount > 0 ? `Execution · ${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : "Execution";

  // Agent info line for the header (ACP only).
  const agentLabel = run.agentInfo
    ? `${run.agentInfo.name}${run.agentInfo.version ? ` v${run.agentInfo.version}` : ""}`
    : null;

  return (
    <div className="mt-2 text-sm">
      <style>{`
        @keyframes agentMetaTextFlow {
          0% { background-position: 130% 50%; text-shadow: 0 0 0 rgba(15,23,42,0); }
          50% { text-shadow: 0 0 8px rgba(15,23,42,0.08); }
          100% { background-position: -30% 50%; text-shadow: 0 0 0 rgba(15,23,42,0); }
        }
      `}</style>
      <details open={run.status === "running" || run.status === "partial" || undefined}>
        <summary className="list-none cursor-pointer">
          <div className="flex items-center justify-between gap-3 border-b border-border/35 pb-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm leading-6 text-muted-foreground">
                {displayTitle}{" "}
                <span className={cn("text-muted-foreground/70", statusClassName)}>
                  &middot; {statusLabel}
                </span>
                {agentLabel && (
                  <span className="ml-1.5 text-xs text-muted-foreground/40">{agentLabel}</span>
                )}
              </span>
            </div>
          </div>
        </summary>

        <div className="mt-2 flex flex-col gap-2.5">
          {run.error && <DesktopAgentTaskMetaLine text={run.error} tone="danger" />}
          {run.steps.map((step, stepIndex) => {
            // --- ACP tool_detail step ---
            if (step.type === "tool_detail") {
              return <ToolDetailStep key={`detail-${step.toolCallId || stepIndex}`} step={step} />;
            }

            // --- ACP plan step ---
            if (step.type === "plan" && step.planEntries) {
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: run steps are append-only
                <PlanStep key={`plan-${stepIndex}`} entries={step.planEntries} />
              );
            }

            if (step.type === "text") {
              const isLastText = !run.steps
                .slice(stepIndex + 1)
                .some((s) => s.type === "tool_start" || s.type === "tool_detail");
              if (isLastText && run.status === "completed") return null;
              const raw = (step.content ?? "").trim();
              if (!raw) return null;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: run steps are append-only, so a step's index is its identity
                <div key={`text-${stepIndex}`}>
                  <span className="relative flex items-start gap-2 py-0.5 text-sm leading-6 text-muted-foreground/50">
                    <span
                      aria-hidden="true"
                      className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-current"
                      style={{ opacity: 0.2 }}
                    />
                    <span className="min-w-0 italic">{raw}</span>
                  </span>
                </div>
              );
            }

            const stepKey = `${step.type}-${step.toolName || ""}-${stepIndex}`;
            const isActive = false;
            const label = step.type === "error" ? "Error" : presentToolLabel(step.toolName);
            const detail =
              step.type === "tool_start"
                ? summarizeToolInput(step.toolInput)
                : step.type === "tool_result"
                  ? summarizeToolResult(step.content)
                  : step.content?.trim() || summarizeToolInput(step.toolInput);

            if (step.type === "tool_result" && !detail) return null;

            // A batched fetch (`urls: [...]`) is ONE call against several pages, so
            // it renders as one node with the pages nested under it. Listing the
            // URLs as sibling rows read as three separate calls; running them
            // together into one wrapped paragraph read as URL soup. The count goes
            // in the header because "did it open all of my links" is the question
            // this panel exists to answer.
            if (step.type === "tool_start") {
              const urls = extractToolUrls(step.toolInput);
              if (urls.length > 1) {
                return (
                  <div key={stepKey}>
                    <InlineClampStep
                      label={label || "Tool"}
                      detail={formatChatLabel("chat.agent.fetchTargets", { count: urls.length })}
                      isResult={false}
                      tone="default"
                      maxLines={3}
                    />
                    <div className="flex flex-col gap-0.5 pb-1 pl-4 text-sm leading-6">
                      {urls.map((url) => (
                        <div key={url} className="flex items-start gap-1.5">
                          {/* Corner glyph marking the row as belonging to the call
                            above. `mt-[7px]` sits it on the text's baseline row
                            rather than the line box's top. */}
                          <CornerDownRight
                            aria-hidden="true"
                            className="mt-[7px] size-3 shrink-0 text-foreground opacity-25"
                          />
                          {/* `break-all`: a long URL must stay readable in full
                            rather than be cut — it is what the reader verifies. */}
                          <span className="min-w-0 break-all text-foreground opacity-32">
                            {url}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }
            }

            if (step.type === "tool_start" || step.type === "tool_result") {
              return (
                <InlineClampStep
                  key={stepKey}
                  label={label || "Tool"}
                  detail={detail}
                  isResult={step.type === "tool_result"}
                  tone={step.type === "tool_result" ? "success" : "default"}
                  maxLines={3}
                />
              );
            }

            const text = step.type === "error" ? label : label || detail;

            if (!text && !detail) return null;

            return (
              <DesktopAgentTaskMetaLine
                key={stepKey}
                text={text ?? detail ?? "Tool"}
                subtext={detail}
                active={isActive}
                tone={step.type === "error" ? "danger" : "default"}
              />
            );
          })}
        </div>
      </details>
      {/* Context usage bar — always visible even when steps are collapsed (ACP only) */}
      {run.contextUsage && <ContextUsageBar contextUsage={run.contextUsage} />}
    </div>
  );
}
