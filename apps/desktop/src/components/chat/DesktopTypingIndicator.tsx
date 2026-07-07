import { getChatLabel } from "../../lib/i18n/agent";

export function TypingIndicator() {
  return (
    <div
      aria-label={getChatLabel("chat.typing")}
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
