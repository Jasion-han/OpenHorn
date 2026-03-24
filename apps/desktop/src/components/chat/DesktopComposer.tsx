import { Bot, ChevronDown, CornerDownLeft, Globe, MessageSquare, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Textarea, cn } from "ui";
import { useChatStore } from "../../stores/chatStore";
import type { ChatMode } from "../../types/chat";
import { DesktopProviderLogo } from "./DesktopProviderLogo";

export function DesktopComposer({
  disabled,
  onSubmit,
  modelProvider,
  modelLabel,
  modelTone = "normal",
  onOpenModelPicker,
  forceWebSearch,
  onToggleWebSearch,
}: {
  disabled: boolean;
  onSubmit: (content: string) => Promise<void>;
  modelProvider?: string | null;
  modelLabel?: string | null;
  modelTone?: "normal" | "warning";
  onOpenModelPicker?: () => void;
  forceWebSearch: boolean;
  onToggleWebSearch: () => void;
}) {
  const composerMode = useChatStore((state) => state.composerMode);
  const setComposerMode = useChatStore((state) => state.setComposerMode);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const abortStreaming = useChatStore((state) => state.abortStreaming);
  const [value, setValue] = useState("");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);

  const canSubmit = !disabled && !isStreaming && value.trim().length > 0;

  const handleSubmit = async () => {
    const next = value.trim();
    if (!next) return;
    setValue("");
    await onSubmit(next);
  };

  const modeDisabled = disabled || isStreaming;
  const alternateMode: ChatMode = composerMode === "chat" ? "agent" : "chat";

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
    <div className="px-4 pb-4 pt-2">
      <div className="rounded-[17px] border-[0.5px] border-border bg-background/70 pt-2 shadow-minimal backdrop-blur-sm transition-all duration-200 focus-within:border-foreground/20">
        <div className="px-[15px] pb-2">
          <Textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={
              disabled ? "请先在左侧创建或选择一个会话" : "输入你的问题，聊天与 Agent 在这里切换"
            }
            rows={1}
            className="min-h-[36px] max-h-[160px] resize-none border-0 bg-transparent p-0 shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0"
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
            <div ref={modeMenuRef} className="relative inline-flex flex-col items-center">
              {modeMenuOpen && !modeDisabled && (
                <div className="pointer-events-none absolute bottom-full left-0 right-0 z-20 mb-1 flex justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      setComposerMode(alternateMode);
                      setModeMenuOpen(false);
                    }}
                    className="pointer-events-auto flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-accent/88 px-2.5 py-1 text-xs text-foreground shadow-[0_10px_24px_rgba(15,23,42,0.12)] ring-1 ring-border/25 backdrop-blur-md transition-colors hover:bg-accent"
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
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  modeDisabled && "pointer-events-none opacity-60",
                )}
                aria-label="Mode"
                title="Mode"
              >
                {composerMode === "agent" ? <Bot size={12} /> : <MessageSquare size={12} />}
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
                  ? "text-orange-600 hover:bg-orange-500/10 hover:text-orange-700"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
                (!onOpenModelPicker || disabled) && "pointer-events-none opacity-60",
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
              disabled={disabled || isStreaming}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                forceWebSearch
                  ? "bg-emerald-400/20 text-emerald-500 hover:bg-emerald-400/30"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
                (disabled || isStreaming) && "pointer-events-none opacity-60",
              )}
              aria-label="Allow web search"
              title={forceWebSearch ? "需要最新信息时允许联网：已开启" : "需要最新信息时允许联网：已关闭"}
            >
              <Globe className="size-3.5" />
              <span>允许联网</span>
            </button>

            <div className="inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <CornerDownLeft size={12} />
              <span>Enter 发送</span>
            </div>
          </div>

          {isStreaming ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-[30px] rounded-full text-destructive hover:bg-destructive/10"
              onClick={() => abortStreaming()}
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
                canSubmit ? "text-primary hover:bg-primary/10" : "cursor-not-allowed text-foreground/30",
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
  );
}
