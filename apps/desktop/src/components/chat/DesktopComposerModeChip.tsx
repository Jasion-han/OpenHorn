import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "ui";
import { getChatLabel } from "../../lib/i18n/agent";
import type { ChatMode } from "../../types/chat";

/**
 * The Chat/Agent chip, shared by the in-conversation composer and the welcome
 * screen so the two behave identically.
 *
 * It opens a menu rather than toggling on click. With exactly two modes a
 * toggle is fewer clicks, but it gives no way to see what you are switching
 * *to* before committing — and mode decides whether the next message runs tools,
 * so it is worth one deliberate extra click.
 *
 * The menu opens upward: the chip sits at the bottom of the composer, which is
 * itself at the bottom of the window.
 */
export function DesktopComposerModeChip({
  mode,
  onModeChange,
  disabled = false,
  agentAvailable = true,
  agentDisabledReason,
}: {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  disabled?: boolean;
  /** False while the agent runtime is unreachable — the option shows, inert. */
  agentAvailable?: boolean;
  agentDisabledReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const alternateMode: ChatMode = mode === "chat" ? "agent" : "chat";
  const alternateDisabled = alternateMode === "agent" && !agentAvailable;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex flex-col items-center">
      {open && !disabled && (
        <div className="pointer-events-none absolute bottom-full left-0 right-0 z-20 mb-1 flex justify-center">
          <button
            type="button"
            onClick={() => {
              if (alternateDisabled) return;
              onModeChange(alternateMode);
              setOpen(false);
            }}
            disabled={alternateDisabled}
            className={cn(
              "pointer-events-auto flex w-full items-center justify-center gap-1.5 rounded-[10px] px-2.5 py-1 text-xs",
              alternateDisabled
                ? "cursor-not-allowed bg-muted/80 text-muted-foreground opacity-70 ring-1 ring-border/25"
                : "bg-accent/88 text-foreground shadow-[0_10px_24px_rgba(15,23,42,0.12)] ring-1 ring-border/25 backdrop-blur-md transition-colors hover:bg-accent",
            )}
            title={
              alternateDisabled
                ? (agentDisabledReason ?? getChatLabel("chat.composer.modeUnavailable"))
                : undefined
            }
          >
            <span>{alternateMode === "chat" ? "Chat" : "Agent"}</span>
            {/* Invisible, but it keeps this row the same width as the trigger so
                the label does not shift as the menu opens. */}
            <ChevronDown className="size-3 shrink-0 opacity-0" aria-hidden="true" />
          </button>
        </div>
      )}

      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
        className={cn(
          "flex min-w-[68px] items-center justify-center gap-1.5 rounded-[10px] px-2.5 py-1 text-xs transition-colors",
          open
            ? "bg-accent/80 text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
          disabled && "pointer-events-none opacity-60",
        )}
        aria-label="Mode"
        title="Mode"
      >
        <span className="truncate">{mode === "chat" ? "Chat" : "Agent"}</span>
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>
    </div>
  );
}
