import type { ChatMode } from "../types/chat";
import type { EffectiveModelResult } from "./effectiveModel";
import { getChatLabel } from "./i18n/agent";

/** ACP channels expose an Agent session, not a chat-completion endpoint. */
export function chatModeUnavailableReason(
  protocol: string | undefined,
  mode: ChatMode,
): string | null {
  return protocol === "acp" && mode === "chat" ? getChatLabel("chat.mode.agentOnly") : null;
}

/**
 * Where a regenerate / edit-and-resend of a round runs.
 *
 * Agent rounds run only in the sidecar — the server no longer executes agent
 * turns and refuses them. So an agent round needs the same things a fresh agent
 * send needs (a channel on the conversation, a usable model), and reports the
 * same errors when they are missing, instead of falling back to the server.
 * Chat rounds keep going through the server.
 */
export type RerunRoute =
  | { kind: "server" }
  | { kind: "sidecar"; channelId: string; modelId: string }
  | { kind: "unavailable"; reason: "noChannel" | "noModel" };

export function resolveRerunRoute(input: {
  mode: ChatMode | null | undefined;
  channelId: string | null | undefined;
  effectiveModel: Pick<EffectiveModelResult, "ok"> & { modelId?: string };
}): RerunRoute {
  if (input.mode !== "agent") return { kind: "server" };
  // Same order as the send path: channel first, then model.
  if (!input.channelId) return { kind: "unavailable", reason: "noChannel" };
  if (!input.effectiveModel.ok || !input.effectiveModel.modelId) {
    return { kind: "unavailable", reason: "noModel" };
  }
  return { kind: "sidecar", channelId: input.channelId, modelId: input.effectiveModel.modelId };
}
