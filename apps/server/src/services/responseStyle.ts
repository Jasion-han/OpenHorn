export const RESPONSE_STYLE_GUARDRAILS = [
  "Answer directly.",
  "Do not begin by repeating, paraphrasing, or mirroring the user's request unless it is necessary to resolve ambiguity or address a safety concern.",
  "Keep internal reasoning and tool-use details out of the final answer unless the user explicitly asks for them.",
  "When the next step is clear, lead with the answer, result, or concrete action.",
].join("\n");

export function mergeSystemPromptParts(...parts: Array<string | null | undefined>) {
  return (
    parts
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
      .join("\n\n") || null
  );
}
