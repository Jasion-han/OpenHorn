import type { ApiCitation } from "../types/chat";
import { sanitizeDisplayContent } from "./citations";

type ResolveAgentDisplayOutputInput = {
  liveOutputText?: string | null;
  messageContent?: string | null;
  detailOutputText?: string | null;
  fallbackContent?: string | null;
  liveOutputCitations?: ApiCitation[];
  messageCitations?: ApiCitation[];
  finalCitations?: ApiCitation[];
  isTerminal: boolean;
  isExecutionStreaming: boolean;
};

export type ResolvedAgentDisplayOutput = {
  text: string;
  streaming: boolean;
  citations?: ApiCitation[];
} | null;

function isLowSignalAgentOutput(text: string | null | undefined) {
  const normalized = (text ?? "").trim();
  if (!normalized) return true;

  return (
    normalized === "Thinking" ||
    normalized === "Working" ||
    normalized === "Error" ||
    normalized === "Ready" ||
    normalized === "Done" ||
    normalized === "Stopped" ||
    normalized === "Awaiting confirmation" ||
    normalized === "Awaiting start" ||
    normalized === "thinking" ||
    normalized === "working" ||
    normalized === "ready" ||
    normalized === "done" ||
    normalized === "building plan" ||
    normalized === "paused" ||
    normalized === "blocked on error" ||
    normalized === "stopped" ||
    normalized === "Agent 正在执行" ||
    normalized.startsWith("Execution completed.")
  );
}

function normalizeVisibleText(text: string | null | undefined, citations?: ApiCitation[]) {
  return sanitizeDisplayContent(text ?? "", citations).trim();
}

export function resolveAgentDisplayOutput(
  input: ResolveAgentDisplayOutputInput,
): ResolvedAgentDisplayOutput {
  const liveText = normalizeVisibleText(input.liveOutputText, input.liveOutputCitations);
  const messageText = normalizeVisibleText(input.messageContent, input.messageCitations);
  const detailText = normalizeVisibleText(input.detailOutputText, input.finalCitations);
  const fallbackText = normalizeVisibleText(input.fallbackContent);

  const primaryRuntimeText = !isLowSignalAgentOutput(liveText)
    ? liveText
    : !isLowSignalAgentOutput(messageText)
    ? messageText
    : !isLowSignalAgentOutput(detailText)
      ? detailText
      : "";

  if (!input.isTerminal) {
    if (!primaryRuntimeText) return null;
    return {
      text: primaryRuntimeText,
      streaming: true,
      citations: input.liveOutputCitations ?? input.messageCitations,
    };
  }

  if (!isLowSignalAgentOutput(liveText)) {
    return {
      text: liveText,
      streaming: input.isExecutionStreaming,
      citations: input.liveOutputCitations ?? input.finalCitations ?? input.messageCitations,
    };
  }

  if (!isLowSignalAgentOutput(messageText)) {
    return {
      text: messageText,
      streaming: input.isExecutionStreaming,
      citations: input.finalCitations ?? input.messageCitations,
    };
  }

  if (!isLowSignalAgentOutput(detailText)) {
    return {
      text: detailText,
      streaming: false,
      citations: input.finalCitations,
    };
  }

  if (!isLowSignalAgentOutput(fallbackText)) {
    return {
      text: fallbackText,
      streaming: false,
    };
  }

  return null;
}
