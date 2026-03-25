import { ChevronDown, CornerDownLeft, Globe, Paperclip, Square } from "lucide-react";
import type { ClipboardEvent, DragEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Button, Textarea, cn } from "ui";
import { useChatStore } from "../../stores/chatStore";
import type { ChatMode } from "../../types/chat";
import { DesktopAttachmentPreviewItem } from "./DesktopAttachmentPreviewItem";
import { DesktopProviderLogo } from "./DesktopProviderLogo";

const ACCEPT_FILES = "image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown";
const PLACEHOLDERS = [
  "Start with a spark — I will shape the rest.",
  "What should we build, refine, or rethink today?",
  "Drop a thought. I will turn it into something real.",
  "Give me a direction, I will find the path.",
  "Ask anything. Then push it one level deeper.",
  "Sketch the idea. I will fill in the lines.",
  "Let us turn a question into a plan.",
  "Pitch the headline. I will write the story.",
  "Take the blank page. I will bring the motion.",
  "Name the problem. I will cut through it.",
  "Start messy. End elegant.",
  "One prompt away from clarity.",
  "Tell me the goal, I will map the route.",
  "What would you love to ship this week?",
  "Let us turn curiosity into momentum.",
  "If you can imagine it, we can draft it.",
  "Give me the vibe. I will deliver the words.",
  "Turn a rough idea into a sharp answer.",
  "Ask for bold. I will keep it grounded.",
  "What do you wish existed right now?",
  "We can brainstorm or go straight to done.",
  "Write less. Say more.",
  "A single line can unlock the whole plan.",
  "Let us design the next move.",
  "Bring the question. Leave with the output.",
  "Make it clear, make it quick, make it real.",
  "Want a first draft that actually works?",
  "Turn complexity into clean steps.",
  "Take a breath — then type the dream.",
  "If it matters, put it here.",
];

function pickPlaceholder(avoid?: string) {
  if (PLACEHOLDERS.length === 0) return "";
  if (PLACEHOLDERS.length === 1) return PLACEHOLDERS[0] ?? "";
  let next = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)] ?? "";
  if (avoid && PLACEHOLDERS.length > 1) {
    let tries = 0;
    while (next === avoid && tries < 4) {
      next = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)] ?? next;
      tries += 1;
    }
  }
  return next;
}

function fileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function DesktopComposer({
  attachments,
  disabled,
  busy = false,
  submitBlocked = false,
  onAddAttachments,
  onRemoveAttachment,
  onSubmit,
  conversationId,
  modelProvider,
  modelLabel,
  modelTone = "normal",
  onOpenModelPicker,
  forceWebSearch,
  onToggleWebSearch,
  onStop,
  agentModeAvailable = true,
  agentModeDisabledReason,
}: {
  attachments: File[];
  disabled: boolean;
  busy?: boolean;
  submitBlocked?: boolean;
  onAddAttachments: (files: File[]) => void;
  onRemoveAttachment: (file: File) => void;
  onSubmit: (content: string, files: File[]) => Promise<void>;
  conversationId?: string | null;
  modelProvider?: string | null;
  modelLabel?: string | null;
  modelTone?: "normal" | "warning";
  onOpenModelPicker?: () => void;
  forceWebSearch: boolean;
  onToggleWebSearch: () => void;
  onStop?: () => void | Promise<void>;
  agentModeAvailable?: boolean;
  agentModeDisabledReason?: string | null;
}) {
  const composerMode = useChatStore((state) => state.composerMode);
  const setComposerMode = useChatStore((state) => state.setComposerMode);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const abortStreaming = useChatStore((state) => state.abortStreaming);
  const [value, setValue] = useState("");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [placeholder, setPlaceholder] = useState(() => pickPlaceholder());
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isBusy = busy || isStreaming;
  const canSubmit =
    !disabled &&
    !isBusy &&
    !submitBlocked &&
    (value.trim().length > 0 || attachments.length > 0);

  const handleSubmit = async () => {
    const next = value.trim();
    if (!next && attachments.length === 0) return;
    await onSubmit(next, attachments);
    setValue("");
  };

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
    if (disabled || isBusy || !Array.from(event.dataTransfer.types).includes("Files")) {
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
    if (disabled || isBusy) return;
    event.preventDefault();
    setDragActive(false);
    handleAppendAttachments(event.dataTransfer.files);
  };

  const modeDisabled = disabled || isBusy;
  const alternateMode: ChatMode = composerMode === "chat" ? "agent" : "chat";
  const alternateModeDisabled = alternateMode === "agent" && !agentModeAvailable;

  useEffect(() => {
    setPlaceholder((prev) => pickPlaceholder(prev));
  }, [conversationId]);

  useEffect(() => {
    if (!value.trim()) {
      setPlaceholder((prev) => pickPlaceholder(prev));
    }
  }, [value]);

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
            disabled={disabled || isBusy}
            onChange={(event) => setValue(event.target.value)}
            onPaste={handlePaste}
            onFocus={() => {
              if (!value.trim()) {
                setPlaceholder((prev) => pickPlaceholder(prev));
              }
            }}
            placeholder={
              disabled
                ? "请先在左侧创建或选择一个会话"
                : isBusy
                  ? "正在处理，请稍候"
                : attachments.length > 0
                  ? "可继续输入文本，或直接发送附件"
                  : placeholder
            }
            rows={1}
            className="min-h-[36px] max-h-[160px] resize-none border-0 bg-transparent p-0 shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 disabled:cursor-default disabled:opacity-100"
            onKeyDown={(event) => {
              const nativeEvent = event.nativeEvent;
              const keyCode =
                "keyCode" in nativeEvent ? (nativeEvent.keyCode as number | undefined) : undefined;

              if (nativeEvent.isComposing || keyCode === 229) {
                return;
              }

              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!canSubmit) return;
                void handleSubmit();
              }
            }}
          />
        </div>

        <div className="flex h-[40px] items-center justify-between gap-4 px-2 py-[5px]">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || isBusy}
              className={cn(
                "inline-flex size-[30px] items-center justify-center rounded-full text-foreground/60 transition-colors hover:text-foreground hover:bg-accent",
                (disabled || isBusy) && "pointer-events-none opacity-60",
              )}
              aria-label="Attach"
              title="Attach"
            >
              <Paperclip className="size-5" />
            </button>

            <div ref={modeMenuRef} className="relative inline-flex flex-col items-center">
              {modeMenuOpen && !modeDisabled && (
                <div className="pointer-events-none absolute bottom-full left-0 right-0 z-20 mb-1 flex justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      if (alternateModeDisabled) return;
                      setComposerMode(alternateMode);
                      setModeMenuOpen(false);
                    }}
                    disabled={alternateModeDisabled}
                    className={cn(
                      "pointer-events-auto flex w-full items-center justify-center gap-1.5 rounded-[10px] px-2.5 py-1 text-xs",
                      alternateModeDisabled
                        ? "cursor-not-allowed bg-muted/80 text-muted-foreground opacity-70 ring-1 ring-border/25"
                        : "bg-accent/88 text-foreground shadow-[0_10px_24px_rgba(15,23,42,0.12)] ring-1 ring-border/25 backdrop-blur-md transition-colors hover:bg-accent",
                    )}
                    title={alternateModeDisabled ? (agentModeDisabledReason ?? "当前不可用") : undefined}
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
                <span className="truncate">{composerMode === "chat" ? "Chat" : "Agent"}</span>
                <ChevronDown className={cn("size-3 transition-transform", modeMenuOpen && "rotate-180")} />
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
              {modelProvider ? <DesktopProviderLogo provider={modelProvider} className="size-4" /> : null}
              <span className="max-w-[220px] truncate">{modelLabel || "选择模型"}</span>
              <ChevronDown className="size-3" />
            </button>

            <button
              type="button"
              onClick={onToggleWebSearch}
              disabled={disabled || isBusy}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                forceWebSearch
                  ? "text-emerald-500 bg-emerald-400/20 hover:bg-emerald-400/30"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent",
                (disabled || isBusy) && "opacity-60 pointer-events-none",
              )}
              aria-label="Allow web search"
              title={forceWebSearch ? "需要最新信息时允许联网：已开启" : "需要最新信息时允许联网：已关闭"}
            >
              <Globe className="size-3.5" />
              <span>允许联网</span>
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {isStreaming ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-[30px] rounded-full text-destructive hover:bg-destructive/10"
                onClick={() => {
                  if (onStop) {
                    void onStop();
                    return;
                  }
                  abortStreaming();
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
                  canSubmit ? "text-primary hover:bg-primary/10" : "text-foreground/30 cursor-not-allowed",
                )}
                onClick={() => void handleSubmit()}
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
