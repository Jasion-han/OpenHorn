import { Bot, MessageSquare } from "lucide-react";
import { memo } from "react";
import { hasAgentReplyTextSteps } from "shared/message-text";
import { cn } from "ui";
import { sanitizeDisplayContent } from "../../lib/citations";
import { formatMessageTime, formatTokenCount } from "../../lib/conversationTitle";
import { getChatLabel } from "../../lib/i18n/agent";
import type { SlashCommandType } from "../../lib/slashToken";
import { resolvePlainReplyEndState } from "../../lib/stopTurn";
import type { Message } from "../../types/chat";
import { AgentRunPanel } from "./DesktopAgentRunPanel";
import { DesktopAgentTaskMetaLine } from "./DesktopAgentTaskMetaLine";
import { DesktopCitationList } from "./DesktopCitationList";
import { LiveStatusBadge } from "./DesktopLiveStatusBadge";
import { stripLeadingThematicBreak } from "./DesktopMarkdownMessage";
import { MessageActionBar } from "./DesktopMessageActionBar";
import { DesktopMessageAttachments } from "./DesktopMessageAttachments";
import { DesktopNativeWebActivity } from "./DesktopNativeWebActivity";
import { DesktopStreamingMarkdownMessage } from "./DesktopStreamingMarkdownMessage";
import { TypingIndicator } from "./DesktopTypingIndicator";
import { DesktopUserMessageContent } from "./DesktopUserMessageContent";

/**
 * Which single live indicator an agent answer shows while it is running.
 *
 * There must never be two at once: "leading" is the pre-output placeholder shown
 * above the (still empty) body, "trailing" is the working line shown under the
 * body once output has started. Returning one value makes that exclusivity a
 * property of the function rather than of two independent JSX conditions.
 */
export function resolveAgentLiveIndicator(input: {
  isAgentAssistant: boolean;
  isStreaming: boolean;
  hasText: boolean;
  stepCount: number;
}): "leading" | "trailing" | "none" {
  if (!input.isAgentAssistant || !input.isStreaming) return "none";
  if (input.stepCount > 0) return "none";
  return input.hasText ? "trailing" : "leading";
}

/**
 * The closing line of a finished assistant reply without a run record (a chat
 * reply, or an agent row stored without one): "stopped" under a reply the user
 * stopped, and an explicit state instead of a blank bubble when it holds no
 * text. A reply with a run gets its closing line from the run panel (see
 * resolveRunEndState). Read from the persisted `finishReason`, so it survives
 * a reload.
 */
export function resolveBubbleEndLabel(input: {
  message: Pick<Message, "role" | "content" | "agentRun" | "finishReason">;
  isStreaming: boolean;
}):
  | "chat.agent.stopped"
  | "chat.agent.cancelled"
  | "chat.reply.empty"
  | "chat.reply.truncated"
  | "chat.reply.contextBudgetExceeded"
  | "chat.reply.failed"
  | "chat.reply.refused"
  | null {
  const { message } = input;
  if (message.role !== "assistant" || input.isStreaming || message.agentRun) return null;
  if (message.finishReason === "length") return "chat.reply.truncated";
  if (message.finishReason === "context_budget_exceeded") return "chat.reply.contextBudgetExceeded";
  if (message.finishReason === "error") return "chat.reply.failed";
  if (message.finishReason === "refused") return "chat.reply.refused";
  const state = resolvePlainReplyEndState(message);
  if (state === "stopped") return "chat.agent.stopped";
  if (state === "cancelled") return "chat.agent.cancelled";
  if (state === "noReply") return "chat.reply.empty";
  return null;
}

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
    ? stripLeadingThematicBreak(sanitizeDisplayContent(message.content, message.citations))
    : message.content;
  const hasAssistantText = isAssistant && Boolean((displayContent || "").trim());
  const isAssistantPlaceholder = isAssistant && isMessageStreaming && !hasAssistantText;
  const isFlatAgentAssistant = isAssistant && message.mode === "agent";
  // `content` mirrors the run's text steps, which the run panel already renders
  // inline in the timeline — rendering the content block too would show the
  // answer twice. A run without text steps has no reply text (content is "");
  // its failure, if any, is the panel's `agentRun.error` line.
  const replyInTimeline = isAssistant && hasAgentReplyTextSteps(message.agentRun);
  const showContentBody = hasAssistantText && !replyInTimeline;
  const endLabel = resolveBubbleEndLabel({ message, isStreaming: isMessageStreaming });
  const liveIndicator = resolveAgentLiveIndicator({
    isAgentAssistant: isFlatAgentAssistant,
    isStreaming: isMessageStreaming,
    hasText: hasAssistantText,
    stepCount: message.agentRun?.steps?.length ?? 0,
  });
  const processPanel = isAssistant ? (
    liveIndicator === "leading" ? (
      <section className="mt-0.5 px-1 pt-0 pb-1">
        <DesktopAgentTaskMetaLine text={message.agentRun?.summary?.trim() || "Thinking"} active />
      </section>
    ) : (
      // The panel's own "no steps yet" placeholder would sit next to the trailing
      // "Working" line — suppress it whenever that line is the active indicator.
      <AgentRunPanel
        run={message.agentRun}
        hideIdleIndicator={liveIndicator === "trailing"}
        isStreaming={isMessageStreaming}
        genUiScope={message.id}
      />
    )
  ) : null;

  return (
    <div
      data-chat-message-key={message.renderKey ?? message.id}
      data-chat-conversation-id={message.conversationId}
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
            <DesktopNativeWebActivity metadata={message.nativeMetadata} />
            <div
              className="text-sm leading-6"
              style={{
                overflowWrap: "anywhere",
                wordBreak: "break-word",
                maxWidth: "100%",
              }}
            >
              {showContentBody ? (
                <DesktopStreamingMarkdownMessage
                  content={displayContent}
                  pulseKey={message.streamPulseKey ?? 0}
                  genUiScope={message.id}
                  streaming={isMessageStreaming && !isFlatAgentAssistant}
                />
              ) : isMessageStreaming && !isFlatAgentAssistant ? (
                <TypingIndicator />
              ) : null}
              {endLabel && <DesktopAgentTaskMetaLine text={getChatLabel(endLabel)} />}
            </div>
            <DesktopCitationList citations={message.citations} content={displayContent} />
          </div>
        ) : !isAssistant ? (
          <DesktopUserMessageContent
            content={message.content || ""}
            knownCommands={knownCommands}
          />
        ) : null}
        {liveIndicator === "trailing" && (
          <section className="mt-0.5 px-1 pt-0 pb-1">
            <DesktopAgentTaskMetaLine text="Working" active />
          </section>
        )}
      </div>
      {/* The timestamp is the moment the answer finished, so it only appears once
          the stream ends. `updatedAt` moves forward on regenerate while createdAt
          stays put (the thread is ordered by createdAt). */}
      {!isMessageStreaming && (
        <span
          className={cn(
            "mt-1 text-[10px] leading-none text-muted-foreground/40",
            isAssistant ? "self-start" : "self-end",
          )}
        >
          {formatMessageTime(message.updatedAt ?? message.createdAt)}
          {message.usage && !message.agentRun?.contextUsage ? (
            <span title={getChatLabel("chat.usage.tooltip")}>
              {" · "}
              {formatTokenCount(message.usage.totalTokens)} tokens
            </span>
          ) : null}
        </span>
      )}
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
