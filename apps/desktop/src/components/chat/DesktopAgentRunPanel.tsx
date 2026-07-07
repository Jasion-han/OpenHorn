import { cn } from "ui";
import type { ApiAgentRun } from "../../types/chat";
import { DesktopAgentTaskMetaLine } from "./DesktopAgentTaskMetaLine";
import { InlineClampStep } from "./DesktopInlineClampStep";

export function AgentRunPanel({ run }: { run?: ApiAgentRun }) {
  if (!run) return null;
  const toolCount = run.steps.filter((step) => step.type === "tool_start").length;
  const hasThinking = run.steps.some((step) => step.type === "text");
  const isInProgress = run.status === "partial" || run.status === "running";
  const shouldRender = Boolean(run.error) || toolCount > 0 || hasThinking || isInProgress;
  if (!shouldRender) return null;

  // An in-progress run that has not yet produced any steps, text, or error would
  // otherwise render nothing — causing a brief blank when switching back to an
  // active conversation. Show a minimal working indicator instead.
  if (!run.error && toolCount === 0 && !hasThinking && isInProgress) {
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
    if (normalized.includes("search")) return "Search";
    if (normalized.includes("fetch")) return "Fetch";
    if (normalized.includes("read")) return "Read";
    if (normalized.includes("write")) return "Write";
    if (normalized.includes("browser")) return "Browser";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  };

  const summarizeToolInput = (toolInput: unknown) => {
    if (!toolInput || typeof toolInput !== "object") return null;
    const input = toolInput as Record<string, unknown>;
    const query =
      typeof input.query === "string"
        ? input.query
        : typeof input.q === "string"
          ? input.q
          : typeof input.search_query === "string"
            ? input.search_query
            : null;
    if (query?.trim()) return query.trim();

    const command =
      typeof input.command === "string"
        ? input.command
        : typeof input.cmd === "string"
          ? input.cmd
          : null;
    if (command?.trim()) return command.trim();

    const path =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : null;
    if (path?.trim()) return path.trim();

    const url = typeof input.url === "string" ? input.url : null;
    if (url?.trim()) return url.trim();

    try {
      return JSON.stringify(toolInput);
    } catch {
      return null;
    }
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
  const activeStartKey = (() => {
    if (run.status !== "running" && run.status !== "partial") return null;
    for (let index = run.steps.length - 1; index >= 0; index -= 1) {
      const step = run.steps[index];
      if (!step) continue;
      if (step.type === "tool_result" || step.type === "error") return null;
      if (step.type === "tool_start") {
        return `${step.type}-${step.toolName || ""}-${step.content || ""}-${JSON.stringify(step.toolInput ?? null)}`;
      }
    }
    return null;
  })();

  return (
    <details
      className="mt-2 text-sm"
      open={run.status === "running" || run.status === "partial" || undefined}
    >
      <style>{`
        @keyframes agentMetaTextFlow {
          0% { background-position: 130% 50%; text-shadow: 0 0 0 rgba(15,23,42,0); }
          50% { text-shadow: 0 0 8px rgba(15,23,42,0.08); }
          100% { background-position: -30% 50%; text-shadow: 0 0 0 rgba(15,23,42,0); }
        }
      `}</style>
      <summary className="list-none cursor-pointer">
        <div className="flex items-center justify-between gap-3 border-b border-border/35 pb-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm leading-6 text-muted-foreground">
              {displayTitle}{" "}
              <span className={cn("text-muted-foreground/70", statusClassName)}>
                &middot; {statusLabel}
              </span>
            </span>
          </div>
        </div>
      </summary>

      <div className="mt-2 flex flex-col gap-2.5">
        {run.error && <DesktopAgentTaskMetaLine text={run.error} tone="danger" />}
        {run.steps.map((step, stepIndex) => {
          if (step.type === "text") {
            const isLastText = !run.steps.slice(stepIndex + 1).some((s) => s.type === "tool_start");
            if (isLastText && run.status === "completed") return null;
            const raw = (step.content ?? "").trim();
            if (!raw) return null;
            return (
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
  );
}
