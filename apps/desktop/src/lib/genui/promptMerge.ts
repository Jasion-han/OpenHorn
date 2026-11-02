/**
 * Appends the response-format policy to what a run already carries. Auto uses
 * components/chat/genui/prompt.ts and its component library; Text only uses a
 * lightweight policy. Callers load the current section on demand and pass it
 * here; `null` means no addendum and leaves everything untouched.
 */

/** Agent runs: the global system prompt with the section appended. */
export function withGenUiPrompt(
  systemPrompt: string | undefined,
  section: string | null,
): string | undefined {
  if (!section) return systemPrompt;
  return systemPrompt?.trim() ? `${systemPrompt.trim()}\n\n${section}` : section;
}

type ChatMessage = { role: string; content: unknown };

/**
 * Chat mode: the server already assembled the messages (with its own system
 * prompt). Append the section to the first system message, or add one.
 */
export function withGenUiMessages<T extends ChatMessage>(
  messages: T[],
  section: string | null,
): T[] {
  if (!section) return messages;
  const index = messages.findIndex((m) => m.role === "system" && typeof m.content === "string");
  if (index === -1) return [{ role: "system", content: section } as T, ...messages];
  return messages.map((m, i) =>
    i === index ? { ...m, content: `${String(m.content).trim()}\n\n${section}` } : m,
  );
}
