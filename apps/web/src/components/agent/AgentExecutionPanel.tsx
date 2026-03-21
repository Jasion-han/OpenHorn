"use client";

import { Bot, Wrench, AlertCircle } from "lucide-react";
import type { ApiAgentTaskEvent } from "@/lib/api";

function getEventType(event: ApiAgentTaskEvent) {
  return typeof event.metadata === "object" && event.metadata
    ? (event.metadata as Record<string, unknown>).eventType
    : null;
}

function humanizeToolName(toolName: string | null | undefined) {
  const normalized = (toolName ?? "").trim().toLowerCase();
  if (!normalized) return "工具";
  if (normalized === "bash") return "命令执行";
  if (normalized.includes("browser")) return "网页操作";
  if (normalized.includes("search")) return "网络搜索";
  if (normalized.includes("fetch")) return "网页抓取";
  if (normalized.includes("read")) return "读取内容";
  if (normalized.includes("write") || normalized.includes("edit")) return "修改内容";
  return toolName ?? "工具";
}

function summarizeToolInput(toolInput: ApiAgentTaskEvent["toolInput"]) {
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
  if (query) {
    return `“${query.slice(0, 48)}${query.length > 48 ? "..." : ""}”`;
  }

  const url = typeof input.url === "string" ? input.url : null;
  if (url) {
    return url.length > 72 ? `${url.slice(0, 69)}...` : url;
  }

  const path =
    typeof input.path === "string"
      ? input.path
      : typeof input.file_path === "string"
        ? input.file_path
        : null;
  if (path) {
    return path;
  }

  const command =
    typeof input.command === "string"
      ? input.command
      : typeof input.cmd === "string"
        ? input.cmd
        : null;
  if (command) {
    return command.length > 72 ? `${command.slice(0, 69)}...` : command;
  }

  return null;
}

function summarizeEventContent(content: string | null | undefined) {
  const normalized = (content ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function eventLabel(event: ApiAgentTaskEvent) {
  if (event.type === "error") return "错误";
  const eventType = getEventType(event);
  if (eventType === "tool_start") return "工具启动";
  if (eventType === "tool_result") return "工具结果";
  return "执行更新";
}

export function AgentExecutionPanel({
  events,
  streamError,
  runLabel,
  embedded = false,
}: {
  events: ApiAgentTaskEvent[];
  streamError: string | null;
  runLabel?: string | null;
  embedded?: boolean;
}) {
  const visibleEvents = events.filter((event) => event.type === "execution_event" || event.type === "error");

  return (
    <section
      id="agent-execution-panel"
      className={embedded ? "space-y-4" : "rounded-3xl border border-border/70 bg-background/80 p-5"}
    >
      {!embedded ? (
        <div className="mb-4">
          <div className="text-sm font-medium">执行过程</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {runLabel ? `${runLabel} 的工具调用与流式输出会显示在这里。` : "工具调用与流式输出会在这里持续累积。"}
          </p>
        </div>
      ) : null}

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
            const eventType = getEventType(event);
            const isToolEvent = eventType === "tool_start" || eventType === "tool_result";
            const toolTitle = isToolEvent ? humanizeToolName(event.toolName) : null;
            const inputSummary = isToolEvent ? summarizeToolInput(event.toolInput) : null;
            const contentSummary = summarizeEventContent(event.content);
            const semanticSummary =
              event.type === "error"
                ? contentSummary
                : eventType === "tool_start"
                  ? inputSummary
                    ? `正在处理 ${inputSummary}`
                    : "已开始执行。"
                  : eventType === "tool_result"
                    ? contentSummary || "已返回结果。"
                    : contentSummary;

            return (
              <div
                key={event.id}
                className={embedded ? "rounded-2xl border border-border/60 bg-muted/10 p-4" : "rounded-2xl border border-border/60 bg-muted/15 p-4"}
              >
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
                {toolTitle ? <div className="mb-1 text-sm font-medium">{toolTitle}</div> : null}
                {semanticSummary ? (
                  <p className="text-sm leading-6 text-foreground/90">{semanticSummary}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
