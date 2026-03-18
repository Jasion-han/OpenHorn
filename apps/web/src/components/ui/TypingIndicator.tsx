"use client";

import { cn } from "@/lib/utils";

export function TypingIndicator(props: {
  className?: string;
  dotClassName?: string;
  "aria-label"?: string;
}) {
  const { className, dotClassName, "aria-label": ariaLabel } = props;
  const label = ariaLabel || "Streaming";

  return (
    <output
      className={cn(
        "inline-flex items-center gap-1 align-middle rounded-full bg-muted/30 px-2.5 py-1.5 text-muted-foreground/80",
        className,
      )}
      aria-label={label}
    >
      <span className="sr-only">{label}</span>
      <span className={cn("oh-typing-dot", dotClassName)} style={{ animationDelay: "0ms" }} />
      <span className={cn("oh-typing-dot", dotClassName)} style={{ animationDelay: "160ms" }} />
      <span className={cn("oh-typing-dot", dotClassName)} style={{ animationDelay: "320ms" }} />
    </output>
  );
}
