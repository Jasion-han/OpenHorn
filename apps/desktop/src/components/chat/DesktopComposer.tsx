import { Bot, CornerDownLeft, MessageSquare, SendHorizontal, Square } from "lucide-react";
import { useState } from "react";
import { Button, Textarea, cn } from "ui";
import { useChatStore } from "../../stores/chatStore";
import type { ChatMode } from "../../types/chat";

export function DesktopComposer({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (content: string) => Promise<void>;
}) {
  const composerMode = useChatStore((state) => state.composerMode);
  const setComposerMode = useChatStore((state) => state.setComposerMode);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const abortStreaming = useChatStore((state) => state.abortStreaming);
  const [value, setValue] = useState("");

  const canSubmit = !disabled && !isStreaming && value.trim().length > 0;

  const handleSubmit = async () => {
    const next = value.trim();
    if (!next) return;
    setValue("");
    await onSubmit(next);
  };

  const renderModeButton = (mode: ChatMode) => {
    const active = composerMode === mode;
    return (
      <button
        key={mode}
        type="button"
        onClick={() => setComposerMode(mode)}
        className={cn(
          "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs transition-colors",
          active
            ? "bg-foreground text-background"
            : "bg-muted text-muted-foreground hover:text-foreground",
        )}
      >
        {mode === "agent" ? <Bot size={12} /> : <MessageSquare size={12} />}
        {mode === "agent" ? "Agent" : "Chat"}
      </button>
    );
  };

  return (
    <div className="border-t border-border/50 px-4 py-4">
      <div className="rounded-[17px] border border-border/60 bg-background/85 p-3 shadow-sm backdrop-blur-sm">
        <div className="mb-3 flex items-center gap-2">
          <div className="inline-flex rounded-full bg-muted/80 p-1">
            {(["chat", "agent"] as const).map(renderModeButton)}
          </div>
        </div>

        <Textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={
            disabled ? "请先在左侧创建或选择一个会话" : "输入你的问题，聊天与 Agent 在这里切换"
          }
          rows={1}
          className="min-h-[36px] max-h-[160px] resize-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              if (!canSubmit) return;
              void handleSubmit();
            }
          }}
        />

        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <CornerDownLeft size={12} />
            <span>Ctrl/Cmd + Enter 发送</span>
          </div>

          {isStreaming ? (
            <Button variant="outline" onClick={() => abortStreaming()}>
              <Square size={14} className="fill-current" />
              停止
            </Button>
          ) : (
            <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
              <SendHorizontal size={16} />
              发送
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
