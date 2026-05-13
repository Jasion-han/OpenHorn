import { Bot, Check, Copy, MessageSquare, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Textarea, cn } from "ui";
import { uploadAttachments } from "../../lib/attachments";
import { getDesktopBackendBase } from "../../lib/backendBase";
import { sanitizeDisplayContent } from "../../lib/citations";
import { getEffectiveModelForConversation } from "../../lib/effectiveModel";
import { notifyError, notifyWarning } from "../../lib/notify";
import { cancelAgentTask } from "../../lib/agentTaskActions";
import { createServerApi, readErrorMessage } from "../../lib/serverApi";
import { useSidecarAgentRun } from "../../hooks/useSidecarAgentRun";
import { readSseStream } from "../../lib/sse";
import { useChatStore } from "../../stores/chatStore";
import { useSidecarStore } from "../../stores/sidecarStore";
import type { ApiAgentRun, ChatStreamEvent, Message, MessageAttachmentMeta } from "../../types/chat";
import { DesktopCitationList } from "./DesktopCitationList";
import { DesktopAgentTaskCard, DesktopAgentTaskMetaLine } from "./DesktopAgentTaskCard";
import { DesktopChatHeader } from "./DesktopChatHeader";
import { DesktopComposer } from "./DesktopComposer";
import { DesktopMarkdownMessage } from "./DesktopMarkdownMessage";
import { DesktopMessageAttachments } from "./DesktopMessageAttachments";
import { DesktopModelPickerModal } from "./DesktopModelPickerModal";
import { DesktopSidecarRuntimePanel } from "./DesktopSidecarRuntimePanel";
import { DesktopStreamingMarkdownMessage } from "./DesktopStreamingMarkdownMessage";

const PAGE_PAD = "16px";
const COMPOSER_PAD_BOTTOM = "env(safe-area-inset-bottom, 0px)";
const desktopServerApi = createServerApi();
const PLACEHOLDERS = [
  "Start with a spark — I will shape the rest.",
  "What should we build, refine, or rethink today?",
  "Drop a thought. I will turn it into something real.",
  "Give me a direction, I will find the path.",
  "Ask anything. Then push it one level deeper.",
  "Sketch the idea. I will fill in the lines.",
  "Let us turn a question into a plan.",
  "Pitch the headline. I will write the story.",
  "Take the blank page. I will bring the motion.",
  "Name the problem. I will cut through it.",
  "Start messy. End elegant.",
  "One prompt away from clarity.",
  "Tell me the goal, I will map the route.",
  "What would you love to ship this week?",
  "Let us turn curiosity into momentum.",
  "If you can imagine it, we can draft it.",
  "Give me the vibe. I will deliver the words.",
  "Turn a rough idea into a sharp answer.",
  "Ask for bold. I will keep it grounded.",
  "What do you wish existed right now?",
  "We can brainstorm or go straight to done.",
  "Write less. Say more.",
  "A single line can unlock the whole plan.",
  "Let us design the next move.",
  "Bring the question. Leave with the output.",
  "Make it clear, make it quick, make it real.",
  "Want a first draft that actually works?",
  "Turn complexity into clean steps.",
  "Take a breath — then type the dream.",
  "If it matters, put it here.",
];

type DesktopSearchStatus = {
  configured: boolean;
  source: "user" | "server" | "none" | "disabled";
};

function pickPlaceholder(avoid?: string) {
  if (PLACEHOLDERS.length === 0) return "";
  if (PLACEHOLDERS.length === 1) return PLACEHOLDERS[0] ?? "";
  let next = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)] ?? "";
  if (avoid && PLACEHOLDERS.length > 1) {
    let tries = 0;
    while (next === avoid && tries < 4) {
      next = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)] ?? next;
      tries += 1;
    }
  }
  return next;
}

async function fetchDesktopSearchStatus(): Promise<DesktopSearchStatus> {
  const response = await fetch(`${getDesktopBackendBase()}/settings/search-status`, {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Failed to read search status"));
  }

  return (await response.json()) as DesktopSearchStatus;
}

function LiveStatusBadge({
  status,
  route,
  label,
}: {
  status?: Message["liveStatus"];
  route?: Message["liveRoute"];
  label?: string;
}) {
  if (!label) return null;

  const routeLabel = (() => {
    switch (route) {
      case "local":
        return "本地";
      case "structured_live":
        return "天气";
      case "web_search":
        return "搜索";
      case "research":
        return "调研";
      default:
        return "直答";
    }
  })();

  return (
    <div
      className={cn(
        "mb-2 inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        status === "live"
          ? "border-emerald-300/60 bg-emerald-50 text-emerald-700"
          : "border-amber-300/60 bg-amber-50 text-amber-700",
      )}
    >
      <span className="rounded-full bg-black/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
        {routeLabel}
      </span>
      <span>{label}</span>
    </div>
  );
}

function CollapsibleBlock({ children, maxLines = 3 }: { children: React.ReactNode; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || maxLines <= 0) return;
    setIsOverflowing(el.scrollHeight > maxLines * 24);
  });

  if (maxLines <= 0) return <>{children}</>;
  return (
    <div className="relative">
      <div
        ref={contentRef}
        className={cn(!expanded && isOverflowing && "overflow-hidden")}
        style={!expanded && isOverflowing ? { maxHeight: `${maxLines * 1.5}rem` } : undefined}
      >
        {children}
      </div>
      {isOverflowing && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-xs text-muted-foreground/60 hover:text-muted-foreground"
        >
          {expanded ? "··· 收起" : "··· 展开"}
        </button>
      )}
    </div>
  );
}

function AgentRunPanel({ run }: { run?: ApiAgentRun }) {
  if (!run) return null;
  const toolCount = run.steps.filter((step) => step.type === "tool_start").length;
  const hasThinking = run.steps.some((step) => step.type === "text");
  const shouldRender = Boolean(run.error) || toolCount > 0 || hasThinking;
  if (!shouldRender) return null;

  const presentToolLabel = (toolName: string | null | undefined) => {
    const normalized = (toolName ?? "").trim().toLowerCase();
    if (!normalized) return "Tool";
    if (normalized.includes("bash") || normalized.includes("terminal") || normalized === "shell") {
      return "Bash";
    }
    if (normalized.includes("search")) return "Search";
    if (normalized.includes("fetch")) return "Fetch";
    if (normalized.includes("read")) return "Read";
    if (normalized.includes("write")) return "Write";
    if (normalized.includes("browser")) return "Browser";
    if (normalized.startsWith("mcp__")) return "MCP";
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
    const summary = lines.slice(0, 2).join(" · ").replace(/\s+/g, " ").trim();
    return summary.length > 112 ? `${summary.slice(0, 109)}...` : summary;
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
    if (run.status !== "running") return null;
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
    <details className="mt-2 text-sm" open={run.status === "running" || run.status === "partial" || undefined}>
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
            <Bot size={12} className="shrink-0 text-muted-foreground" />
            <span className="truncate text-sm leading-6 text-muted-foreground">
              {displayTitle} <span className={cn("text-muted-foreground/70", statusClassName)}>&middot; {statusLabel}</span>
            </span>
          </div>
        </div>
      </summary>

      <div className="mt-2 flex flex-col gap-2.5">
        {run.error && (
          <DesktopAgentTaskMetaLine text={run.error} tone="danger" />
        )}
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
          const isActive = activeStartKey !== null && step.type === "tool_start" &&
            `${step.type}-${step.toolName || ""}-${step.content || ""}-${JSON.stringify(step.toolInput ?? null)}` === activeStartKey;
          const label = step.type === "error" ? "Error" : presentToolLabel(step.toolName);
          const detail =
            step.type === "tool_start"
              ? summarizeToolInput(step.toolInput)
              : step.type === "tool_result"
                ? summarizeToolResult(step.content)
                : step.content?.trim() || summarizeToolInput(step.toolInput);

          if (step.type === "tool_result" && !detail) return null;

          const text =
            step.type === "tool_result"
              ? `${label} done`
              : step.type === "error"
                ? label
                : label || detail;

          if (!text && !detail) return null;

          return (
            <CollapsibleBlock key={stepKey} maxLines={step.type === "tool_start" ? 3 : 0}>
              <DesktopAgentTaskMetaLine
                text={text ?? detail ?? "Tool"}
                subtext={detail}
                active={isActive}
                tone={step.type === "tool_result" ? "success" : step.type === "error" ? "danger" : "default"}
              />
            </CollapsibleBlock>
          );
        })}
      </div>
    </details>
  );
}

function TypingIndicator() {
  return (
    <div
      aria-label="正在生成"
      className="inline-flex items-center gap-1 rounded-full bg-muted/30 px-2.5 py-1.5 text-muted-foreground/80"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-70" />
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-70"
        style={{ animationDelay: "160ms" }}
      />
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-70"
        style={{ animationDelay: "320ms" }}
      />
    </div>
  );
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function fileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function IconActionButton({
  title,
  onClick,
  children,
  danger = false,
  disabled = false,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/50 bg-background/70 text-muted-foreground transition-colors",
        disabled
          ? "cursor-not-allowed opacity-40"
          : danger
            ? "hover:border-red-300/70 hover:bg-red-50 hover:text-red-600"
            : "hover:bg-background hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function MessageActionBar({
  message,
  copyValue,
  canEdit,
  canRetry,
  canDelete,
  isStreaming,
  onEdit,
  onRetry,
  onDelete,
}: {
  message: Message;
  copyValue?: string;
  canEdit: boolean;
  canRetry: boolean;
  canDelete: boolean;
  isStreaming: boolean;
  onEdit: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(copyValue ?? message.content ?? "");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        "mt-0.5 flex gap-0.5 transition-opacity duration-150",
        message.role === "assistant" ? "justify-start" : "justify-end",
        isStreaming
          ? "pointer-events-none opacity-0"
          : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
      )}
    >
      {message.role === "user" && (
        <IconActionButton onClick={onEdit} title="编辑" disabled={!canEdit}>
          <Pencil size={13} />
        </IconActionButton>
      )}
      <IconActionButton onClick={() => void handleCopy()} title={copied ? "已复制" : "复制"}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </IconActionButton>
      {message.role === "assistant" && (
        <IconActionButton onClick={onRetry} title="重新生成" disabled={!canRetry}>
          <RefreshCw size={13} />
        </IconActionButton>
      )}
      <IconActionButton onClick={onDelete} title="删除" danger disabled={!canDelete}>
        <Trash2 size={13} />
      </IconActionButton>
    </div>
  );
}

type GroupedMessageEntry = {
  msg: Message;
  index: number;
};

type MessageRoundGroup = {
  key: string;
  user?: GroupedMessageEntry;
  assistant?: GroupedMessageEntry;
};

function groupMessagesByRound(messages: Message[]): MessageRoundGroup[] {
  const groups: MessageRoundGroup[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    if (!msg) continue;

    if (msg.role === "user") {
      const next = messages[index + 1];
      if (next?.role === "assistant" && next.mode === msg.mode) {
        groups.push({
          key: `${msg.id}:${next.id}`,
          user: { msg, index },
          assistant: { msg: next, index: index + 1 },
        });
        index += 1;
        continue;
      }

      groups.push({
        key: msg.id,
        user: { msg, index },
      });
      continue;
    }

    groups.push({
      key: msg.id,
      assistant: { msg, index },
    });
  }

  return groups;
}

function MessageBubble({
  message,
  isStreaming,
  canEdit,
  canRetry,
  canDelete,
  onEdit,
  onRetry,
  onDelete,
  assistantWidth,
  userMaxWidth,
}: {
  message: Message;
  isStreaming: boolean;
  canEdit: boolean;
  canRetry: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onRetry: () => void;
  onDelete: () => void;
  assistantWidth: string;
  userMaxWidth: string;
}) {
  const isAssistant = message.role === "assistant";
  const isTaskStreaming =
    isAssistant &&
    Boolean(message.agentRun?.taskId) &&
    !["completed", "failed", "cancelled"].includes(
      message.agentRun?.taskStatus ?? message.agentRun?.status ?? "",
    );
  const isMessageStreaming = isStreaming || isTaskStreaming;
  const label = message.mode === "agent" ? "Agent" : "Chat";
  const badgeIcon = message.mode === "agent" ? <Bot size={12} /> : <MessageSquare size={12} />;
  const displayContent = isAssistant
    ? sanitizeDisplayContent(message.content, message.citations)
    : message.content;
  const hasAssistantText = isAssistant && Boolean((displayContent || "").trim());
  const isAssistantPlaceholder = isAssistant && isMessageStreaming && !hasAssistantText;
  const streamTailLength =
    isAssistant && isMessageStreaming && hasAssistantText ? (message.streamTail || "").length : 0;
  const isAgentTaskMessage = isAssistant && Boolean(message.agentRun?.taskId);
  const isFlatAgentAssistant = isAssistant && message.mode === "agent";
  const processPanel = isAssistant ? (
    message.agentRun?.taskId ? (
      <DesktopAgentTaskCard
        messageId={message.id}
        taskId={message.agentRun.taskId}
        fallbackContent={message.content || message.agentRun.summary}
      />
    ) : message.mode === "agent" && isMessageStreaming && !hasAssistantText && !(message.agentRun?.steps?.length) ? (
      <section className="mt-0.5 px-1 pt-0 pb-1">
        <DesktopAgentTaskMetaLine text={message.agentRun?.summary?.trim() || "Thinking"} active />
      </section>
    ) : (
      <AgentRunPanel run={message.agentRun} />
    )
  ) : null;

  return (
    <div
      className={cn(
        "group flex min-w-0 flex-col",
        isAssistant && "w-full",
        isAssistant ? "items-start self-start" : "items-end self-end",
      )}
      style={{ maxWidth: isAssistant ? assistantWidth : userMaxWidth }}
    >
      <div
        className={cn(
          isAssistant ? "block w-full min-w-0 max-w-full" : "inline-block min-w-0 max-w-full",
          isAssistantPlaceholder || isFlatAgentAssistant
            ? "border-0 bg-transparent px-0 py-0"
            : "rounded-2xl px-4 py-2",
          isAssistant
            ? isAssistantPlaceholder || isFlatAgentAssistant
              ? ""
              : "border border-border/50 bg-background/60"
            : "border border-border/50 bg-foreground/[0.06]",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-1 text-[11px] leading-none font-medium",
            isAssistant ? "mb-1.5" : "mb-1",
            isAssistant ? "text-muted-foreground" : "text-foreground/60",
          )}
        >
          {badgeIcon}
          <span>{label}</span>
        </div>

        {!isAssistant && message.attachmentsMeta && message.attachmentsMeta.length > 0 && (
          <DesktopMessageAttachments attachments={message.attachmentsMeta} />
        )}

        {processPanel}

        {isAssistant && !isAgentTaskMessage ? (
          <div className={cn("min-w-0 max-w-full", processPanel && "mt-3")}>
            <LiveStatusBadge
              status={message.liveStatus}
              route={message.liveRoute}
              label={message.liveLabel}
            />
            <div
              className="text-sm leading-6"
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
                maxWidth: "100%",
              }}
            >
              {hasAssistantText ? (
                isMessageStreaming ? (
                  <DesktopStreamingMarkdownMessage
                    content={displayContent}
                    tailLength={streamTailLength}
                    pulseKey={message.streamPulseKey ?? 0}
                  />
                ) : (
                  <DesktopMarkdownMessage content={displayContent} />
                )
              ) : isMessageStreaming && !isFlatAgentAssistant ? (
                <TypingIndicator />
              ) : null}
            </div>
            <DesktopCitationList citations={message.citations} content={displayContent} />
          </div>
        ) : !isAssistant ? (
          message.content?.trim() ? (
            <p
              className="text-sm"
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
                maxWidth: "100%",
              }}
            >
              {message.content}
            </p>
          ) : null
        ) : null}
      </div>
      <MessageActionBar
        message={message}
        copyValue={displayContent}
        canEdit={canEdit}
        canRetry={canRetry}
        canDelete={canDelete}
        isStreaming={isStreaming}
        onEdit={onEdit}
        onRetry={onRetry}
        onDelete={onDelete}
      />
    </div>
  );
}

export function DesktopChatArea() {
  const ASSISTANT_BUBBLE_WIDTH = "92%";
  const USER_BUBBLE_MAX_WIDTH = "72%";
  const currentConversation = useChatStore((state) => state.currentConversation);
  const channels = useChatStore((state) => state.channels);
  const messages = useChatStore((state) => state.messages);
  const isLoading = useChatStore((state) => state.isLoading);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const composerMode = useChatStore((state) => state.composerMode);
  const setComposerMode = useChatStore((state) => state.setComposerMode);
  const addMessage = useChatStore((state) => state.addMessage);
  const autoTitleConversation = useChatStore((state) => state.autoTitleConversation);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const applyStreamEvent = useChatStore((state) => state.applyStreamEvent);
  const loadMessages = useChatStore((state) => state.loadMessages);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const deleteMessage = useChatStore((state) => state.deleteMessage);
  const regenerateMessage = useChatStore((state) => state.regenerateMessage);
  const abortStreaming = useChatStore((state) => state.abortStreaming);
  const setLoading = useChatStore((state) => state.setLoading);
  const setStreaming = useChatStore((state) => state.setStreaming);
  const setError = useChatStore((state) => state.setError);
  const editUserMessage = useChatStore((state) => state.editUserMessage);
  const updateMessage = useChatStore((state) => state.updateMessage);
  const [input, setInput] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [placeholder, setPlaceholder] = useState(() => pickPlaceholder());
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingPreviewUrlsRef = useRef<Map<string, string[]>>(new Map());
  const pendingScrollTargetRef = useRef<{ type: "bottom" } | { type: "message"; id: string } | null>(
    null,
  );
  const messageAnchorRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const [sidecarRuntimeEnabled, setSidecarRuntimeEnabled] = useState(false);
  const sidecarRun = useSidecarAgentRun();
  const sidecarStatus = useSidecarStore((state) => state.status);
  const sidecarWorkspaceRoot = useSidecarStore((state) => state.workspaceRoot);
  const sidecarLastError = useSidecarStore((state) => state.lastError);
  const sidecarRuntimeAvailable =
    sidecarStatus === "ready" && Boolean(sidecarWorkspaceRoot);
  const sidecarRuntimeDisabledReason = sidecarRuntimeAvailable
    ? null
    : sidecarStatus === "unsupported"
      ? "当前环境不支持本地运行"
      : sidecarStatus === "error"
        ? sidecarLastError ?? "本地 Agent 运行异常"
        : sidecarStatus !== "ready"
          ? "本地 Agent 运行尚未就绪"
          : "请先在顶部选择工作目录";
  // When the sidecar flips out of "ready" (or loses its workspace root),
  // silently switch the composer back to the server runtime. This
  // prevents the user from sending a message that would be dropped.
  useEffect(() => {
    if (sidecarRuntimeEnabled && !sidecarRuntimeAvailable) {
      setSidecarRuntimeEnabled(false);
    }
  }, [sidecarRuntimeEnabled, sidecarRuntimeAvailable]);

  const prevSidecarBusyRef = useRef(false);
  useEffect(() => {
    const wasBusy = prevSidecarBusyRef.current;
    prevSidecarBusyRef.current = sidecarRun.isBusy;
    if (wasBusy && !sidecarRun.isBusy) {
      setStreaming(false);
      setStreamingAssistantId(null);
      const conv = useChatStore.getState().currentConversation;
      if (conv && /^新会话 \d{2}-\d{2} \d{2}:\d{2}$/.test(conv.title)) {
        const firstUserMsg = useChatStore
          .getState()
          .messages.find((m) => m.conversationId === conv.id && m.role === "user");
        const seed = firstUserMsg?.content || "";
        if (seed) {
          void autoTitleConversation(conv.id, seed).catch(() => {});
        }
      }
    }
  }, [sidecarRun.isBusy, autoTitleConversation]);

  // Per-task agent overrides: these are ephemeral state that resets
  // when the user sends or switches conversations. They override the
  // stored defaults for just the next agent message.
  const [agentOverrideDeep, setAgentOverrideDeep] = useState(false);
  const [agentOverridePlanApproval, setAgentOverridePlanApproval] = useState(false);
  const effectiveModel = getEffectiveModelForConversation(channels, currentConversation);
  const agentModeSupported = effectiveModel.ok;
  const agentModeDisabledReason = effectiveModel.ok
    ? null
    : "请先配置可用模型后再使用 Agent 模式。";
  const hasInput = Boolean(input.trim());
  const hasFiles = pendingAttachments.length > 0;
  const forceWebSearch = currentConversation?.forceWebSearch ?? true;
  const canSend =
    effectiveModel.ok &&
    Boolean(currentConversation) &&
    !isLoading &&
    !isStreaming &&
    !isUploading &&
    (hasInput || hasFiles);
  const groupedMessages = groupMessagesByRound(messages);

  useEffect(() => {
    pendingScrollTargetRef.current = { type: "bottom" };
    queueMicrotask(() => inputRef.current?.focus());
  }, [currentConversation?.id]);

  useLayoutEffect(() => {
    const viewportEl = viewportRef.current;
    const pending = pendingScrollTargetRef.current;
    if (!viewportEl || !pending) return;

    if (pending.type === "bottom") {
      viewportEl.scrollTop = viewportEl.scrollHeight;
      pendingScrollTargetRef.current = null;
      return;
    }

    const anchorEl = messageAnchorRefs.current.get(pending.id);
    if (!anchorEl) return;

    const desiredTop =
      anchorEl.getBoundingClientRect().top -
      viewportEl.getBoundingClientRect().top +
      viewportEl.scrollTop;

    viewportEl.scrollTop = desiredTop;

    const currentAnchor = messageAnchorRefs.current.get(pending.id);
    if (!currentAnchor) return;

    const distanceFromTop =
      currentAnchor.getBoundingClientRect().top - viewportEl.getBoundingClientRect().top;

    if (Math.abs(distanceFromTop) <= 4 || !isStreaming) {
      pendingScrollTargetRef.current = null;
    }
  }, [messages, currentConversation?.id, editingMessageId, isStreaming]);

  useEffect(() => {
    setStreamingAssistantId(null);
  }, [currentConversation?.id]);

  useEffect(() => {
    setPendingAttachments([]);
  }, [currentConversation?.id]);

  useEffect(() => {
    if (!input.trim()) {
      setPlaceholder((prev) => pickPlaceholder(prev));
    }
  }, [currentConversation?.id, input]);

  useEffect(() => {
    return () => {
      for (const urls of pendingPreviewUrlsRef.current.values()) {
        for (const url of urls) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore
          }
        }
      }
      pendingPreviewUrlsRef.current.clear();
    };
  }, [currentConversation?.id]);

  const getEditableMessageRound = (messageId: string) => {
    const messageIndex = messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) return null;

    const userMessage = messages[messageIndex];
    const assistantMessage = messages[messageIndex + 1];
    if (
      !userMessage ||
      userMessage.role !== "user" ||
      userMessage.id.startsWith("draft-")
    ) {
      return null;
    }
    if (
      assistantMessage &&
      (assistantMessage.role !== "assistant" ||
        assistantMessage.mode !== userMessage.mode ||
        assistantMessage.id.startsWith("draft-"))
    ) {
      return null;
    }

    return { userMessage, assistantMessage };
  };

  const handleAddAttachments = (files: File[]) => {
    setPendingAttachments((currentFiles) => {
      const seen = new Set(currentFiles.map(fileKey));
      const nextFiles = [...currentFiles];

      for (const file of files) {
        const key = fileKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        nextFiles.push(file);
      }

      return nextFiles;
    });
  };

  const handleRemoveAttachment = (file: File) => {
    const targetKey = fileKey(file);
    setPendingAttachments((currentFiles) => currentFiles.filter((item) => fileKey(item) !== targetKey));
  };

  const consumeStreamingResponse = async (messageId: string, response: Response) => {
    let terminalEvent: Extract<ChatStreamEvent, { type: "done" | "error" }> | null = null;

    await readSseStream(response, (event) => {
      if (event.type === "delta") {
        const chunk = event.content || "";
        if (!chunk) return;
        useChatStore.getState().appendMessageDelta(messageId, chunk);
        return;
      }

      if (event.type === "done" || event.type === "error") {
        terminalEvent = event;
        return;
      }

      applyStreamEvent(messageId, event);
    });

    if (terminalEvent) {
      applyStreamEvent(messageId, terminalEvent);
    }
  };

  const handleInputFocus = () => {
    if (!input.trim()) {
      setPlaceholder((prev) => pickPlaceholder(prev));
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      const nativeEvent = event.nativeEvent;
      const keyCode =
        "keyCode" in nativeEvent ? (nativeEvent.keyCode as number | undefined) : undefined;
      if (nativeEvent.isComposing || keyCode === 229) {
        return;
      }
      event.preventDefault();
      void handleSend();
    }
  };

  const handleSend = async () => {
    if (!canSend || !currentConversation) return;

    if (composerMode === "agent" && !agentModeSupported) {
      notifyWarning(
        "Agent 当前不可用",
        agentModeDisabledReason || "请先配置可用模型后再使用 Agent 模式。",
      );
      return;
    }

    const conversationId = currentConversation.id;
    const mode = composerMode;
    const trimmed = input.trim();
    const effectiveContent = trimmed.length > 0 ? trimmed : "";
    const files = pendingAttachments;
    const autoTitleSeed =
      trimmed.length > 0
        ? trimmed
        : files.length > 0
          ? `Attachments: ${files.map((file) => file.name).join(", ")}`
          : "";
    const previewUrls: string[] = [];
    const localAttachmentMeta: MessageAttachmentMeta[] = files.map((file) => {
      const previewUrl = file.type?.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (previewUrl) {
        previewUrls.push(previewUrl);
      }
      return {
        fileName: file.name,
        fileType: file.type || undefined,
        fileSize: file.size,
        previewUrl,
      };
    });
    const userMessageId = `temp-${Date.now()}`;
    const assistantMessageId = `temp-assistant-${Date.now()}`;
    if (previewUrls.length > 0) {
      pendingPreviewUrlsRef.current.set(userMessageId, previewUrls);
    }

    let attachmentIds: string[] | undefined;
    let attachmentsMeta:
      | Array<{
          id: string;
          fileName: string;
          fileType: string;
          fileSize: number;
      }>
      | undefined;

    let forceCliOAuthSidecar = false;
    if (mode === "agent" && currentConversation.channelId) {
      try {
        const { credentials } = await createServerApi().channels.getCredentials(
          currentConversation.channelId,
        );
        if (credentials.isCliOAuth && credentials.protocol !== "anthropic") {
          const sidecar = useSidecarStore.getState();
          if (sidecar.status !== "ready") {
            if (sidecar.status === "idle" || sidecar.status === "error") {
              await sidecar.start();
            }
            const retried = useSidecarStore.getState();
            if (retried.status !== "ready") {
              notifyError(
                "需要启用本地运行",
                "Codex CLI 渠道需要本地运行环境。请确认桌面端已启动。",
              );
              return;
            }
          }
          forceCliOAuthSidecar = true;
        }
      } catch {
        // Credential check failed — let the normal flow handle it
      }
    }

    const useSidecarRuntime =
      mode === "agent" && (forceCliOAuthSidecar || (sidecarRuntimeEnabled && sidecarRuntimeAvailable));
    try {
      addMessage({
        id: userMessageId,
        conversationId,
        role: "user",
        content: effectiveContent,
        mode,
        attachmentsMeta: localAttachmentMeta.length > 0 ? localAttachmentMeta : undefined,
        createdAt: new Date(),
      });
      addMessage({
        id: assistantMessageId,
        conversationId,
        role: "assistant",
        content: "",
        mode,
        runtimeKind: useSidecarRuntime ? "sidecar" : "server",
        agentRun:
          mode === "agent"
            ? {
                status: "partial",
                summary: "Thinking",
                steps: [],
              }
            : undefined,
        createdAt: new Date(),
      });
      pendingScrollTargetRef.current = { type: "message", id: userMessageId };
      setInput("");
      setLoading(true);
      setStreaming(true);
      setStreamingAssistantId(assistantMessageId);
      setError(null);
      queueMicrotask(() => inputRef.current?.focus());

      if (useSidecarRuntime) {
        if (files.length > 0) {
          notifyWarning(
            "本地运行暂不支持附件",
            "本次运行将忽略已添加的附件；如需使用附件请关闭本地运行。",
          );
        }
        if (!currentConversation.channelId) {
          throw new Error("当前会话没有绑定渠道，无法本地运行");
        }
        if (!effectiveModel.ok) {
          throw new Error("未找到可用模型，无法本地运行");
        }
        await sidecarRun.startRun({
          conversationId,
          channelId: currentConversation.channelId,
          modelId: effectiveModel.modelId,
          assistantMessageId,
          prompt: effectiveContent,
        });

        setLoading(false);
        setIsUploading(false);
        queueMicrotask(() => inputRef.current?.focus());
        return;
      }

      if (files.length > 0) {
        setIsUploading(true);
        const upload = await uploadAttachments({
          conversationId,
          files,
        });
        attachmentIds = upload.attachments.map((attachment) => attachment.id);
        attachmentsMeta = upload.attachments.map((attachment) => ({
          id: attachment.id,
          fileName: attachment.fileName,
          fileType: attachment.fileType,
          fileSize: attachment.fileSize,
        }));
        updateMessage(userMessageId, {
          attachments: attachmentIds,
          attachmentsMeta: localAttachmentMeta.map((local, index) => {
            const server = upload.attachments[index];
            return {
              ...local,
              id: server?.id ?? local.id,
              fileName: server?.fileName ?? local.fileName,
              fileType: server?.fileType ?? local.fileType,
              fileSize: server?.fileSize ?? local.fileSize,
            };
          }),
        });
        setPendingAttachments([]);
      }

      // Build per-message agent overrides from the composer switches.
      // Only included when the user explicitly toggled something away
      // from the defaults — otherwise we leave them absent so the
      // server uses the stored defaults.
      const agentOverrides =
        mode === "agent" && (agentOverrideDeep || agentOverridePlanApproval)
          ? {
              ...(agentOverrideDeep ? { complexity: "deep" as const } : {}),
              ...(agentOverridePlanApproval
                ? { requiresPlanApproval: true }
                : {}),
            }
          : undefined;

      // Reset the per-task overrides after we've captured them so the
      // next message starts from the stored defaults again.
      setAgentOverrideDeep(false);
      setAgentOverridePlanApproval(false);

      const { response } = await sendMessage({
        content: effectiveContent,
        attachments: attachmentIds,
        attachmentsMeta:
          attachmentsMeta || (localAttachmentMeta.length > 0 ? localAttachmentMeta : undefined),
        mode,
        agentOverrides,
        existingMessageIds: {
          userMessageId,
          assistantMessageId,
        },
      });

      await consumeStreamingResponse(assistantMessageId, response);

      setStreaming(false);
      setStreamingAssistantId(null);
      await Promise.all([loadMessages(conversationId), loadConversations()]);
      const nextConversation = useChatStore.getState().currentConversation;
      if (
        nextConversation &&
        nextConversation.id === conversationId &&
        /^新会话 \d{2}-\d{2} \d{2}:\d{2}$/.test(nextConversation.title) &&
        autoTitleSeed
      ) {
        void autoTitleConversation(conversationId, autoTitleSeed).catch(() => {});
      }

      const urls = pendingPreviewUrlsRef.current.get(userMessageId);
      if (urls) {
        for (const url of urls) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore
          }
        }
        pendingPreviewUrlsRef.current.delete(userMessageId);
      }
    } catch (error) {
      setLoading(false);
      setStreaming(false);
      setStreamingAssistantId(null);
      if (isAbortError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : "Stream error";
      useChatStore.getState().failStreamingMessage(assistantMessageId, message);
      setError(message);
    } finally {
      setLoading(false);
      setIsUploading(false);
      queueMicrotask(() => inputRef.current?.focus());
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    try {
      await deleteMessage(messageId);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Delete message failed");
    }
  };

  const handleRetryMessage = async (messageId: string) => {
    if (!currentConversation) return;

    const messageIndex = messages.findIndex((message) => message.id === messageId);
    const assistantMessage = messageIndex >= 0 ? messages[messageIndex] : null;
    if (!assistantMessage || assistantMessage.role !== "assistant") return;

    let userMessage: Message | null = null;
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate?.role === "user") {
        userMessage = candidate;
        break;
      }
    }

    if (userMessage) {
      pendingScrollTargetRef.current = { type: "message", id: userMessage.id };
    }
    setLoading(true);
    setStreaming(true);
    setStreamingAssistantId(messageId);
    setError(null);
    useChatStore.getState().updateMessage(messageId, {
      content: "",
      streamTail: undefined,
      streamPulseKey: 0,
      citations: undefined,
      liveStatus: undefined,
      liveRoute: undefined,
      liveLabel: undefined,
      agentRun:
        assistantMessage.mode === "agent"
          ? {
              status: "partial",
              summary: "Thinking",
              steps: [],
            }
          : undefined,
    });

    try {
      const response = await regenerateMessage(
        messageId,
        userMessage && !userMessage.id.startsWith("draft-")
          ? {
              userMessageId: userMessage.id,
              userContent: userMessage.content,
            }
          : undefined,
      );

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Failed to regenerate message"));
      }

      await consumeStreamingResponse(messageId, response);

      setStreaming(false);
      setStreamingAssistantId(null);
      await Promise.all([loadMessages(currentConversation.id), loadConversations()]);
    } catch (error) {
      setLoading(false);
      setStreaming(false);
      setStreamingAssistantId(null);
      if (isAbortError(error)) {
        return;
      }
      setError(error instanceof Error ? error.message : "Retry message failed");
      useChatStore.getState().failStreamingMessage(
        messageId,
        error instanceof Error ? error.message : "Retry message failed",
      );
    } finally {
      setLoading(false);
    }
  };

  const handleStartEdit = (message: Message) => {
    const editable = getEditableMessageRound(message.id);
    if (!editable) return;
    setEditingMessageId(message.id);
    setEditingContent(message.content);
  };

  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditingContent("");
  };

  const handleSaveEdit = async (messageId: string) => {
    const nextContent = editingContent.trim();
    if (!currentConversation || !nextContent) return;

    const editable = getEditableMessageRound(messageId);
    if (!editable) {
      notifyWarning("当前消息不可编辑", "这条用户消息后面没有对应的助手回复，无法重新编辑并生成。");
      handleCancelEdit();
      return;
    }

    const { userMessage, assistantMessage: existingAssistantMessage } = editable;
    const assistantMessageId =
      existingAssistantMessage?.id ?? `temp-assistant-edit-${Date.now()}`;
    handleCancelEdit();
    pendingScrollTargetRef.current = { type: "message", id: userMessage.id };
    setLoading(true);
    setStreaming(true);
    setStreamingAssistantId(assistantMessageId);
    setError(null);
    useChatStore.getState().updateMessage(userMessage.id, { content: nextContent });
    if (existingAssistantMessage) {
      useChatStore.getState().updateMessage(existingAssistantMessage.id, {
        content: "",
        streamTail: undefined,
        streamPulseKey: 0,
        citations: undefined,
        liveStatus: undefined,
        liveRoute: undefined,
        liveLabel: undefined,
        agentRun:
          existingAssistantMessage.mode === "agent"
            ? {
                status: "partial",
                summary: "Thinking",
                steps: [],
              }
            : undefined,
      });
    } else {
      addMessage({
        id: assistantMessageId,
        conversationId: currentConversation.id,
        role: "assistant",
        content: "",
        mode: userMessage.mode,
        agentRun:
          userMessage.mode === "agent"
          ? {
              status: "partial",
              summary: "Thinking",
              steps: [],
            }
          : undefined,
        createdAt: new Date(),
      });
    }

    try {
      const response = await editUserMessage(userMessage.id, nextContent);
      await consumeStreamingResponse(assistantMessageId, response);

      setStreaming(false);
      setStreamingAssistantId(null);
      await Promise.all([loadMessages(currentConversation.id), loadConversations()]);
    } catch (error) {
      setLoading(false);
      setStreaming(false);
      setStreamingAssistantId(null);
      if (isAbortError(error)) {
        return;
      }
      setError(error instanceof Error ? error.message : "Edit message failed");
      useChatStore.getState().failStreamingMessage(
        assistantMessageId,
        error instanceof Error ? error.message : "Edit message failed",
      );
    } finally {
      setLoading(false);
    }
  };

  const handleToggleWebSearch = async () => {
    if (!currentConversation) return;

    const next = !forceWebSearch;
    if (next) {
      try {
        const status = await fetchDesktopSearchStatus();
        if (!status.configured || status.source === "none") {
          notifyWarning(
            "未配置实时搜索",
            "未检测到 Tavily Key，需要最新信息时的联网搜索可能无法使用。请在设置中填写或配置服务端 TAVILY_API_KEY。",
          );
        } else if (status.source === "disabled") {
          notifyWarning(
            "实时搜索已关闭",
            "在设置中启用 Tavily 搜索后，系统才会在需要最新信息时联网。",
          );
        }
      } catch {
        // ignore search-status probe failures
      }
    }

    try {
      await useChatStore
        .getState()
        .updateConversation(currentConversation.id, { forceWebSearch: next });
    } catch {
      // updateConversation already restores previous state and records the error
    }
  };

  const handleStop = async () => {
    // If the active stream belongs to a task-backed agent run, ask the
    // server to actually cancel the task before tearing down the local
    // SSE connection. Without this the task keeps running on the server
    // even though the desktop UI looks stopped.
    const streamingMessage = streamingAssistantId
      ? useChatStore
          .getState()
          .messages.find((message) => message.id === streamingAssistantId)
      : null;
    const activeTaskId = streamingMessage?.agentRun?.taskId ?? null;

    if (activeTaskId) {
      const result = await cancelAgentTask({
        api: {
          respondApproval: (id, data) =>
            desktopServerApi.agentTasks.respondApproval(id, data),
          cancel: (id) => desktopServerApi.agentTasks.cancel(id),
        },
        taskId: activeTaskId,
        onLocalAbort: () => abortStreaming(),
      });
      if (!result.ok) {
        // The local abort already happened in onLocalAbort; just surface
        // the cancel failure so the user knows the task may still be
        // running on the server.
        setError(result.error);
      }
    } else {
      abortStreaming();
    }

    setLoading(false);
    setStreaming(false);
    setStreamingAssistantId(null);
    if (!currentConversation) return;
    try {
      await loadMessages(currentConversation.id);
    } catch {
      // ignore reload failures after stop
    }
    queueMicrotask(() => inputRef.current?.focus());
  };

  if (!currentConversation) {
    return (
      <div className="flex flex-1 flex-col overflow-x-hidden">
        <div style={{ padding: PAGE_PAD, paddingBottom: "8px" }}>
          <DesktopChatHeader conversation={null} />
        </div>
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">在左侧选择一个会话，或创建新会话开始交流</p>
        </div>
      </div>
    );
  }

  const renderMessageRow = (message: Message, index: number) => (
    <div
      ref={(node) => {
        if (message.role !== "user") return;
        if (node) {
          messageAnchorRefs.current.set(message.id, node);
          return;
        }
        messageAnchorRefs.current.delete(message.id);
      }}
      className={cn(
        "flex min-w-0 flex-col",
        message.role === "assistant" ? "items-start" : "items-end",
      )}
    >
      {(() => {
        const isTaskStreaming =
          message.role === "assistant" &&
          Boolean(message.agentRun?.taskId) &&
          !["completed", "failed", "cancelled"].includes(
            message.agentRun?.taskStatus ?? message.agentRun?.status ?? "",
          );
        const isMessageStreaming =
          Boolean(isStreaming && streamingAssistantId && message.id === streamingAssistantId) || isTaskStreaming;

        return (
          <MessageBubble
            message={message}
            isStreaming={isMessageStreaming}
            canEdit={Boolean(getEditableMessageRound(message.id))}
            canRetry={message.role === "assistant" && !isLoading && !isMessageStreaming && !isUploading}
            canDelete={!message.id.startsWith("draft-")}
            onEdit={() => handleStartEdit(message)}
            onRetry={() => void handleRetryMessage(message.id)}
            onDelete={() => void handleDeleteMessage(message.id)}
            assistantWidth={ASSISTANT_BUBBLE_WIDTH}
            userMaxWidth={USER_BUBBLE_MAX_WIDTH}
          />
        );
      })()}

      {message.role === "user" && editingMessageId === message.id && (
        <div className="mt-1 flex w-full max-w-[72%] self-end flex-col items-end gap-1">
          <Textarea
            value={editingContent}
            onChange={(event) => setEditingContent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSaveEdit(message.id);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                handleCancelEdit();
              }
            }}
            className="w-full"
            rows={3}
            autoFocus
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={handleCancelEdit}>
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSaveEdit(message.id)}
              disabled={!editingContent.trim() || isStreaming}
            >
              确认
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden">
      <div style={{ padding: PAGE_PAD, paddingBottom: "8px" }}>
        <DesktopChatHeader conversation={currentConversation} />
      </div>

      <div
        ref={viewportRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto scrollbar-thin"
        style={{ paddingLeft: PAGE_PAD, paddingRight: PAGE_PAD }}
      >
        <div className="flex min-w-0 w-full flex-col">
          <div className="mt-auto flex min-w-0 flex-col gap-2 pb-2">
            {groupedMessages.map((group) => (
              <div key={group.key} className="flex min-w-0 flex-col gap-2">
                {group.user ? renderMessageRow(group.user.msg, group.user.index) : null}
                {group.assistant ? renderMessageRow(group.assistant.msg, group.assistant.index) : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      {!effectiveModel.ok && (
        <div style={{ paddingLeft: PAGE_PAD, paddingRight: PAGE_PAD }}>
          {effectiveModel.scope === "conversation" ? (
            <div className="mb-2 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm shadow-minimal">
              <p className="font-medium text-orange-800">当前会话模型不可用</p>
              <p className="text-orange-700">{effectiveModel.reason}</p>
              <p className="mt-1 text-xs text-muted-foreground">在下方输入框的 Model 里修复即可。</p>
            </div>
          ) : (
            <div className="mb-2 flex items-center gap-3 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm shadow-minimal">
              <p className="flex-1 text-orange-700">{effectiveModel.reason}</p>
              <p className="text-xs text-muted-foreground">
                Set a default model in Settings (gear) → Channels
              </p>
            </div>
          )}
        </div>
      )}

      <div
        style={{
          paddingLeft: PAGE_PAD,
          paddingRight: PAGE_PAD,
          paddingBottom: COMPOSER_PAD_BOTTOM,
        }}
      >
        <DesktopSidecarRuntimePanel
          pendingApproval={sidecarRun.pendingApproval}
          lastError={sidecarRun.lastError}
          isBusy={sidecarRun.isBusy && !sidecarRun.pendingApproval && !isStreaming}
          lastFinishedRunId={sidecarRun.lastFinishedRunId}
          isRollingBack={sidecarRun.isRollingBack}
          rollbackError={sidecarRun.rollbackError}
          onApprove={(toolUseId) => void sidecarRun.respondToApproval(toolUseId, true)}
          onReject={(toolUseId) => void sidecarRun.respondToApproval(toolUseId, false)}
          onCancel={() => void sidecarRun.cancel()}
          onRollback={() => void sidecarRun.rollbackLast()}
        />
        <DesktopComposer
          value={input}
          onChange={setInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          attachments={pendingAttachments}
          disabled={isUploading}
          onAddAttachments={handleAddAttachments}
          onRemoveAttachment={handleRemoveAttachment}
          mode={composerMode}
          onModeChange={(nextMode) => {
            if (nextMode === "agent" && !agentModeSupported) {
              notifyWarning(
                "Agent 当前不可用",
                agentModeDisabledReason || "请先配置可用模型后再使用 Agent 模式。",
              );
              return;
            }
            setComposerMode(nextMode);
          }}
          agentModeAvailable={agentModeSupported}
          agentModeDisabledReason={agentModeDisabledReason}
          onSubmit={() => void handleSend()}
          modelProvider={effectiveModel.ok ? effectiveModel.provider : null}
          modelLabel={
            effectiveModel.ok
              ? effectiveModel.modelDisplayName
              : effectiveModel.scope === "conversation"
                ? "Fix model"
                : "Select model"
          }
          modelTone={effectiveModel.ok ? "normal" : "warning"}
          onOpenModelPicker={() => setModelPickerOpen(true)}
          forceWebSearch={forceWebSearch}
          onToggleWebSearch={() => void handleToggleWebSearch()}
          sidecarRuntimeAvailable={sidecarRuntimeAvailable}
          sidecarRuntimeEnabled={sidecarRuntimeEnabled}
          sidecarRuntimeDisabledReason={sidecarRuntimeDisabledReason}
          onToggleSidecarRuntime={
            // Mirror the DesktopSidecarWorkspaceBadge visibility rule:
            // when the host cannot host the sidecar at all, hide the
            // toggle entirely instead of rendering a permanently-
            // disabled button. Every other status (starting, error,
            // ready-without-workspace) still renders the toggle with
            // an explanatory disabled tooltip.
            sidecarStatus === "unsupported"
              ? undefined
              : () => {
                  if (!sidecarRuntimeAvailable) return;
                  setSidecarRuntimeEnabled((value) => !value);
                }
          }
          agentOverrideDeep={agentOverrideDeep}
          onToggleAgentOverrideDeep={() => setAgentOverrideDeep((v) => !v)}
          agentOverridePlanApproval={agentOverridePlanApproval}
          onToggleAgentOverridePlanApproval={() => setAgentOverridePlanApproval((v) => !v)}
          onInputFocus={handleInputFocus}
          streaming={isStreaming}
          canSubmit={canSend}
          onStop={() => void handleStop()}
          inputRef={inputRef}
        />
      </div>

      {modelPickerOpen && (
        <DesktopModelPickerModal
          opened={modelPickerOpen}
          onClose={() => setModelPickerOpen(false)}
          conversationId={currentConversation.id}
          conversationFixReason={
            !effectiveModel.ok && effectiveModel.scope === "conversation"
              ? effectiveModel.reason
              : null
          }
          current={
            currentConversation.channelId && currentConversation.modelId
              ? {
                  channelId: currentConversation.channelId,
                  modelId: currentConversation.modelId,
                }
              : effectiveModel.ok
                ? {
                    channelId: effectiveModel.channelId,
                    modelId: effectiveModel.modelId,
                  }
                : null
          }
        />
      )}
    </div>
  );
}
