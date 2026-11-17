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
  researchMode = false,
  researchAvailable = false,
  onResearch,
}: {
  researchMode?: boolean;
  researchAvailable?: boolean;
  onResearch?: () => void;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  disabled?: boolean;
  /** False while the agent runtime is unreachable — the option shows, inert. */
  agentAvailable?: boolean;
  agentDisabledReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex shrink-0 flex-col items-center">
      {open && !disabled && (
        <div className="absolute bottom-full left-0 z-30 mb-2 min-w-[160px] rounded-xl border border-border bg-popover p-1 shadow-lg">
          {(["chat", "agent", ...(onResearch ? ["research"] : [])] as const).map((item) => {
            const unavailable =
              item === "research" ? !researchAvailable : item === "agent" && !agentAvailable;
            const selected = item === "research" ? researchMode : !researchMode && mode === item;
            return (
              <button
                key={item}
                type="button"
                disabled={unavailable}
                className={cn(
                  "flex w-full items-center rounded-lg px-3 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "bg-accent text-foreground" : "hover:bg-accent",
                  unavailable && "cursor-not-allowed text-muted-foreground opacity-60",
                )}
                title={
                  item === "research"
                    ? getChatLabel(
                        researchAvailable ? "chat.research.hint" : "chat.research_unavailable",
                      )
                    : unavailable
                      ? (agentDisabledReason ?? undefined)
                      : undefined
                }
                aria-pressed={selected}
                onClick={() => {
                  if (item === "research") onResearch?.();
                  else onModeChange(item as ChatMode);
                  setOpen(false);
                  queueMicrotask(() => triggerRef.current?.focus());
                }}
              >
                {item === "research"
                  ? getChatLabel("chat.research.title")
                  : item === "chat"
                    ? "Chat"
                    : "Agent"}
              </button>
            );
          })}
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
        className={cn(
          "flex min-w-[68px] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] px-2.5 py-1 text-xs transition-colors",
          open
            ? "bg-accent/80 text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
          disabled && "pointer-events-none opacity-60",
        )}
        aria-label="Mode"
        aria-expanded={open}
        title="Mode"
      >
        <span className="truncate whitespace-nowrap">
          {researchMode ? getChatLabel("chat.research.title") : mode === "chat" ? "Chat" : "Agent"}
        </span>
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>
    </div>
  );
}
