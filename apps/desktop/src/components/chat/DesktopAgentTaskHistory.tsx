import { ListTodo, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "ui";
import { getAgentStatusLabel } from "../../lib/i18n/agent";
import { createServerApi } from "../../lib/serverApi";
import type { ApiAgentTask } from "../../types/chat";

const api = createServerApi();

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

function truncateGoal(goal: string, max = 60): string {
  if (goal.length <= max) return goal;
  return `${goal.slice(0, max - 3)}...`;
}

function statusTone(status: ApiAgentTask["status"]): string {
  switch (status) {
    case "completed":
      return "bg-emerald-500/12 text-emerald-700";
    case "failed":
      return "bg-destructive/12 text-destructive/80";
    case "cancelled":
      return "bg-foreground/8 text-foreground/55";
    case "running":
      return "bg-blue-500/12 text-blue-700";
    case "awaiting_approval":
      return "bg-amber-500/12 text-amber-700";
    default:
      return "bg-foreground/8 text-foreground/55";
  }
}

export function DesktopAgentTaskHistoryButton({
  conversationId,
}: {
  conversationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<ApiAgentTask[]>([]);
  const [loading, setLoading] = useState(false);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.agentTasks.list({ conversationId });
      setTasks(result.tasks);
    } catch {
      // ignore — user can retry by reopening
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (open) void loadTasks();
  }, [open, loadTasks]);

  return (
    <>
      <button
        type="button"
        data-testid="agent-task-history-button"
        onClick={() => setOpen((v) => !v)}
        title="Agent 任务历史"
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/60 px-2 py-1 text-xs",
          "text-foreground/70 transition-colors titlebar-no-drag",
          "hover:border-foreground/25 hover:bg-background/90 hover:text-foreground",
        )}
      >
        <ListTodo size={14} />
        <span>任务</span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-20"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            className={cn(
              "w-full max-w-lg rounded-xl border border-border/70 bg-background shadow-2xl",
              "max-h-[60vh] flex flex-col",
            )}
          >
            <header className="flex items-center justify-between border-b border-border/40 px-4 py-3">
              <span className="text-sm font-medium">Agent 任务历史</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X size={16} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-2">
              {loading ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  加载中...
                </p>
              ) : tasks.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  当前会话暂无 Agent 任务。
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {tasks.map((task) => {
                    const statusLabel = getAgentStatusLabel(task.status);
                    return (
                      <li
                        key={task.id}
                        className="flex items-start justify-between gap-3 rounded-md border border-border/30 bg-foreground/[0.02] px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm leading-6 text-foreground/85">
                            {truncateGoal(task.goal)}
                          </p>
                          <p className="text-[11px] text-foreground/50">
                            {formatTime(task.createdAt)}
                            {task.complexity !== "standard" ? ` · ${task.complexity}` : ""}
                          </p>
                        </div>
                        {statusLabel ? (
                          <span
                            className={cn(
                              "mt-0.5 shrink-0 rounded px-1.5 py-px text-[10px] font-medium",
                              statusTone(task.status),
                            )}
                          >
                            {statusLabel}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
