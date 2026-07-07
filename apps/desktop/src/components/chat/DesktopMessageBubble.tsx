import { Bot, MessageSquare } from "lucide-react";
import { memo } from "react";
import { cn } from "ui";
import { sanitizeDisplayContent } from "../../lib/citations";
import { findKnownSlashToken, type SlashCommandType } from "../../lib/slashToken";
import type { Message } from "../../types/chat";
import { AgentRunPanel } from "./DesktopAgentRunPanel";
import { DesktopAgentTaskMetaLine } from "./DesktopAgentTaskMetaLine";
import { DesktopCitationList } from "./DesktopCitationList";
import { SLASH_ICONS } from "./DesktopComposer";
import { LiveStatusBadge } from "./DesktopLiveStatusBadge";
import { DesktopMarkdownMessage } from "./DesktopMarkdownMessage";
import { MessageActionBar } from "./DesktopMessageActionBar";
import { DesktopMessageAttachments } from "./DesktopMessageAttachments";
import { DesktopStreamingMarkdownMessage } from "./DesktopStreamingMarkdownMessage";
import { TypingIndicator } from "./DesktopTypingIndicator";

function MessageBubbleImpl({
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
  knownCommands,
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
  knownCommands?: Map<string, SlashCommandType>;
}) {
  const isAssistant = message.role === "assistant";
  const isMessageStreaming = isStreaming;
  const label = message.mode === "agent" ? "Agent" : "Chat";
  const badgeIcon = message.mode === "agent" ? <Bot size={12} /> : <MessageSquare size={12} />;
  const displayContent = isAssistant
    ? sanitizeDisplayContent(message.content, message.citations)
    : message.content;
  const hasAssistantText = isAssistant && Boolean((displayContent || "").trim());
  const isAssistantPlaceholder = isAssistant && isMessageStreaming && !hasAssistantText;
  const isFlatAgentAssistant = isAssistant && message.mode === "agent";
  const processPanel = isAssistant ? (
    message.mode === "agent" &&
    isMessageStreaming &&
    !hasAssistantText &&
    !message.agentRun?.steps?.length ? (
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
        {isAssistant && (
          <div className="mb-1.5 flex items-center gap-1 text-[11px] leading-none font-medium text-muted-foreground">
            {badgeIcon}
            <span>{label}</span>
          </div>
        )}

        {!isAssistant && message.attachmentsMeta && message.attachmentsMeta.length > 0 && (
          <DesktopMessageAttachments attachments={message.attachmentsMeta} />
        )}

        {processPanel}

        {isAssistant ? (
          <div className={cn("min-w-0 max-w-full", processPanel && "mt-3")}>
            <LiveStatusBadge
              status={message.liveStatus}
              route={message.liveRoute}
              label={message.liveLabel}
            />
            <div
              className="text-sm leading-6"
              style={{
                overflowWrap: "anywhere",
                wordBreak: "break-word",
                maxWidth: "100%",
              }}
            >
              {hasAssistantText ? (
                isMessageStreaming && !isFlatAgentAssistant ? (
                  <DesktopStreamingMarkdownMessage
                    content={displayContent}
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
          (() => {
            // A user message may carry a slash command token (`/web-access …`) at
            // any token boundary. It stays in the stored content so it survives
            // reload; we render it inline, in place, as a typed chip — but only
            // when it maps to a *known* skill/MCP, so ordinary text containing
            // "/" is left untouched.
            const content = message.content || "";
            const token = knownCommands ? findKnownSlashToken(content, knownCommands) : null;
            if (!token && !content.trim()) return null;
            const ChipIcon = token ? SLASH_ICONS[token.type] : null;
            return (
              <p
                className="text-sm"
                style={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                  maxWidth: "100%",
                }}
              >
                {token && ChipIcon ? (
                  <>
                    {content.slice(0, token.start)}
                    <span className="font-medium text-blue-500">
                      <ChipIcon size={14} className="mr-1 inline-block align-[-2px]" />
                      {content.slice(token.start, token.end)}
                    </span>
                    {content.slice(token.end)}
                  </>
                ) : (
                  content
                )}
              </p>
            );
          })()
        ) : null}
        {isFlatAgentAssistant &&
          isMessageStreaming &&
          (hasAssistantText || (message.agentRun?.steps?.length ?? 0) > 0) && (
            <section className="mt-0.5 px-1 pt-0 pb-1">
              <DesktopAgentTaskMetaLine text="Working" active />
            </section>
          )}
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

// Memoized: during streaming, the messages array changes on every token, which
// re-renders the list. Message updates use `.map` that returns the SAME object for
// unchanged rows, so a reference check on `message` lets every non-streaming bubble
// bail out — only the streaming message re-renders. Callbacks are ignored (stable
// per message); all render-affecting scalar props are compared.
export const MessageBubble = memo(
  MessageBubbleImpl,
  (prev, next) =>
    prev.message === next.message &&
    prev.isStreaming === next.isStreaming &&
    prev.canEdit === next.canEdit &&
    prev.canRetry === next.canRetry &&
    prev.canDelete === next.canDelete &&
    prev.assistantWidth === next.assistantWidth &&
    prev.userMaxWidth === next.userMaxWidth &&
    prev.knownCommands === next.knownCommands,
);
