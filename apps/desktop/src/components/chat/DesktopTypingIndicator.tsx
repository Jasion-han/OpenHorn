import { getChatLabel } from "../../lib/i18n/agent";

export function TypingIndicator() {
  return (
    // `output`, not a div: the dots are a live status update — a reply is on its
    // way — and this element carries that role natively, so the aria-label has
    // something to attach to. A bare div takes no aria-label at all, which is
    // what this was before: three animated dots and nothing announced. Display
    // comes from the class, so it renders exactly as the div did.
    <output
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
    </output>
  );
}
