import type { ApiAgentRunStep } from "../types/chat";

/** Keep expanded step controls mounted while streamed content/status changes. */
export function keyedAgentSteps(steps: ApiAgentRunStep[]) {
  const occurrences = new Map<string, number>();
  return steps.map((step) => {
    // ACP supplies a stable call id. Other live steps keep their creation time.
    // Imported legacy runs may have neither; their ordered steps are immutable.
    const identity = JSON.stringify(
      step.toolCallId
        ? [step.type, step.toolCallId]
        : [step.type, step.timestamp ?? null, step.toolName ?? null],
    );
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { step, key: `${identity}:${occurrence}` };
  });
}
