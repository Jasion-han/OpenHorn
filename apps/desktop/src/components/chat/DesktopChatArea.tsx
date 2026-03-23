import { Bot, MessageSquare } from "lucide-react";
import { Badge, ScrollArea, cn } from "ui";
import { readSseStream } from "../../lib/sse";
import { useChatStore } from "../../stores/chatStore";
import type { ApiAgentRun, Message } from "../../types/chat";
import { DesktopChatHeader } from "./DesktopChatHeader";
import { DesktopComposer } from "./DesktopComposer";

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

function CitationPanel({
  citations,
}: {
  citations: NonNullable<Message["citations"]>;
}) {
  if (citations.length === 0) return null;

  return (
    <details className="mt-3 rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Sources
            </span>
            <span className="text-[11px] text-muted-foreground/80">{citations.length}</span>
          </div>
          <Badge variant="outline">引用来源</Badge>
        </div>
      </summary>

      <div className="mt-2 flex flex-col gap-2">
        {citations.map((citation, index) => (
          <a
            key={`${citation.url}-${index + 1}`}
            href={citation.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-md border border-border/40 bg-background/70 px-3 py-2 text-xs transition-colors hover:bg-background"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border/60 px-1.5 text-[10px] font-semibold text-muted-foreground">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {citation.title || citation.url}
              </span>
            </div>
            <div className="mt-1 truncate text-muted-foreground">{citation.url}</div>
            {citation.snippet && (
              <div className="mt-1 line-clamp-2 text-muted-foreground">{citation.snippet}</div>
            )}
          </a>
        ))}
      </div>
    </details>
  );
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function DesktopChatArea() {
  const currentConversation = useChatStore((state) => state.currentConversation);
  const messages = useChatStore((state) => state.messages);
  const isLoading = useChatStore((state) => state.isLoading);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const applyStreamEvent = useChatStore((state) => state.applyStreamEvent);
  const loadMessages = useChatStore((state) => state.loadMessages);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const setStreaming = useChatStore((state) => state.setStreaming);
  const setError = useChatStore((state) => state.setError);

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DesktopChatHeader conversation={currentConversation} />

      <div className="min-h-0 flex-1">
        {!currentConversation ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-md rounded-[28px] border border-border/60 bg-background/70 px-6 py-8 text-center shadow-sm">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <MessageSquare size={20} />
              </div>
              <div className="mt-4 text-lg font-semibold">开始一个新对话</div>
              <p className="mt-2 text-sm text-muted-foreground">
                在左侧选择历史会话，或新建一个会话后直接开始输入。
              </p>
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="flex min-h-full flex-col gap-3 px-4 py-4">
              {messages.length === 0 && !isLoading && (
                <div className="rounded-2xl border border-dashed border-border/60 px-4 py-8 text-center text-sm text-muted-foreground">
                  这个会话还没有消息，直接在下方输入即可。
                </div>
              )}

              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "max-w-[88%] rounded-[24px] border px-4 py-3 shadow-sm",
                    message.role === "user"
                      ? "ml-auto border-foreground/10 bg-foreground text-background"
                      : "border-border/60 bg-background/85 text-foreground",
                  )}
                >
                  <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] opacity-70">
                    {message.role === "assistant" ? <Bot size={12} /> : <MessageSquare size={12} />}
                    <span>{message.role === "assistant" ? "Assistant" : "User"}</span>
                  </div>
                  {message.role === "assistant" && (
                    <LiveStatusBadge
                      status={message.liveStatus}
                      route={message.liveRoute}
                      label={message.liveLabel}
                    />
                  )}
                  <div className="whitespace-pre-wrap break-words text-sm leading-6">
                    {message.content ? (
                      message.content
                    ) : message.role === "assistant" ? (
                      <TypingIndicator />
                    ) : (
                      ""
                    )}
                  </div>
                  {message.citations && message.citations.length > 0 && (
                    <CitationPanel citations={message.citations} />
                  )}
                  {message.role === "assistant" && <AgentRunPanel run={message.agentRun} />}
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
