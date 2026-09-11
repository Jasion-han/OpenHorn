import { ChevronDown, Globe, Paperclip, ShieldOff } from "lucide-react";
import type { ReactNode } from "react";
import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from "ui";
import type { ChatMode } from "../../types/chat";
import styles from "./DesktopComposer.module.css";
import { DesktopComposerModeChip } from "./DesktopComposerModeChip";
import { DesktopProviderLogo } from "./DesktopProviderLogo";

/**
 * The 40px chip row under the textarea, shared by the in-conversation composer
 * and the welcome screen. The chat column narrows when the preview panel opens,
 * so the row is a size container: chip labels drop and the model name tightens
 * based on the row's own width (see DesktopComposer.module.css). Nothing in
 * here may wrap or push the `children` (send / stop) out of view.
 */
export function DesktopComposerToolbar({
  onAttach,
  attachDisabled = false,
  mode,
  onModeChange,
  modeDisabled = false,
  agentAvailable = true,
  agentDisabledReason,
  modelProvider,
  modelLabel,
  modelTone = "normal",
  onOpenModelPicker,
  modelDisabled = false,
  forceWebSearch,
  onToggleWebSearch,
  chipsDisabled = false,
  fullAccessEnabled = false,
  onToggleFullAccess,
  children,
}: {
  onAttach: () => void;
  attachDisabled?: boolean;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  modeDisabled?: boolean;
  agentAvailable?: boolean;
  agentDisabledReason?: string | null;
  modelProvider?: string | null;
  modelLabel: string;
  modelTone?: "normal" | "warning";
  onOpenModelPicker?: () => void;
  modelDisabled?: boolean;
  forceWebSearch: boolean;
  onToggleWebSearch: () => void;
  /** Disables the Web Search / Full Access toggles (e.g. while streaming). */
  chipsDisabled?: boolean;
  fullAccessEnabled?: boolean;
  /** The Full Access chip only renders in agent mode and when a handler exists. */
  onToggleFullAccess?: () => void;
  /** Right-hand group: send / stop buttons. Never shrinks. */
  children: ReactNode;
}) {
  const modelInert = !onOpenModelPicker || modelDisabled;

  return (
    <div
      className={cn(
        "flex h-[40px] min-w-0 items-center justify-between gap-4 px-2 py-[5px]",
        styles.toolbar,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onAttach}
              disabled={attachDisabled}
              className="size-[30px] shrink-0 rounded-full text-foreground/60 hover:text-foreground"
              aria-label="Attach"
            >
              <Paperclip className="size-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>Add Attachments</p>
          </TooltipContent>
        </Tooltip>

        <DesktopComposerModeChip
          mode={mode}
          onModeChange={onModeChange}
          disabled={modeDisabled}
          agentAvailable={agentAvailable}
          agentDisabledReason={agentDisabledReason}
        />

        <button
          type="button"
          onClick={onOpenModelPicker}
          disabled={modelInert}
          className={cn(
            "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors",
            modelTone === "warning"
              ? "text-orange-600 hover:text-orange-700 hover:bg-orange-500/10"
              : "text-muted-foreground hover:text-foreground hover:bg-accent",
            modelInert && "opacity-60 pointer-events-none",
          )}
          aria-label="Model"
          title="Model"
        >
          {modelProvider ? (
            <DesktopProviderLogo provider={modelProvider} className="size-4" />
          ) : null}
          <span className={cn("truncate whitespace-nowrap", styles.modelLabel)}>{modelLabel}</span>
          <ChevronDown className="size-3" />
        </button>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggleWebSearch}
              disabled={chipsDisabled}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors",
                forceWebSearch
                  ? "bg-emerald-400/20 text-emerald-500 hover:bg-emerald-400/30"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
                chipsDisabled && "pointer-events-none opacity-60",
              )}
              aria-label="Allow web search"
              title="Allow web search"
            >
              <Globe className="size-3.5" />
              <span className={cn("whitespace-nowrap", styles.chipLabel)}>Web Search</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{forceWebSearch ? "Web Search: On" : "Web Search: Off"}</p>
          </TooltipContent>
        </Tooltip>

        {mode === "agent" && onToggleFullAccess && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onToggleFullAccess}
                disabled={chipsDisabled}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors",
                  fullAccessEnabled
                    ? "bg-rose-400/20 text-rose-600 hover:bg-rose-400/30"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent",
                  chipsDisabled && "pointer-events-none opacity-60",
                )}
                aria-label="Full Access"
                title="Full Access"
              >
                <ShieldOff size={14} />
                <span className={cn("whitespace-nowrap", styles.chipLabel)}>Full Access</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>
                {fullAccessEnabled
                  ? "Full Access: All operations auto-approved"
                  : "Full Access: Off (dangerous commands need approval)"}
              </p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}
