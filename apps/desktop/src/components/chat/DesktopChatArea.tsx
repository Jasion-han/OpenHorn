import { Bot, Check, Copy, MessageSquare, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Badge, Button, ScrollArea, Textarea, cn } from "ui";
import { sanitizeDisplayContent } from "../../lib/citations";
import { readErrorMessage } from "../../lib/serverApi";
import { readSseStream } from "../../lib/sse";
import { useChatStore } from "../../stores/chatStore";
import type { ApiAgentRun, Message } from "../../types/chat";
import { DesktopCitationList } from "./DesktopCitationList";
import { DesktopChatHeader } from "./DesktopChatHeader";
import { DesktopComposer } from "./DesktopComposer";
import { DesktopMarkdownMessage } from "./DesktopMarkdownMessage";
import { DesktopMessageAttachments } from "./DesktopMessageAttachments";

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

function AgentRunPanel({ run }: { run?: ApiAgentRun }) {
  if (!run) return null;
  const toolCount = run.steps.filter((step) => step.type === "tool_start").length;
  const shouldRender = Boolean(run.error) || toolCount > 0;
  if (!shouldRender) return null;

  const statusLabel = (() => {
    switch (run.status) {
      case "completed":
        return "已完成";
      case "failed":
        return "失败";
      case "cancelled":
        return "已取消";
      default:
        return "进行中";
    }
  })();

  return (
    <details className="mt-3 rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Bot size={12} className="shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{`执行记录 · ${toolCount} 个工具`}</span>
          </div>
          <Badge variant={run.status === "failed" ? "destructive" : "outline"}>{statusLabel}</Badge>
        </div>
      </summary>

      <div className="mt-2 flex flex-col gap-2">
        {run.error && (
          <div className="rounded-md border border-orange-200 bg-orange-50 px-2 py-1.5 text-xs text-orange-700">
            {run.error}
          </div>
        )}
        {run.steps.map((step, index) => (
          <div
            key={`${index}-${step.type}-${step.toolName || ""}`}
            className="rounded-md border border-border/50 bg-background/60 px-2 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">{step.type}</p>
              {step.toolName && <p className="text-xs text-muted-foreground">{step.toolName}</p>}
            </div>
            {step.content && <p className="mt-1 text-sm whitespace-pre-wrap">{step.content}</p>}
            {step.toolInput !== undefined && (
              <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-xs">
                {JSON.stringify(step.toolInput, null, 2)}
              </pre>
            )}
          </div>
        ))}
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
  canEdit,
  canRetry,
  canDelete,
  isStreaming,
  onEdit,
  onRetry,
  onDelete,
}: {
  message: Message;
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
    await navigator.clipboard.writeText(message.content || "");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        "mt-1 flex gap-1 transition-opacity duration-150",
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

export function DesktopChatArea() {
  const ASSISTANT_BUBBLE_WIDTH = "92%";
  const USER_BUBBLE_MAX_WIDTH = "72%";
  const currentConversation = useChatStore((state) => state.currentConversation);
  const messages = useChatStore((state) => state.messages);
  const isLoading = useChatStore((state) => state.isLoading);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const applyStreamEvent = useChatStore((state) => state.applyStreamEvent);
  const loadMessages = useChatStore((state) => state.loadMessages);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const deleteMessage = useChatStore((state) => state.deleteMessage);
  const regenerateMessage = useChatStore((state) => state.regenerateMessage);
  const setStreaming = useChatStore((state) => state.setStreaming);
  const setError = useChatStore((state) => state.setError);
  const editUserMessage = useChatStore((state) => state.editUserMessage);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");

  const getEditableAssistantForUser = (messageId: string) => {
    const messageIndex = messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) return null;

    const userMessage = messages[messageIndex];
    const assistantMessage = messages[messageIndex + 1];
    if (!userMessage || userMessage.role !== "user" || userMessage.id.startsWith("draft-")) {
      return null;
    }
    if (
      !assistantMessage ||
      assistantMessage.role !== "assistant" ||
      assistantMessage.mode !== userMessage.mode ||
      assistantMessage.id.startsWith("draft-")
    ) {
      return null;
    }

    return { userMessage, assistantMessage };
  };

  const handleSubmit = async (content: string) => {
    if (!currentConversation) return;

    const { assistantMessageId, response } = await sendMessage({ content });

    try {
      await readSseStream(response, (event) => {
        applyStreamEvent(assistantMessageId, event);
      });

      setStreaming(false);
      await Promise.all([loadMessages(currentConversation.id), loadConversations()]);
    } catch (error) {
      setStreaming(false);
      if (isAbortError(error)) {
        return;
      }
      setError(error instanceof Error ? error.message : "Stream error");
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

    setStreaming(true);
    setError(null);
    useChatStore.getState().updateMessage(messageId, {
      content: "",
      citations: undefined,
      liveStatus: undefined,
      liveRoute: undefined,
      liveLabel: undefined,
      agentRun:
        assistantMessage.mode === "agent"
          ? {
              status: "partial",
              summary: "Agent 正在执行",
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

      await readSseStream(response, (event) => {
        applyStreamEvent(messageId, event);
      });

      setStreaming(false);
      await Promise.all([loadMessages(currentConversation.id), loadConversations()]);
    } catch (error) {
      setStreaming(false);
      if (isAbortError(error)) {
        return;
      }
      setError(error instanceof Error ? error.message : "Retry message failed");
      useChatStore.getState().failStreamingMessage(
        messageId,
        error instanceof Error ? error.message : "Retry message failed",
      );
    }
  };

  const handleStartEdit = (message: Message) => {
    const editable = getEditableAssistantForUser(message.id);
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

    const editable = getEditableAssistantForUser(messageId);
    if (!editable) {
      handleCancelEdit();
      return;
    }

    const { userMessage, assistantMessage } = editable;
    handleCancelEdit();
    setStreaming(true);
    setError(null);
    useChatStore.getState().updateMessage(userMessage.id, { content: nextContent });
    useChatStore.getState().updateMessage(assistantMessage.id, {
      content: "",
      citations: undefined,
      liveStatus: undefined,
      liveRoute: undefined,
      liveLabel: undefined,
      agentRun:
        assistantMessage.mode === "agent"
          ? {
              status: "partial",
              summary: "Agent 正在执行",
              steps: [],
            }
          : undefined,
    });

    try {
      const response = await editUserMessage(userMessage.id, nextContent);
      await readSseStream(response, (event) => {
        applyStreamEvent(assistantMessage.id, event);
      });

      setStreaming(false);
      await Promise.all([loadMessages(currentConversation.id), loadConversations()]);
    } catch (error) {
      setStreaming(false);
      if (isAbortError(error)) {
        return;
      }
      setError(error instanceof Error ? error.message : "Edit message failed");
      useChatStore.getState().failStreamingMessage(
        assistantMessage.id,
        error instanceof Error ? error.message : "Edit message failed",
      );
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DesktopChatHeader conversation={currentConversation} />

      <div className="min-h-0 flex-1">
        {!currentConversation ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="text-sm text-muted-foreground">在左侧选择一个会话，或创建新会话开始交流</p>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="flex min-h-full flex-col gap-2 px-4 py-4">

              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "group flex min-w-0 flex-col",
                    message.role === "assistant" ? "w-full items-start self-start" : "items-end self-end",
                  )}
                  style={{
                    maxWidth:
                      message.role === "assistant" ? ASSISTANT_BUBBLE_WIDTH : USER_BUBBLE_MAX_WIDTH,
                  }}
                >
                  {(() => {
                    const isAssistant = message.role === "assistant";
                    const label = message.mode === "agent" ? "Agent" : "Chat";
                    const badgeIcon =
                      message.mode === "agent" ? <Bot size={12} /> : <MessageSquare size={12} />;
                    const displayContent = isAssistant
                      ? sanitizeDisplayContent(message.content, message.citations)
                      : message.content;
                    const hasAssistantText = isAssistant && Boolean((displayContent || "").trim());
                    const isAssistantPlaceholder = isAssistant && isStreaming && !hasAssistantText;

                    return (
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
                      {badgeIcon}
                      <span>{label}</span>
                    </div>

                    {!isAssistant && message.attachmentsMeta && message.attachmentsMeta.length > 0 && (
                      <DesktopMessageAttachments attachments={message.attachmentsMeta} />
                    )}

                    {message.role === "assistant" && message.agentRun && <AgentRunPanel run={message.agentRun} />}

                    {isAssistant ? (
                      <div className={cn("min-w-0 max-w-full", message.agentRun && "mt-3")}>
                      <LiveStatusBadge
                        status={message.liveStatus}
                        route={message.liveRoute}
                        label={message.liveLabel}
                      />
                        <div
                          className="text-sm leading-6"
                          style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", maxWidth: "100%" }}
                        >
                          {hasAssistantText ? (
                            <DesktopMarkdownMessage content={displayContent} />
                          ) : isStreaming ? (
                            <TypingIndicator />
                          ) : null}
                        </div>
                        <DesktopCitationList citations={message.citations} content={displayContent} />
                      </div>
                    ) : (
                      <div className="text-sm leading-6">
                        {editingMessageId === message.id ? (
                        <div className="space-y-3">
                          <Textarea
                            value={editingContent}
                            onChange={(event) => setEditingContent(event.target.value)}
                            onKeyDown={(event) => {
                              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                                event.preventDefault();
                                void handleSaveEdit(message.id);
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                handleCancelEdit();
                              }
                            }}
                            className="min-h-[120px] resize-none bg-background text-foreground"
                            autoFocus
                          />
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={handleCancelEdit}
                            >
                              取消
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void handleSaveEdit(message.id)}
                              disabled={!editingContent.trim() || isStreaming}
                            >
                              保存并重新生成
                            </Button>
                          </div>
                        </div>
                        ) : message.content?.trim() ? (
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
                        ) : null}
                      </div>
                    )}
                  </div>
                    );
                  })()}
                  <MessageActionBar
                    message={message}
                    canEdit={message.role === "user" && Boolean(getEditableAssistantForUser(message.id))}
                    canRetry={
                      message.role === "assistant" &&
                      !message.id.startsWith("draft-") &&
                      Boolean(currentConversation)
                    }
                    canDelete={!message.id.startsWith("draft-")}
                    isStreaming={isStreaming || editingMessageId === message.id}
                    onEdit={() => handleStartEdit(message)}
                    onRetry={() => void handleRetryMessage(message.id)}
                    onDelete={() => void handleDeleteMessage(message.id)}
                  />
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      <DesktopComposer disabled={!currentConversation} onSubmit={handleSubmit} />
    </div>
  );
}
