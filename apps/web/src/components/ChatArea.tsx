"use client";

import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  MessageSquare,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  type MessageAttachmentItem,
  MessageAttachments,
} from "@/components/attachments/MessageAttachments";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { ModelPickerModal } from "@/components/chat/ModelPickerModal";
import { PromaComposer } from "@/components/composer/PromaComposer";
import { Button } from "@/components/ui/button";
import { CitationBadge } from "@/components/ui/CitationReference";
import { IconActionButton } from "@/components/ui/IconActionButton";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { StreamingMarkdownMessage } from "@/components/ui/StreamingMarkdownMessage";
import { TypingIndicator } from "@/components/ui/TypingIndicator";
import { Textarea } from "@/components/ui/textarea";
import { WRAP_TEXT } from "@/components/ui/wrapText";
import { getEffectiveModelForConversation } from "@/lib/effective-model";
import { normalizeExternalUrl } from "@/lib/normalizeExternalUrl";
import { createTextStreamSmoother, type TextStreamSmoother } from "@/lib/textStreamSmoother";
import { cn } from "@/lib/utils";
import {
  type ApiAgentRun,
  type ApiCitation,
  type ApiLiveRoute,
  type ApiLiveStatus,
  api,
} from "../lib/api";
import { uploadAttachments } from "../lib/attachments";
import { streamChatMessage } from "../lib/chat-stream";
import { notifyWarning } from "../lib/notify";
import { type Message, useChatStore } from "../stores/chatStore";

const PAGE_PAD = "16px";
const COMPOSER_PAD_BOTTOM = "env(safe-area-inset-bottom, 0px)";
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

type AgentStreamEvent = {
  type: string;
  content?: string;
  toolName?: string;
  toolInput?: unknown;
};

function createPartialAgentRun(): ApiAgentRun {
  return { status: "partial", summary: "Agent 正在执行", steps: [] };
}

function applyAgentEventToRun(run: ApiAgentRun | undefined, event: AgentStreamEvent): ApiAgentRun {
  const base = run || createPartialAgentRun();

  if (event.type === "tool_start" || event.type === "tool_result") {
    return {
      ...base,
      summary: "Agent 正在执行",
      steps: [
        ...base.steps,
        {
          type: event.type,
          toolName: event.toolName,
          content: event.content,
          toolInput: event.toolInput,
        },
      ],
    };
  }

  if (event.type === "error") {
    const message = event.content || "Agent error";
    return {
      ...base,
      status: "failed",
      summary: "Agent 执行失败",
      error: message,
      steps: [...base.steps, { type: "error", content: message }],
    };
  }

  return base;
}

function createFailedAgentRun(existing: ApiAgentRun | undefined, error: string): ApiAgentRun {
  return {
    status: "failed",
    summary: "Agent 执行失败",
    error,
    steps: existing?.steps || [],
  };
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

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

function AgentRunPanel({ run }: { run?: ApiAgentRun }) {
  if (!run) return null;

  return (
    <details className="mt-2 rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">{run.summary || "Agent 执行记录"}</span>
          <span className="text-xs text-muted-foreground">{run.status}</span>
        </div>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {run.error && (
          <div className="rounded-md border border-orange-200 bg-orange-50 px-2 py-1.5 text-xs text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300">
            {run.error}
          </div>
        )}
        {run.steps.length === 0 ? (
          <p className="text-xs text-muted-foreground">无额外执行步骤。</p>
        ) : (
          run.steps.map((step) => (
            <div
              key={`${step.type}-${step.toolName || ""}-${step.content || ""}`}
              className="rounded-md border border-border/50 bg-background/60 px-2 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {step.type}
                </p>
                {step.toolName && <p className="text-xs text-muted-foreground">{step.toolName}</p>}
              </div>
              {step.content && (
                <p className="mt-1 text-sm" style={WRAP_TEXT}>
                  {step.content}
                </p>
              )}
              {step.toolInput !== undefined && (
                <pre
                  className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-xs"
                  style={WRAP_TEXT}
                >
                  {JSON.stringify(step.toolInput, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </details>
  );
}

function LiveStatusBadge({
  status,
  route,
  label,
}: {
  status?: ApiLiveStatus;
  route?: ApiLiveRoute;
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
          ? "border-emerald-300/60 bg-emerald-50 text-emerald-700 dark:border-emerald-700/70 dark:bg-emerald-950/50 dark:text-emerald-300"
          : "border-amber-300/60 bg-amber-50 text-amber-700 dark:border-amber-700/70 dark:bg-amber-950/50 dark:text-amber-300",
      )}
    >
      <span className="rounded-full bg-black/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide dark:bg-white/10">
        {routeLabel}
      </span>
      <span>{label}</span>
    </div>
  );
}

function extractUsedCitationIndices(content: string, maxIndex: number) {
  const used = new Set<number>();
  const re = /\[(\d+)\]/g;
  for (const match of content.matchAll(re)) {
    const n = Number.parseInt(match[1] || "", 10);
    if (!Number.isFinite(n)) continue;
    if (n < 1 || n > maxIndex) continue;
    used.add(n);
  }
  return Array.from(used).sort((a, b) => a - b);
}

function CitationList({ citations, content }: { citations?: ApiCitation[]; content?: string }) {
  const [showAll, setShowAll] = useState(false);
  if (!citations || citations.length === 0) return null;

  const used = content ? extractUsedCitationIndices(content, citations.length) : [];
  const effectiveShowAll = used.length === 0 ? true : showAll;

  const displayed = effectiveShowAll
    ? citations.map((citation, index) => ({ citation, index: index + 1 }))
    : used.map((index) => ({ citation: citations[index - 1], index }));

  const usedCount = used.length > 0 ? used.length : citations.length;

  return (
    <details className="group mb-2 w-full min-w-0 max-w-full rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm">
      <summary className="block w-full cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Sources
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground/80">
              · {usedCount}/{citations.length}
            </span>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-180" />
        </div>
      </summary>

      <div className="mt-2 flex flex-col gap-1.5">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 pb-1">
          <p className="min-w-0 text-[11px] text-muted-foreground">
            {used.length === 0
              ? "本轮未在正文标注引用，展示全部来源。"
              : effectiveShowAll
                ? "展示全部来源。"
                : "仅展示已引用来源。"}
          </p>
          {used.length > 0 && (
            <button
              type="button"
              className="justify-self-end whitespace-nowrap rounded-md border border-border/50 bg-background/50 px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              onClick={() => setShowAll((prev) => !prev)}
            >
              {effectiveShowAll ? "Show used only" : "Show all"}
            </button>
          )}
        </div>

        {displayed.map(({ citation, index }) => (
          <a
            key={`${citation.url}-${index}`}
            href={normalizeExternalUrl(citation.url)}
            target="_blank"
            rel="noreferrer"
            className="block w-full min-w-0 max-w-full overflow-hidden rounded-md border border-border/40 bg-background/70 px-2 py-1.5 text-xs transition-colors hover:bg-background"
          >
            <div className="flex min-w-0 items-baseline gap-2">
              <CitationBadge index={index} className="shrink-0" />
              <div className="min-w-0 flex-1 break-words font-medium text-foreground">
                {citation.title}
              </div>
            </div>
            <div className="truncate text-muted-foreground">{citation.url}</div>
            {citation.snippet && (
              <div className="mt-0.5 line-clamp-2 text-muted-foreground">{citation.snippet}</div>
            )}
          </a>
        ))}
      </div>
    </details>
  );
}

function stripTrailingCitationAppendix(content: string, citations?: ApiCitation[]) {
  const normalized = (content || "").replace(/\r\n/g, "\n");
  if (!normalized.trim() || !citations || citations.length === 0) return normalized;

  const appendixMatch = normalized.match(
    /(?:^|\n)(?:引用|参考资料|参考来源|参考文献|References?|Sources?)[:：]?\s*\n[\s\S]*$/i,
  );
  if (!appendixMatch || appendixMatch.index == null) return normalized;

  const appendix = appendixMatch[0];
  const refMatches = appendix.match(/\[\d+\]/g) || [];
  if (refMatches.length === 0) return normalized;

  const sourceHits = citations.filter((citation) => {
    const title = citation.title?.trim();
    const url = citation.url?.trim();
    return (title && appendix.includes(title)) || (url && appendix.includes(url));
  }).length;

  if (sourceHits === 0) return normalized;

  return normalized.slice(0, appendixMatch.index).replace(/\s+$/, "");
}

function MessageBubble({
  msg,
  isStreaming,
  canEdit,
  canRetry,
  onEdit,
  onRetry,
  onDelete,
  attachments,
  assistantWidth,
  userMaxWidth,
}: {
  msg: {
    id: string;
    role: "user" | "assistant";
    content: string;
    mode: "chat" | "agent";
    agentRun?: ApiAgentRun;
    liveStatus?: ApiLiveStatus;
    liveRoute?: ApiLiveRoute;
    liveLabel?: string;
    citations?: ApiCitation[];
    streamTail?: string;
    streamPulseKey?: number;
  };
  isStreaming: boolean;
  canEdit: boolean;
  canRetry: boolean;
  onEdit: () => void;
  onRetry: () => void;
  onDelete: () => void;
  attachments?: MessageAttachmentItem[];
  assistantWidth: string;
  userMaxWidth: string;
}) {
  const [copied, setCopied] = useState(false);
  const displayContent =
    msg.role === "assistant"
      ? stripTrailingCitationAppendix(msg.content, msg.citations)
      : msg.content;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(displayContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isAssistant = msg.role === "assistant";
  const hasAssistantText = isAssistant && Boolean((displayContent || "").trim());
  const isAssistantPlaceholder = isAssistant && isStreaming && !hasAssistantText;
  const isAgent = msg.mode === "agent";
  const streamTailLength =
    isAssistant && isStreaming && hasAssistantText ? (msg.streamTail || "").length : 0;

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
          isAssistantPlaceholder ? "border-0 bg-transparent px-0 py-0" : "rounded-2xl px-4 py-2",
          isAssistant
            ? isAssistantPlaceholder
              ? ""
              : "border border-border/50 bg-background/60"
            : "border border-border/50 bg-foreground/[0.06]",
        )}
      >
        <div
          className={cn(
            "mb-1 inline-flex items-center gap-1 text-[11px] font-medium",
            isAssistant ? "text-muted-foreground" : "text-foreground/60",
          )}
        >
          {isAgent ? <Bot size={12} /> : <MessageSquare size={12} />}
          <span>{isAgent ? "Agent" : "Chat"}</span>
        </div>

        {!isAssistant && attachments && attachments.length > 0 && (
          <MessageAttachments attachments={attachments} />
        )}

        {isAssistant ? (
          <div className="min-w-0 max-w-full" style={WRAP_TEXT}>
            <LiveStatusBadge status={msg.liveStatus} route={msg.liveRoute} label={msg.liveLabel} />
            <CitationList citations={msg.citations} content={displayContent} />
            {hasAssistantText ? (
              isStreaming ? (
                <StreamingMarkdownMessage
                  content={displayContent}
                  tailLength={streamTailLength}
                  pulseKey={msg.streamPulseKey ?? 0}
                  citations={msg.citations}
                />
              ) : (
                <MarkdownMessage content={displayContent} citations={msg.citations} />
              )
            ) : isStreaming ? (
              <TypingIndicator className="ml-1" />
            ) : null}
          </div>
        ) : msg.content?.trim() ? (
          <p className="text-sm" style={WRAP_TEXT}>
            {msg.content}
          </p>
        ) : null}

        {isAssistant && <AgentRunPanel run={msg.agentRun} />}
      </div>
      <div
        className={cn(
          "mt-0.5 flex gap-0.5 transition-opacity duration-150",
          isAssistant ? "justify-start" : "justify-end",
          !isStreaming
            ? "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto"
            : "opacity-0 pointer-events-none",
        )}
      >
        {!isAssistant && canEdit && (
          <IconActionButton onClick={onEdit} title="编辑">
            <Pencil size={13} />
          </IconActionButton>
        )}
        <IconActionButton onClick={handleCopy} title={copied ? "已复制" : "复制"}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </IconActionButton>
        {isAssistant && (
          <IconActionButton onClick={onRetry} title="重新生成" disabled={!canRetry}>
            <RefreshCw size={13} />
          </IconActionButton>
        )}
        <IconActionButton onClick={onDelete} title="删除" danger>
          <Trash2 size={13} />
        </IconActionButton>
      </div>
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

export function ChatArea() {
  const {
    currentConversation,
    messages,
    isLoading,
    isStreaming,
    addMessage,
    appendMessageDelta,
    loadMessages,
    setIsLoading,
    setIsStreaming,
    channels,
    updateConversation,
    deleteMessage,
    composerMode,
    setComposerMode,
  } = useChatStore();

  const [input, setInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [placeholder, setPlaceholder] = useState(() => pickPlaceholder());
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const textSmootherRef = useRef<TextStreamSmoother | null>(null);
  const pendingPreviewUrlsRef = useRef<Map<string, string[]>>(new Map());
  const pendingScrollTargetRef = useRef<
    { type: "bottom" } | { type: "message"; id: string } | null
  >(null);
  const messageAnchorRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);

  const ASSISTANT_BUBBLE_WIDTH = "92%";
  const USER_BUBBLE_MAX_WIDTH = "72%";
  const groupedMessages = groupMessagesByRound(messages);

  useEffect(() => {
    pendingScrollTargetRef.current = { type: "bottom" };
  }, [currentConversation?.id]);

  useEffect(() => {
    const viewportEl = viewportRef.current;
    const pending = pendingScrollTargetRef.current;
    if (!viewportEl || !pending) return;

    const frame = requestAnimationFrame(() => {
      const next = pendingScrollTargetRef.current;
      if (!next || !viewportRef.current) return;

      if (next.type === "bottom") {
        viewportRef.current.scrollTo({ top: viewportRef.current.scrollHeight });
        pendingScrollTargetRef.current = null;
        return;
      }

      const anchorEl = messageAnchorRefs.current.get(next.id);
      if (!anchorEl) return;

      const top =
        anchorEl.getBoundingClientRect().top -
        viewportRef.current.getBoundingClientRect().top +
        viewportRef.current.scrollTop;
      viewportRef.current.scrollTo({ top });
      pendingScrollTargetRef.current = null;
    });

    return () => cancelAnimationFrame(frame);
  }, [messages, currentConversation?.id, editingMsgId]);

  useEffect(() => {
    setStreamingAssistantId(null);
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

  const getMessageContent = (id: string) => {
    return useChatStore.getState().messages.find((m) => m.id === id)?.content || "";
  };

  const updateMessageKeepContent = (id: string, updates: Partial<Message>) => {
    useChatStore.getState().updateMessage(id, getMessageContent(id), updates);
  };

  const createAbortController = () => {
    try {
      streamAbortRef.current?.abort();
    } catch {
      // ignore
    }
    const abortController = new AbortController();
    streamAbortRef.current = abortController;
    return abortController;
  };

  const clearStreamInternals = () => {
    textSmootherRef.current?.cancel({ flush: true });
    textSmootherRef.current = null;
    streamAbortRef.current = null;
  };

  const resetAssistantMessageForStream = (assistantMessageId: string, agentRun?: ApiAgentRun) => {
    useChatStore.getState().updateMessage(assistantMessageId, "", {
      streamTail: undefined,
      streamPulseKey: 0,
      liveStatus: undefined,
      liveRoute: undefined,
      liveLabel: undefined,
      citations: undefined,
      ...(agentRun ? { agentRun } : {}),
    });
  };

  const didAbortStream = (error?: unknown) => {
    if (streamAbortRef.current?.signal?.aborted) return true;
    return error ? isAbortError(error) : false;
  };

  const toErrorMessage = (error: unknown, fallback: string) => {
    return error instanceof Error ? error.message : fallback;
  };

  const getEditableUserMessageAt = (index: number) => {
    const userMsg = messages[index];
    if (!userMsg || userMsg.role !== "user") return null;
    if (userMsg.id.startsWith("temp-")) return null;

    const assistantMsg = messages[index + 1];
    if (!assistantMsg) {
      return { userMsg, assistantMsg: null };
    }
    if (assistantMsg.role !== "assistant") return null;
    if (assistantMsg.mode !== userMsg.mode) return null;
    if (assistantMsg.id.startsWith("temp-")) return null;

    return { userMsg, assistantMsg };
  };

  const canEditUserMessageAt = (index: number) => {
    return Boolean(getEditableUserMessageAt(index));
  };

  const streamAssistantResponse = async ({
    input,
    response,
    assistantMessageId,
    isAgent,
    agentRunRef,
    smoother,
    onAfterDone,
  }: {
    input: {
      conversationId: string;
      content: string;
      attachments?: string[];
      mode?: "chat" | "agent";
    };
    response: Response;
    assistantMessageId: string;
    isAgent: boolean;
    agentRunRef: { current: ApiAgentRun | undefined };
    smoother: TextStreamSmoother;
    onAfterDone?: () => void | Promise<void>;
  }) => {
    let postStream: Promise<void> | null = null;

    const patch = (updates: Partial<Message>) => {
      updateMessageKeepContent(
        assistantMessageId,
        isAgent ? { ...updates, agentRun: agentRunRef.current } : updates,
      );
    };

    await streamChatMessage(
      input,
      {
        onLiveStatus: (event) => {
          patch({
            liveStatus: event.status,
            liveRoute: event.route,
            liveLabel: event.label,
          });
        },
        onCitations: (event) => {
          patch({ citations: event.citations });
        },
        onDelta: (chunk) => {
          if (!chunk) return;
          smoother.push(chunk);
        },
        onAgentEvent: (event) => {
          if (!isAgent) return;
          agentRunRef.current = applyAgentEventToRun(
            agentRunRef.current,
            event as AgentStreamEvent,
          );
          patch({ agentRun: agentRunRef.current });
        },
        onDone: (event) => {
          postStream = (async () => {
            if (isAgent && event.agentRun) {
              agentRunRef.current = event.agentRun;
              patch({ agentRun: agentRunRef.current });
            }
            await smoother.finish();
            await loadMessages(input.conversationId);
            await onAfterDone?.();
          })();
        },
        onError: (message) => {
          postStream = (async () => {
            smoother.cancel({ flush: true });
            const next = isAgent ? createFailedAgentRun(agentRunRef.current, message) : undefined;
            if (isAgent) agentRunRef.current = next;
            useChatStore
              .getState()
              .updateMessage(
                assistantMessageId,
                `Error: ${message}`,
                isAgent ? { agentRun: next } : undefined,
              );
          })();
        },
      },
      response,
    );

    if (postStream) {
      await postStream;
      return;
    }

    await smoother.finish();
    await loadMessages(input.conversationId);
    await onAfterDone?.();
  };

  const effective = getEffectiveModelForConversation(channels, currentConversation);
  const agentModeSupported = effective.ok && effective.provider === "anthropic";
  const agentModeDisabledReason = effective.ok
    ? "Agent 模式目前仅支持 Anthropic 渠道，请先切换到 Anthropic 模型。"
    : "请先配置可用模型后再使用 Agent 模式。";
  const hasInput = Boolean(input.trim());
  const hasFiles = files.length > 0;
  const forceWebSearch = currentConversation?.forceWebSearch ?? true;
  const canSend =
    effective.ok &&
    Boolean(currentConversation) &&
    !isLoading &&
    !isStreaming &&
    !isUploading &&
    (hasInput || hasFiles);

  const handleToggleWebSearch = async () => {
    if (!currentConversation) return;
    const next = !forceWebSearch;
    updateConversation(currentConversation.id, { forceWebSearch: next });
    if (next) {
      try {
        const status = await api.settings.searchStatus();
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
        // ignore
      }
    }
    try {
      await api.conversations.update(currentConversation.id, { forceWebSearch: next });
    } catch {
      updateConversation(currentConversation.id, { forceWebSearch });
    }
  };

  const handleStop = async () => {
    try {
      streamAbortRef.current?.abort();
    } catch {
      // ignore
    }
    clearStreamInternals();
    setIsLoading(false);
    setIsStreaming(false);
    setStreamingAssistantId(null);
    if (currentConversation) {
      try {
        await loadMessages(currentConversation.id);
      } catch {
        // ignore
      }
    }
    queueMicrotask(() => inputRef.current?.focus());
  };

  const handleInputFocus = () => {
    if (!input.trim()) {
      setPlaceholder((prev) => pickPlaceholder(prev));
    }
  };

  const handleSend = async () => {
    if (!canSend || !currentConversation) return;

    if (composerMode === "agent" && !agentModeSupported) {
      notifyWarning("Agent 当前不可用", agentModeDisabledReason);
      return;
    }

    const conversationId = currentConversation.id;
    const mode = composerMode;

    const trimmed = input.trim();
    const effectiveContent = trimmed.length > 0 ? trimmed : "";
    const autoTitleSeed =
      trimmed.length > 0
        ? trimmed
        : files.length > 0
          ? `Attachments: ${files.map((file) => file.name).join(", ")}`
          : "";

    const previewUrls: string[] = [];
    const localAttachmentMeta: MessageAttachmentItem[] = files.map((file) => {
      const previewUrl = file.type?.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (previewUrl) previewUrls.push(previewUrl);
      return {
        fileName: file.name,
        fileType: file.type || undefined,
        fileSize: file.size,
        previewUrl,
      };
    });

    const userMessageId = `temp-${Date.now()}`;
    if (previewUrls.length > 0) {
      pendingPreviewUrlsRef.current.set(userMessageId, previewUrls);
    }

    addMessage({
      id: userMessageId,
      conversationId,
      role: "user",
      content: effectiveContent,
      mode,
      attachmentsMeta: localAttachmentMeta.length > 0 ? localAttachmentMeta : undefined,
      createdAt: new Date(),
    });

    const assistantMessageId = `temp-assistant-${Date.now()}`;
    const isAgent = mode === "agent";
    const agentRunRef = { current: isAgent ? createPartialAgentRun() : undefined };

    addMessage({
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      content: "",
      mode,
      agentRun: agentRunRef.current,
      createdAt: new Date(),
    });

    pendingScrollTargetRef.current = { type: "message", id: userMessageId };
    setInput("");
    queueMicrotask(() => inputRef.current?.focus());
    setIsLoading(true);
    setIsStreaming(true);
    setStreamingAssistantId(assistantMessageId);

    try {
      const abortController = createAbortController();
      const smoother = createTextStreamSmoother({
        emit: (delta) => {
          appendMessageDelta(
            assistantMessageId,
            delta,
            isAgent ? { agentRun: agentRunRef.current } : undefined,
          );
        },
      });
      textSmootherRef.current = smoother;

      let attachmentIds: string[] = [];
      if (files.length > 0) {
        setIsUploading(true);
        const upload = await uploadAttachments({ conversationId, files });
        attachmentIds = upload.attachments.map((attachment) => attachment.id);
        updateMessageKeepContent(userMessageId, {
          attachments: attachmentIds,
          attachmentsMeta: localAttachmentMeta.map((local, idx) => {
            const server = upload.attachments[idx];
            return {
              ...local,
              id: server?.id ?? local.id,
              fileName: server?.fileName ?? local.fileName,
              fileType: server?.fileType ?? local.fileType,
              fileSize: server?.fileSize ?? local.fileSize,
            };
          }),
        });
        setFiles([]);
      }

      const payload = {
        conversationId,
        content: effectiveContent,
        attachments: attachmentIds,
        mode,
      };

      const response = await api.messages.stream(payload, { signal: abortController.signal });

      await streamAssistantResponse({
        input: payload,
        response,
        assistantMessageId,
        isAgent,
        agentRunRef,
        smoother,
        onAfterDone: () => {
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
          const conv = useChatStore.getState().currentConversation;
          if (conv && /^新会话 \d{2}-\d{2} \d{2}:\d{2}$/.test(conv.title)) {
            if (!autoTitleSeed) return;
            void api.conversations
              .autoTitle(conversationId, autoTitleSeed)
              .then((result) => {
                if (result.success && result.title) {
                  updateConversation(conversationId, { title: result.title });
                }
              })
              .catch(() => {});
          }
        },
      });
    } catch (error) {
      if (didAbortStream(error)) {
        return;
      }
      useChatStore.getState().updateMessage(
        assistantMessageId,
        `Error: ${toErrorMessage(error, "Failed to send message")}`,
        isAgent
          ? {
              agentRun: createFailedAgentRun(
                agentRunRef.current,
                toErrorMessage(error, "Failed to send message"),
              ),
            }
          : undefined,
      );
    } finally {
      setIsUploading(false);
      setIsLoading(false);
      setIsStreaming(false);
      setStreamingAssistantId(null);
      clearStreamInternals();
      queueMicrotask(() => inputRef.current?.focus());
    }
  };

  const handleRetry = async (msgIndex: number) => {
    if (!currentConversation) return;
    const assistantMsg = messages[msgIndex];
    if (!assistantMsg || assistantMsg.role !== "assistant") return;
    const precedingUserMsg = (() => {
      for (let i = msgIndex - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m?.role === "user") return m;
      }
      return null;
    })();

    const isAgent = assistantMsg.mode === "agent";
    const agentRunRef = { current: isAgent ? createPartialAgentRun() : undefined };
    if (precedingUserMsg) {
      pendingScrollTargetRef.current = { type: "message", id: precedingUserMsg.id };
    }
    resetAssistantMessageForStream(assistantMsg.id, agentRunRef.current);
    setIsLoading(true);
    setIsStreaming(true);
    setStreamingAssistantId(assistantMsg.id);

    try {
      const abortController = createAbortController();
      const smoother = createTextStreamSmoother({
        emit: (delta) => {
          appendMessageDelta(
            assistantMsg.id,
            delta,
            isAgent ? { agentRun: agentRunRef.current } : undefined,
          );
        },
      });
      textSmootherRef.current = smoother;

      if (assistantMsg.id.startsWith("temp-")) {
        if (!precedingUserMsg) return;

        const attachmentIds = Array.isArray(precedingUserMsg.attachments)
          ? precedingUserMsg.attachments.filter(
              (id) => typeof id === "string" && id.trim().length > 0,
            )
          : (precedingUserMsg.attachmentsMeta || [])
              .map((att) => (typeof att.id === "string" ? att.id : ""))
              .filter((id) => id.trim().length > 0);

        const payload = {
          conversationId: currentConversation.id,
          content: typeof precedingUserMsg.content === "string" ? precedingUserMsg.content : "",
          attachments: attachmentIds.length > 0 ? attachmentIds : undefined,
          mode: assistantMsg.mode,
        } as const;

        const response = await api.messages.stream(payload, { signal: abortController.signal });
        await streamAssistantResponse({
          input: payload,
          response,
          assistantMessageId: assistantMsg.id,
          isAgent,
          agentRunRef,
          smoother,
        });
      } else {
        const response = await api.messages.regenerate(
          assistantMsg.id,
          precedingUserMsg && !precedingUserMsg.id.startsWith("temp-")
            ? {
                userMessageId: precedingUserMsg.id,
                userContent:
                  typeof precedingUserMsg.content === "string" ? precedingUserMsg.content : "",
              }
            : undefined,
          {
            signal: abortController.signal,
          },
        );
        if (!response.ok) throw new Error(await response.text().catch(() => "Failed"));

        await streamAssistantResponse({
          input: { conversationId: currentConversation.id, content: "", mode: assistantMsg.mode },
          response,
          assistantMessageId: assistantMsg.id,
          isAgent,
          agentRunRef,
          smoother,
        });
      }
    } catch (error) {
      if (didAbortStream(error)) {
        return;
      }
      useChatStore.getState().updateMessage(
        assistantMsg.id,
        `Error: ${toErrorMessage(error, "Failed to regenerate")}`,
        isAgent
          ? {
              agentRun: createFailedAgentRun(
                agentRunRef.current,
                toErrorMessage(error, "Failed to regenerate"),
              ),
            }
          : undefined,
      );
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
      setStreamingAssistantId(null);
      clearStreamInternals();
    }
  };

  const handleEditSubmit = async (msgId: string, newContent: string) => {
    if (!currentConversation || !newContent.trim()) return;
    const msgIndex = messages.findIndex((message) => message.id === msgId);
    if (msgIndex < 0) return;
    const editable = getEditableUserMessageAt(msgIndex);
    if (!editable) {
      notifyWarning("当前消息不可编辑", "这条用户消息后面没有对应的助手回复，无法重新编辑并生成。");
      setEditingMsgId(null);
      return;
    }

    const { userMsg, assistantMsg: existingAssistantMsg } = editable;
    const conversationId = currentConversation.id;
    const isAgent = userMsg.mode === "agent";
    const agentRunRef = { current: isAgent ? createPartialAgentRun() : undefined };
    const assistantMessageId = existingAssistantMsg?.id ?? `temp-assistant-edit-${Date.now()}`;

    setEditingMsgId(null);
    pendingScrollTargetRef.current = { type: "message", id: msgId };
    useChatStore.getState().updateMessage(msgId, newContent.trim());
    if (existingAssistantMsg) {
      resetAssistantMessageForStream(assistantMessageId, agentRunRef.current);
    } else {
      addMessage({
        id: assistantMessageId,
        conversationId,
        role: "assistant",
        content: "",
        mode: userMsg.mode,
        agentRun: agentRunRef.current,
        createdAt: new Date(),
      });
    }
    setIsLoading(true);
    setIsStreaming(true);
    setStreamingAssistantId(assistantMessageId);

    try {
      const abortController = createAbortController();
      const smoother = createTextStreamSmoother({
        emit: (delta) => {
          appendMessageDelta(
            assistantMessageId,
            delta,
            isAgent ? { agentRun: agentRunRef.current } : undefined,
          );
        },
      });
      textSmootherRef.current = smoother;

      const response = await api.messages.edit(msgId, newContent.trim(), {
        signal: abortController.signal,
      });
      if (!response.ok) throw new Error(await response.text().catch(() => "Failed"));

      await streamAssistantResponse({
        input: { conversationId, content: newContent.trim(), mode: userMsg.mode },
        response,
        assistantMessageId,
        isAgent,
        agentRunRef,
        smoother,
      });
    } catch (error) {
      if (didAbortStream(error)) {
        return;
      }
      const message = toErrorMessage(error, "Failed to edit message");
      useChatStore
        .getState()
        .updateMessage(
          assistantMessageId,
          `Error: ${message}`,
          isAgent ? { agentRun: createFailedAgentRun(agentRunRef.current, message) } : undefined,
        );
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
      setStreamingAssistantId(null);
      clearStreamInternals();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
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

  if (!currentConversation) {
    return (
      <div className="flex flex-1 flex-col">
        <div style={{ padding: PAGE_PAD, paddingBottom: "8px" }}>
          <ChatHeader />
        </div>
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">在左侧选择一个会话，或创建新会话开始交流</p>
        </div>
      </div>
    );
  }

  const renderMessageRow = (msg: Message, index: number) => (
    <div
      ref={(node) => {
        if (msg.role !== "user") return;
        if (node) {
          messageAnchorRefs.current.set(msg.id, node);
          return;
        }
        messageAnchorRefs.current.delete(msg.id);
      }}
      className={cn(
        "flex min-w-0 flex-col",
        msg.role === "assistant" ? "items-start" : "items-end",
      )}
    >
      <MessageBubble
        msg={{
          id: msg.id,
          role: msg.role,
          content: msg.content,
          mode: msg.mode,
          agentRun: msg.agentRun,
          liveStatus: msg.liveStatus,
          liveRoute: msg.liveRoute,
          liveLabel: msg.liveLabel,
          citations: msg.citations,
          streamTail: msg.streamTail,
          streamPulseKey: msg.streamPulseKey,
        }}
        isStreaming={Boolean(
          isStreaming && streamingAssistantId && msg.id === streamingAssistantId,
        )}
        canEdit={canEditUserMessageAt(index)}
        canRetry={msg.role === "assistant" && !isLoading && !isStreaming && !isUploading}
        attachments={
          msg.role === "user" && msg.attachmentsMeta
            ? msg.attachmentsMeta.map((att) => ({
                id: att.id,
                fileName: att.fileName,
                fileType: att.fileType,
                fileSize: att.fileSize,
                previewUrl: att.previewUrl,
              }))
            : undefined
        }
        onEdit={() => {
          if (msg.role !== "user") return;
          if (!canEditUserMessageAt(index)) {
            notifyWarning(
              "当前消息不可编辑",
              "这条用户消息后面没有对应的助手回复，无法重新编辑并生成。",
            );
            return;
          }
          setEditingMsgId(msg.id);
          setEditingContent(msg.content || "");
        }}
        onRetry={() => void handleRetry(index)}
        onDelete={() => void deleteMessage(msg.id)}
        assistantWidth={ASSISTANT_BUBBLE_WIDTH}
        userMaxWidth={USER_BUBBLE_MAX_WIDTH}
      />

      {editingMsgId === msg.id && (
        <div className="flex w-full max-w-[72%] self-end flex-col items-end gap-1">
          <Textarea
            value={editingContent}
            onChange={(event) => setEditingContent(event.currentTarget.value)}
            className="w-full"
            rows={3}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleEditSubmit(msg.id, editingContent);
              }
              if (event.key === "Escape") setEditingMsgId(null);
            }}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditingMsgId(null)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => void handleEditSubmit(msg.id, editingContent)}
              disabled={!editingContent.trim()}
            >
              确认
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden">
      <div style={{ padding: PAGE_PAD, paddingBottom: "8px" }}>
        <ChatHeader />
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
                {group.assistant
                  ? renderMessageRow(group.assistant.msg, group.assistant.index)
                  : null}
              </div>
            ))}

            {messages.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">开始新一轮消息...</p>
            )}
          </div>
        </div>
      </div>

      {!effective.ok && (
        <div style={{ paddingLeft: PAGE_PAD, paddingRight: PAGE_PAD }}>
          {effective.scope === "conversation" ? (
            <div className="mb-2 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm shadow-minimal dark:border-orange-800 dark:bg-orange-950">
              <p className="font-medium text-orange-800 dark:text-orange-200">当前会话模型不可用</p>
              <p className="text-orange-700 dark:text-orange-300">{effective.reason}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                在下方输入框的 Model 里修复即可。
              </p>
            </div>
          ) : (
            <div className="mb-2 flex items-center gap-3 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm shadow-minimal dark:border-orange-800 dark:bg-orange-950">
              <p className="flex-1 text-orange-700 dark:text-orange-300">{effective.reason}</p>
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
        <PromaComposer
          value={input}
          onChange={setInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isUploading}
          attachments={files}
          onAddAttachments={(list) => setFiles((prev) => [...prev, ...list])}
          onRemoveAttachment={(file) => setFiles((prev) => prev.filter((item) => item !== file))}
          mode={composerMode}
          onModeChange={(nextMode) => {
            if (nextMode === "agent" && !agentModeSupported) {
              notifyWarning("Agent 当前不可用", agentModeDisabledReason);
              return;
            }
            setComposerMode(nextMode);
          }}
          agentModeAvailable={agentModeSupported}
          agentModeDisabledReason={agentModeDisabledReason}
          modelProvider={effective.ok ? effective.provider : null}
          modelLabel={
            effective.ok
              ? effective.modelDisplayName
              : effective.scope === "conversation"
                ? "Fix model"
                : "Select model"
          }
          modelTone={effective.ok ? "normal" : "warning"}
          onOpenModelPicker={() => setModelPickerOpen(true)}
          forceWebSearch={forceWebSearch}
          onToggleWebSearch={() => void handleToggleWebSearch()}
          onInputFocus={handleInputFocus}
          streaming={isStreaming}
          canSubmit={canSend}
          onSubmit={() => void handleSend()}
          onStop={() => void handleStop()}
          inputRef={inputRef}
        />
      </div>

      {currentConversation && modelPickerOpen && (
        <ModelPickerModal
          opened={modelPickerOpen}
          onClose={() => setModelPickerOpen(false)}
          conversationId={currentConversation.id}
          conversationFixReason={
            !effective.ok && effective.scope === "conversation" ? effective.reason : null
          }
          current={
            currentConversation.channelId && currentConversation.modelId
              ? { channelId: currentConversation.channelId, modelId: currentConversation.modelId }
              : effective.ok
                ? { channelId: effective.channelId, modelId: effective.modelId }
                : null
          }
        />
      )}
    </div>
  );
}
