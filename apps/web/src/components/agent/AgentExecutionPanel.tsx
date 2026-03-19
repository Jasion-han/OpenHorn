"use client";

import { Bot, Wrench, AlertCircle } from "lucide-react";
import type { ApiAgentTaskEvent } from "@/lib/api";

function eventLabel(event: ApiAgentTaskEvent) {
  if (event.type === "error") return "错误";
  const eventType =
    typeof event.metadata === "object" && event.metadata
      ? (event.metadata as Record<string, unknown>).eventType
      : null;
  if (eventType === "tool_start") return "工具启动";
  if (eventType === "tool_result") return "工具结果";
  return "执行更新";
}

export function AgentExecutionPanel({
  events,
  streamError,
  runLabel,
}: {
  events: ApiAgentTaskEvent[];
  streamError: string | null;
  runLabel?: string | null;
}) {
  const visibleEvents = events.filter((event) => event.type === "execution_event" || event.type === "error");

  return (
    <section className="rounded-3xl border border-border/70 bg-background/80 p-5">
      <div className="mb-4">
        <div className="text-sm font-medium">执行过程</div>
        <p className="mt-1 text-xs text-muted-foreground">
          {runLabel ? `${runLabel} 的工具调用与流式输出会显示在这里。` : "工具调用与流式输出会在这里持续累积。"}
        </p>
      </div>

      {streamError ? (
        <div className="mb-4 rounded-2xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
          {streamError}
        </div>
      ) : null}

      {visibleEvents.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
          当前运行还没有执行日志。
        </div>
      ) : (
        <div className="space-y-3">
          {visibleEvents.map((event) => {
            const isToolEvent =
              typeof event.metadata === "object" &&
              event.metadata &&
              ((event.metadata as Record<string, unknown>).eventType === "tool_start" ||
                (event.metadata as Record<string, unknown>).eventType === "tool_result");

            return (
              <div key={event.id} className="rounded-2xl border border-border/60 bg-muted/15 p-4">
                <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  {event.type === "error" ? (
                    <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                  ) : isToolEvent ? (
                    <Wrench className="h-3.5 w-3.5" />
                  ) : (
                    <Bot className="h-3.5 w-3.5" />
                  )}
                  <span>{eventLabel(event)}</span>
                  <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
                </div>
                {event.toolName ? <div className="mb-1 text-sm font-medium">{event.toolName}</div> : null}
                {event.content ? (
                  <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">{event.content}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
