import {
  ChevronDown,
  CornerDownLeft,
  Globe,
  Paperclip,
  Plug,
  ShieldOff,
  Sparkles,
  Square,
  Terminal,
} from "lucide-react";
import type {
  ClipboardEvent,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from "react";
import { useEffect, useRef, useState } from "react";
import { Button, cn, Textarea, Tooltip, TooltipContent, TooltipTrigger } from "ui";
import type { ChatMode } from "../../types/chat";
import { DesktopAttachmentPreviewItem } from "./DesktopAttachmentPreviewItem";
import { DesktopProviderLogo } from "./DesktopProviderLogo";

export type SlashPanelItem = {
  type: "skill" | "mcp" | "command";
  id: string;
  name: string;
  subtitle: string;
  group: string;
};

export const SLASH_ICONS = {
  skill: Sparkles,
  mcp: Plug,
  command: Terminal,
} as const;

export type SlashHighlightRange = {
  /** Index of the `/` in the input value. */
  start: number;
  /** Token length including the `/`. */
  len: number;
};

const ACCEPT_FILES = "image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown";

function fileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function DesktopComposer({
  value,
  onChange,
  onKeyDown,
  placeholder,
  attachments,
  disabled,
  onAddAttachments,
  onRemoveAttachment,
  mode,
  onModeChange,
  agentModeAvailable = true,
  agentModeDisabledReason,
  onSubmit,
  modelProvider,
  modelLabel,
  modelTone = "normal",
  onOpenModelPicker,
  fullAccessEnabled = false,
  onToggleFullAccess,
  forceWebSearch,
  onToggleWebSearch,
  onInputFocus,
  streaming,
  canSubmit,
  onStop,
  inputRef,
  slashHighlight = null,
  slashOpen = false,
  slashItems = [],
  slashIndex = 0,
  slashEmptyLabel = "",
  onSlashSelect,
  onSlashHover,
  onSlashClose,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  attachments: File[];
  disabled: boolean;
  onAddAttachments: (files: File[]) => void;
  onRemoveAttachment: (file: File) => void;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  agentModeAvailable?: boolean;
  agentModeDisabledReason?: string | null;
  onSubmit: () => void;
  modelProvider?: string | null;
  modelLabel?: string | null;
  modelTone?: "normal" | "warning";
  onOpenModelPicker?: () => void;
  fullAccessEnabled?: boolean;
  onToggleFullAccess?: () => void;
  forceWebSearch: boolean;
  onToggleWebSearch: () => void;
  onInputFocus?: () => void;
  streaming: boolean;
  canSubmit: boolean;
  onStop: () => void | Promise<void>;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  slashHighlight?: SlashHighlightRange | null;
  slashOpen?: boolean;
  slashItems?: SlashPanelItem[];
  slashIndex?: number;
  slashEmptyLabel?: string;
  onSlashSelect?: (index: number) => void;
  onSlashHover?: (index: number) => void;
  onSlashClose?: () => void;
}) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const slashContainerRef = useRef<HTMLDivElement>(null);
  const slashPointerRef = useRef<{ x: number; y: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const highlightBackdropRef = useRef<HTMLDivElement>(null);

  // Keep the highlight backdrop scrolled in lock-step with the textarea so the
  // painted (colored) text stays aligned with the caret on multi-line input.
  const syncBackdropScroll = (target: HTMLTextAreaElement) => {
    const backdrop = highlightBackdropRef.current;
    if (!backdrop) return;
    backdrop.scrollTop = target.scrollTop;
    backdrop.scrollLeft = target.scrollLeft;
  };

  // Clamp the highlighted token to the current value so a stale range from a
  // just-shortened input never paints out of bounds.
  const highlight =
    slashHighlight && slashHighlight.len > 0 && slashHighlight.start < value.length
      ? {
          start: slashHighlight.start,
          end: Math.min(slashHighlight.start + slashHighlight.len, value.length),
        }
      : null;
  // A trailing newline in a pre-wrap block has no rendered height unless a glyph
  // follows; append a zero-width space so the backdrop height matches the textarea.
  const trailingGuard = value.endsWith("\n") ? "​" : "";

  const handleAppendAttachments = (files: File[] | FileList) => {
    const nextFiles = Array.from(files);
    if (nextFiles.length === 0) return;
    onAddAttachments(nextFiles);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files || []);
    if (files.length === 0) return;
    event.preventDefault();
    handleAppendAttachments(files);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || streaming || !Array.from(event.dataTransfer.types).includes("Files")) {
      return;
    }
    event.preventDefault();
    if (!dragActive) {
      setDragActive(true);
    }
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setDragActive(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || streaming) return;
    event.preventDefault();
    setDragActive(false);
    handleAppendAttachments(event.dataTransfer.files);
  };

  const modeDisabled = disabled || streaming;
  const alternateMode: ChatMode = mode === "chat" ? "agent" : "chat";
  const alternateModeDisabled = alternateMode === "agent" && !agentModeAvailable;

  useEffect(() => {
    if (!modeMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!modeMenuRef.current?.contains(event.target as Node)) {
        setModeMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModeMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [modeMenuOpen]);

  useEffect(() => {
    if (!slashOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!slashContainerRef.current?.contains(event.target as Node)) {
        onSlashClose?.();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [slashOpen, onSlashClose]);

  useEffect(() => {
    if (!slashOpen) return;
    slashContainerRef.current
      ?.querySelector(`[data-slash-index="${slashIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [slashOpen, slashIndex]);

  return (
    <div className="pt-2">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop container is mouse-only, inner controls are accessible */}
      <div
        className={cn(
          "rounded-[17px] border-[0.5px] border-border bg-background/70 pt-2 shadow-minimal backdrop-blur-sm transition-all duration-200 titlebar-no-drag focus-within:border-foreground/20",
          dragActive && "border-[2px] border-dashed border-[#2ecc71] bg-[#2ecc71]/[0.03]",
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT_FILES}
          className="hidden"
          disabled={disabled}
          onChange={(event) => {
            if (event.target.files) {
              handleAppendAttachments(event.target.files);
            }
            event.target.value = "";
          }}
        />

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1 px-[15px] py-[5px]">
            {attachments.map((file) => (
              <DesktopAttachmentPreviewItem
                key={fileKey(file)}
                file={file}
                onRemove={() => onRemoveAttachment(file)}
              />
            ))}
          </div>
        )}

        <div ref={slashContainerRef} className="relative px-[15px] pb-2">
          {slashOpen && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-[14px] border-[0.5px] border-border bg-popover/95 shadow-[0_16px_40px_rgba(15,23,42,0.18)] ring-1 ring-border/25 backdrop-blur-md">
              {slashItems.length === 0 ? (
                <div className="px-3 py-2.5 text-xs text-muted-foreground">{slashEmptyLabel}</div>
              ) : (
                <div className="max-h-[280px] overflow-y-auto py-1">
                  {slashItems.map((item, index) => {
                    const Icon = SLASH_ICONS[item.type];
                    const prev = slashItems[index - 1];
                    const showGroup = !prev || prev.group !== item.group;
                    const active = index === slashIndex;
                    return (
                      <div key={`${item.type}:${item.id}`}>
                        {showGroup && (
                          <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                            {item.group}
                          </div>
                        )}
                        <button
                          type="button"
                          data-slash-index={index}
                          onClick={() => onSlashSelect?.(index)}
                          // Hover selection must only follow real pointer movement; scrolling
                          // under a stationary pointer redispatches synthetic mousemove events
                          // with unchanged coordinates, which must not steal the selection.
                          onMouseMove={(event) => {
                            const last = slashPointerRef.current;
                            const moved =
                              !!last && (last.x !== event.clientX || last.y !== event.clientY);
                            slashPointerRef.current = { x: event.clientX, y: event.clientY };
                            if (!moved || index === slashIndex) return;
                            onSlashHover?.(index);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors",
                            active
                              ? "bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400"
                              : "text-foreground/80 hover:bg-accent/60",
                          )}
                        >
                          <Icon
                            className={cn(
                              "size-4 shrink-0",
                              active ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground",
                            )}
                          />
                          <span className="shrink-0 truncate text-sm font-medium">{item.name}</span>
                          {item.subtitle && (
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                              {item.subtitle}
                            </span>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {/* Highlight overlay: a backdrop div paints the text (with the /command
              token in blue, wherever it sits) while the textarea on top stays
              transparent but keeps a visible caret + native selection. Both layers
              share identical box model + typography so the painted text aligns 1:1
              with the caret. */}
          <div className="relative">
            <div
              ref={highlightBackdropRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-0 overflow-hidden whitespace-pre-wrap break-words p-0 text-sm leading-5 text-foreground"
              style={{ overflowWrap: "break-word", wordBreak: "break-word" }}
            >
              {highlight ? (
                <>
                  {value.slice(0, highlight.start)}
                  <span className="text-blue-500 dark:text-blue-400">
                    {value.slice(highlight.start, highlight.end)}
                  </span>
                  {value.slice(highlight.end)}
                  {trailingGuard}
                </>
              ) : (
                <>
                  {value}
                  {trailingGuard}
                </>
              )}
            </div>
            <Textarea
              value={value}
              ref={inputRef}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
              onScroll={(event) => syncBackdropScroll(event.currentTarget)}
              onPaste={handlePaste}
              onFocus={() => onInputFocus?.()}
              placeholder={placeholder}
              rows={1}
              className="relative z-[1] min-h-[36px] max-h-[160px] resize-none border-0 bg-transparent p-0 text-sm leading-5 text-transparent caret-foreground shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 disabled:cursor-default disabled:opacity-100"
              onKeyDown={onKeyDown}
            />
          </div>
        </div>

        <div className="flex h-[40px] items-center justify-between gap-4 px-2 py-[5px]">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled}
                  className="size-[30px] rounded-full text-foreground/60 hover:text-foreground"
                  aria-label="Attach"
                >
                  <Paperclip className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>Add attachments</p>
              </TooltipContent>
            </Tooltip>

            <div ref={modeMenuRef} className="relative inline-flex flex-col items-center">
              {modeMenuOpen && !modeDisabled && (
                <div className="pointer-events-none absolute bottom-full left-0 right-0 z-20 mb-1 flex justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      if (alternateModeDisabled) return;
                      onModeChange(alternateMode);
                      setModeMenuOpen(false);
                    }}
                    disabled={alternateModeDisabled}
                    className={cn(
                      "pointer-events-auto flex w-full items-center justify-center gap-1.5 rounded-[10px] px-2.5 py-1 text-xs",
                      alternateModeDisabled
                        ? "cursor-not-allowed bg-muted/80 text-muted-foreground opacity-70 ring-1 ring-border/25"
                        : "bg-accent/88 text-foreground shadow-[0_10px_24px_rgba(15,23,42,0.12)] ring-1 ring-border/25 backdrop-blur-md transition-colors hover:bg-accent",
                    )}
                    title={
                      alternateModeDisabled ? (agentModeDisabledReason ?? "当前不可用") : undefined
                    }
                  >
                    <span>{alternateMode === "chat" ? "Chat" : "Agent"}</span>
                    <ChevronDown className="size-3 shrink-0 opacity-0" aria-hidden="true" />
                  </button>
                </div>
              )}

              <button
                type="button"
                disabled={modeDisabled}
                onClick={() => {
                  if (modeDisabled) return;
                  setModeMenuOpen((open) => !open);
                }}
                className={cn(
                  "flex min-w-[68px] items-center justify-center gap-1.5 rounded-[10px] px-2.5 py-1 text-xs transition-colors",
                  modeMenuOpen
                    ? "bg-accent/80 text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent",
                  modeDisabled && "opacity-60 pointer-events-none",
                )}
                aria-label="Mode"
                title="Mode"
              >
                <span className="truncate">{mode === "chat" ? "Chat" : "Agent"}</span>
                <ChevronDown
                  className={cn("size-3 transition-transform", modeMenuOpen && "rotate-180")}
                />
              </button>
            </div>

            <button
              type="button"
              onClick={onOpenModelPicker}
              disabled={!onOpenModelPicker || disabled}
              className={cn(
                "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                modelTone === "warning"
                  ? "text-orange-600 hover:text-orange-700 hover:bg-orange-500/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent",
                (!onOpenModelPicker || disabled) && "opacity-60 pointer-events-none",
              )}
              aria-label="Model"
              title="Model"
            >
              {modelProvider ? (
                <DesktopProviderLogo provider={modelProvider} className="size-4" />
              ) : null}
              <span className="max-w-[220px] truncate">{modelLabel || "Select model"}</span>
              <ChevronDown className="size-3" />
            </button>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onToggleWebSearch}
                  disabled={disabled || streaming}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                    forceWebSearch
                      ? "bg-emerald-400/20 text-emerald-500 hover:bg-emerald-400/30"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    (disabled || streaming) && "pointer-events-none opacity-60",
                  )}
                  aria-label="Allow web search"
                  title="Allow web search"
                >
                  <Globe className="size-3.5" />
                  <span>Web search</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>
                  {forceWebSearch ? "Web search: on" : "Web search: off"}
                </p>
              </TooltipContent>
            </Tooltip>

            {mode === "agent" && onToggleFullAccess && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onToggleFullAccess}
                    disabled={disabled || streaming}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
                      fullAccessEnabled
                        ? "bg-rose-400/20 text-rose-600 hover:bg-rose-400/30"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent",
                      (disabled || streaming) && "pointer-events-none opacity-60",
                    )}
                    aria-label="Full Access"
                    title="Full Access"
                  >
                    <ShieldOff size={14} />
                    <span>Full Access</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>
                    {fullAccessEnabled
                      ? "Full Access: all operations auto-approved"
                      : "Full Access: off (dangerous commands need approval)"}
                  </p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {streaming ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-[30px] rounded-full text-destructive hover:bg-destructive/10"
                onClick={() => {
                  void onStop();
                }}
                aria-label="Stop"
                title="Stop"
              >
                <Square className="size-[22px]" />
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "size-[30px] rounded-full",
                  canSubmit
                    ? "text-primary hover:bg-primary/10"
                    : "text-foreground/30 cursor-not-allowed",
                )}
                onClick={() => void onSubmit()}
                disabled={!canSubmit}
                aria-label="Send"
                title="Send"
              >
                <CornerDownLeft className="size-[22px]" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
