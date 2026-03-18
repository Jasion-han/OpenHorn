"use client";

import { ChevronDown, CornerDownLeft, Globe, Paperclip, Square } from "lucide-react";
import * as React from "react";
import { AttachmentPreviewItem } from "@/components/attachments/AttachmentPreviewItem";
import { ProviderLogo } from "@/components/providers/ProviderLogo";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ACCEPT_FILES = "image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown";

function extractFilesFromClipboard(e: React.ClipboardEvent): File[] {
  const items = Array.from(e.clipboardData?.items || []);
  const files: File[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function extractFilesFromDragEvent(e: React.DragEvent): File[] {
  return Array.from(e.dataTransfer?.files || []);
}

function fileKey(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

export function PromaComposer(props: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  disabled?: boolean;

  attachments: File[];
  onAddAttachments: (files: File[]) => void;
  onRemoveAttachment: (file: File) => void;

  mode: "chat" | "agent";
  onModeChange: (mode: "chat" | "agent") => void;
  agentModeAvailable?: boolean;
  agentModeDisabledReason?: string | null;

  modelProvider?: string | null;
  modelLabel: string | null;
  modelTone?: "normal" | "warning";
  onOpenModelPicker?: () => void;

  forceWebSearch: boolean;
  onToggleWebSearch: () => void;

  onInputFocus?: () => void;

  streaming: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  onStop: () => void;

  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const {
    value,
    onChange,
    onKeyDown,
    placeholder,
    disabled,
    attachments,
    onAddAttachments,
    onRemoveAttachment,
    mode,
    onModeChange,
    agentModeAvailable = true,
    agentModeDisabledReason,
    modelProvider,
    modelLabel,
    modelTone = "normal",
    onOpenModelPicker,
    forceWebSearch,
    onToggleWebSearch,
    onInputFocus,
    streaming,
    canSubmit,
    onSubmit,
    onStop,
    inputRef,
  } = props;

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const modeMenuRef = React.useRef<HTMLDivElement>(null);
  const [isDragOver, setIsDragOver] = React.useState(false);
  const [modeMenuOpen, setModeMenuOpen] = React.useState(false);
  const previewUrlsRef = React.useRef<Map<string, string>>(new Map());
  const [, bumpPreviewVersion] = React.useReducer((x) => x + 1, 0);

  const addFiles = React.useCallback(
    (files: File[]) => {
      const list = (files || []).filter(Boolean);
      if (list.length === 0) return;
      onAddAttachments(list);
    },
    [onAddAttachments],
  );

  React.useEffect(() => {
    const prev = previewUrlsRef.current;
    const next = new Map<string, string>();

    for (const file of attachments) {
      if (!file.type?.startsWith("image/")) continue;
      const key = fileKey(file);
      const existing = prev.get(key);
      next.set(key, existing || URL.createObjectURL(file));
    }

    for (const [key, url] of prev.entries()) {
      if (!next.has(key)) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }

    previewUrlsRef.current = next;
    bumpPreviewVersion();
  }, [attachments]);

  React.useEffect(() => {
    return () => {
      for (const url of previewUrlsRef.current.values()) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      previewUrlsRef.current.clear();
    };
  }, []);

  const handleOpenFileDialog = React.useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDragOver = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      setIsDragOver(true);
    },
    [disabled],
  );

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (disabled) return;
      const files = extractFilesFromDragEvent(e);
      if (files.length > 0) addFiles(files);
    },
    [addFiles, disabled],
  );

  const modeDisabled = Boolean(disabled || streaming);
  const alternateMode = mode === "chat" ? "agent" : "chat";
  const alternateModeDisabled = alternateMode === "agent" && !agentModeAvailable;

  React.useEffect(() => {
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
          "rounded-[17px] border-[0.5px] border-border bg-background/70 backdrop-blur-sm pt-2 transition-all duration-200 titlebar-no-drag shadow-minimal",
          "focus-within:border-foreground/20",
          isDragOver && "border-[2px] border-dashed border-[#2ecc71] bg-[#2ecc71]/[0.03]",
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          accept={ACCEPT_FILES}
          disabled={disabled}
          onChange={(e) => {
            const list = e.currentTarget.files ? Array.from(e.currentTarget.files) : [];
            if (list.length > 0) addFiles(list);
            e.currentTarget.value = "";
          }}
        />

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1 px-[15px] py-[5px]">
            {attachments.map((file) => {
              const key = fileKey(file);
              const previewUrl = previewUrlsRef.current.get(key);
              return (
                <AttachmentPreviewItem
                  key={key}
                  filename={file.name}
                  mediaType={file.type || "application/octet-stream"}
                  previewUrl={previewUrl}
                  onRemove={() => onRemoveAttachment(file)}
                  className={disabled ? "opacity-70 pointer-events-none" : undefined}
                />
              );
            })}
          </div>
        )}

        <div className="px-[15px] pb-2">
          <Textarea
            ref={inputRef}
            value={value}
            onChange={(e) => onChange(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            onFocus={() => onInputFocus?.()}
            onPaste={(e) => {
              if (disabled) return;
              const files = extractFilesFromClipboard(e);
              if (files.length > 0) {
                addFiles(files);
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={cn(
              "min-h-[36px] max-h-[160px] resize-none",
              "border-0 bg-transparent p-0 shadow-none focus-visible:ring-0",
              "placeholder:text-muted-foreground/70",
            )}
          />
        </div>

        <div className="flex items-center justify-between px-2 py-[5px] h-[40px] gap-4">
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-[30px] rounded-full text-foreground/60 hover:text-foreground"
                  onClick={handleOpenFileDialog}
                  disabled={disabled}
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
                        ? "bg-muted/80 text-muted-foreground ring-1 ring-border/25 opacity-70 cursor-not-allowed"
                        : "bg-accent/88 text-foreground shadow-[0_10px_24px_rgba(15,23,42,0.12)] ring-1 ring-border/25 backdrop-blur-md transition-colors hover:bg-accent hover:text-foreground",
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
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                modelTone === "warning"
                  ? "text-orange-600 hover:text-orange-700 hover:bg-orange-500/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent",
                (!onOpenModelPicker || disabled) && "opacity-60 pointer-events-none",
              )}
              aria-label="Model"
              title="Model"
            >
              {modelProvider ? <ProviderLogo provider={modelProvider} className="size-4" /> : null}
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
                      ? "text-emerald-500 bg-emerald-400/20 hover:bg-emerald-400/30"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent",
                    (disabled || streaming) && "opacity-60 pointer-events-none",
                  )}
                  aria-label="Web search toggle"
                  title="Web search toggle"
                >
                  <Globe className="size-3.5" />
                  <span>联网</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{forceWebSearch ? "联网搜索：已开启" : "联网搜索：已关闭"}</p>
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center gap-1.5">
            {streaming ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-[30px] rounded-full text-destructive hover:bg-destructive/10"
                onClick={onStop}
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
                onClick={onSubmit}
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
