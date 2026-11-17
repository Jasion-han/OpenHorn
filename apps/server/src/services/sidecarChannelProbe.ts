import { getChannelBreakerState, getChannelProbe, settleChannelProbe } from "./circuitBreaker";

interface MessageIdentity {
  userId: string;
  conversationId: string;
  assistantMessageId: string;
}

interface ProbeBinding extends MessageIdentity {
  channelId: string;
  probeId: number;
  expiresAt: number;
}

// Only outstanding half-open probes are tracked, not ordinary messages or
// credentials. The breaker is also in-memory, so a server restart clears both.
const bindings = new Map<string, ProbeBinding>();
const MAX_BINDINGS = 1_000;

function discard(assistantMessageId: string, binding: ProbeBinding): void {
  bindings.delete(assistantMessageId);
  settleChannelProbe(binding.channelId, binding.probeId, "abandoned");
}

function prune(): void {
  const now = Date.now();
  for (const [id, binding] of bindings) {
    if (binding.expiresAt <= now) discard(id, binding);
  }
}

/** Bind the server-resolved channel only after preparation actually succeeds. */
export async function prepareWithSidecarChannelProbe<T extends { assistantMessageId: string }>(
  scope: { userId: string; conversationId: string; channelId: string },
  prepare: () => Promise<T>,
): Promise<T> {
  prune();
  const probe = getChannelProbe(scope.channelId);
  try {
    const result = await prepare();
    const currentProbe = getChannelProbe(scope.channelId);
    if (
      probe &&
      currentProbe?.id !== probe.id &&
      getChannelBreakerState(scope.channelId) !== "closed"
    ) {
      throw new Error("Channel recovery probe expired during preparation");
    }
    if (probe && currentProbe?.id === probe.id) {
      while (bindings.size >= MAX_BINDINGS) {
        const oldest = bindings.entries().next().value;
        if (!oldest) break;
        discard(oldest[0], oldest[1]);
      }
      const prior = bindings.get(result.assistantMessageId);
      if (prior) discard(result.assistantMessageId, prior);
      bindings.set(result.assistantMessageId, {
        ...scope,
        assistantMessageId: result.assistantMessageId,
        probeId: probe.id,
        expiresAt: probe.expiresAt,
      });
    }
    return result;
  } catch (error) {
    if (probe) settleChannelProbe(scope.channelId, probe.id, "abandoned");
    throw error;
  }
}

/** Called after the owned assistant message is successfully persisted. */
export function completeSidecarChannelProbe(
  identity: MessageIdentity,
  outcome: "success" | "abandoned",
): void {
  prune();
  const binding = bindings.get(identity.assistantMessageId);
  if (
    !binding ||
    binding.userId !== identity.userId ||
    binding.conversationId !== identity.conversationId
  ) {
    return;
  }
  bindings.delete(identity.assistantMessageId);
  settleChannelProbe(binding.channelId, binding.probeId, outcome);
}
