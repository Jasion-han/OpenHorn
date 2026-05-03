import type { CSSProperties } from "react";
import type { ApiAgentTaskEvent, ApiAgentTaskDetail } from "../types/chat";
import type { StreamTone, AgentEventMetadata } from "./agentTaskStreamBuilder";
import {
  normalizeAgentDisplayText,
} from "./agentErrorDisplay";

export type ToolApprovalPayload = {
  toolUseId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  blockedPath?: string | null;
  decisionReason?: string | null;
};

export function normalizeToolName(toolName: string | null | undefined) {
  return (toolName ?? "").trim().toLowerCase();
}

export function simplifyToolName(toolName: string | null | undefined) {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return "tool";
  if (normalized.startsWith("mcp__")) {
    const parts = normalized.split("__").filter(Boolean);
    return parts.slice(1).join(".") || "mcp";
  }
  if (normalized.startsWith("skill__")) {
    const parts = normalized.split("__").filter(Boolean);
    return parts.slice(1).join(".") || "skill";
  }
  return normalized.replace(/\s+/g, "_");
}

export function actionLabel(toolName: string | null | undefined) {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return "tool";
  if (normalized.includes("bash") || normalized.includes("terminal") || normalized === "shell") {
    return "bash";
  }
  if (normalized.startsWith("mcp__")) return "mcp";
  if (normalized.startsWith("skill__")) return "skill";
  if (normalized.includes("fetch")) return "fetch";
  if (normalized.includes("search")) return "search";
  if (normalized.includes("browser")) return "browser";
  if (normalized.includes("read")) return "read";
  if (normalized.includes("write")) return "write";
  return simplifyToolName(toolName);
}

export function presentActionLabel(label: string) {
  switch (label) {
    case "bash":
      return "Bash";
    case "search":
      return "Search";
    case "fetch":
      return "Fetch";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "browser":
      return "Browser";
    case "mcp":
      return "MCP";
    case "skill":
      return "Skill";
    default:
      return label ? label.charAt(0).toUpperCase() + label.slice(1) : "Tool";
  }
}

export function prettifyToolName(toolName: string | null | undefined) {
  const simplified = simplifyToolName(toolName);
  return simplified.replace(/[._-]+/g, " ").trim() || "tool";
}

export function describeToolStart(toolName: string | null | undefined, toolInput: ApiAgentTaskEvent["toolInput"]) {
  const label = actionLabel(toolName);
  const detail = summarizeToolInput(toolInput);
  return {
    text: presentActionLabel(label),
    subtext: detail,
  };
}

export function describeToolResult(toolName: string | null | undefined, content: string | null | undefined) {
  const label = actionLabel(toolName);
  const subtext = summarizeProcessDetail(content, 84);
  return {
    text: presentActionLabel(label),
    subtext: subtext === "ok" ? null : subtext,
  };
}

export function describeTaskStatus(status: ApiAgentTaskDetail["task"]["status"]) {
  switch (status) {
    case "draft":
      return { text: "Thinking", tone: "default" as const };
    case "planning":
      return { text: "Thinking", tone: "default" as const };
    case "awaiting_approval":
      return { text: "Awaiting confirmation", tone: "warning" as const };
    case "running":
      return { text: "Working", tone: "default" as const };
    case "completed":
      return { text: "Done", tone: "success" as const };
    case "failed":
      return { text: "Error", tone: "danger" as const };
    case "cancelled":
      return { text: "Stopped", tone: "danger" as const };
    default:
      return { text: "Ready", tone: "default" as const };
  }
}

export function summarizeToolInput(toolInput: ApiAgentTaskEvent["toolInput"]) {
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
    return query.length > 72 ? `${query.slice(0, 69)}...` : query;
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
  if (path) return path;

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

export function summarizeProcessDetail(content: string | null | undefined, limit = 96) {
  const normalized = normalizeAgentDisplayText(content);
  if (!normalized) return null;
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

export function normalizeProcessText(content: string | null | undefined, metadata?: AgentEventMetadata) {
  const normalized = normalizeAgentDisplayText(content, metadata);
  return normalized || null;
}

export function summarizeApprovalToolInput(toolInput: Record<string, unknown> | undefined) {
  if (!toolInput) return null;

  if (typeof toolInput.command === "string" && toolInput.command.trim()) {
    return toolInput.command.trim();
  }

  const preferredKeys = ["file_path", "path", "pattern", "query", "url"];
  const lines = preferredKeys
    .map((key) => {
      const value = toolInput[key];
      if (typeof value !== "string" || !value.trim()) return null;
      return value.trim();
    })
    .filter((value): value is string => Boolean(value));

  if (lines.length > 0) return lines.join(" · ");

  try {
    return JSON.stringify(toolInput);
  } catch {
    return null;
  }
}

export function getToolApprovalPayload(payload: unknown): ToolApprovalPayload | null {
  if (!isRecord(payload)) return null;
  return {
    toolUseId: typeof payload.toolUseId === "string" ? payload.toolUseId : undefined,
    toolName: typeof payload.toolName === "string" ? payload.toolName : undefined,
    toolInput: isRecord(payload.toolInput) ? payload.toolInput : undefined,
    blockedPath: typeof payload.blockedPath === "string" ? payload.blockedPath : null,
    decisionReason: typeof payload.decisionReason === "string" ? payload.decisionReason : null,
  };
}

export function toneClassName(tone: StreamTone = "default") {
  switch (tone) {
    case "success":
      return "text-foreground/60";
    case "warning":
      return "text-foreground/50";
    case "danger":
      return "text-destructive/70";
    default:
      return "text-foreground/42";
  }
}

export function getActiveMetaTextStyle(): CSSProperties {
  // Shimmer effect using the theme's foreground HSL variable so it works
  // in both light and dark modes.
  const fg = "hsl(var(--foreground))";
  const fgDim = "hsl(var(--foreground) / 0.3)";
  return {
    backgroundImage:
      `linear-gradient(90deg, ${fgDim} 0%, ${fg} 45%, ${fg} 55%, ${fgDim} 100%)`,
    backgroundSize: "250% 100%",
    backgroundClip: "text",
    WebkitBackgroundClip: "text",
    color: "transparent",
    WebkitTextFillColor: "transparent",
    animation: "agentMetaTextShimmer 2.2s linear infinite",
  };
}

export function extractErrorMessage(error: unknown, fallback = "task failed") {
  if (typeof error === "string") return error.trim() || fallback;
  if (error instanceof Error) return error.message.trim() || fallback;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
