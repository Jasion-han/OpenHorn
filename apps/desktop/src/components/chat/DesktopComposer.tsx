import { ChevronDown, CornerDownLeft, FolderCog, Globe, Paperclip, Square } from "lucide-react";
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
  forceWebSearch,
  onToggleWebSearch,
  sidecarRuntimeAvailable,
  sidecarRuntimeEnabled,
  sidecarRuntimeDisabledReason,
  onToggleSidecarRuntime,
  onInputFocus,
  streaming,
  canSubmit,
  onStop,
  inputRef,
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
  forceWebSearch: boolean;
  onToggleWebSearch: () => void;
  /** True when the sidecar is ready AND a workspace has been picked. */
  sidecarRuntimeAvailable?: boolean;
  /** True when the user has opted this composer into running on the sidecar. */
  sidecarRuntimeEnabled?: boolean;
  /** Explanation to show as a tooltip when the switch is visible but disabled. */
  sidecarRuntimeDisabledReason?: string | null;
  onToggleSidecarRuntime?: () => void;
  onInputFocus?: () => void;
  streaming: boolean;
  canSubmit: boolean;
  onStop: () => void | Promise<void>;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

        <div className="px-[15px] pb-2">
          <Textarea
            value={value}
            ref={inputRef}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            onPaste={handlePaste}
            onFocus={() => onInputFocus?.()}
            placeholder={placeholder}
            rows={1}
            className="min-h-[36px] max-h-[160px] resize-none border-0 bg-transparent p-0 shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 disabled:cursor-default disabled:opacity-100"
            onKeyDown={onKeyDown}
          />
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
                  <span>允许联网</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>
                  {forceWebSearch
                    ? "需要最新信息时允许联网：已开启"
                    : "需要最新信息时允许联网：已关闭"}
                </p>
              </TooltipContent>
            </Tooltip>

            {mode === "agent" && onToggleSidecarRuntime ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-testid="composer-sidecar-toggle"
                    onClick={() => {
                      if (!sidecarRuntimeAvailable) return;
                      onToggleSidecarRuntime();
                    }}
                    disabled={disabled || streaming || !sidecarRuntimeAvailable}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                      sidecarRuntimeEnabled && sidecarRuntimeAvailable
                        ? "bg-blue-400/20 text-blue-500 hover:bg-blue-400/30"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      (disabled || streaming || !sidecarRuntimeAvailable) &&
                        "pointer-events-none opacity-60",
                    )}
                    aria-label="Run locally on sidecar"
                  >
                    <FolderCog className="size-3.5" />
                    <span>本地运行</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>
                    {!sidecarRuntimeAvailable
                      ? sidecarRuntimeDisabledReason || "本地运行尚未就绪"
                      : sidecarRuntimeEnabled
                        ? "在本地工作目录运行 Agent：已开启"
                        : "在本地工作目录运行 Agent：已关闭"}
                  </p>
                </TooltipContent>
              </Tooltip>
            ) : null}
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
