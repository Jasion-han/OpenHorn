import { Check, Copy, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "ui";
import { getChatLabel } from "../../lib/i18n/agent";
import type { Message } from "../../types/chat";

function IconActionButton({
  title,
  onClick,
  children,
  danger = false,
  disabled = false,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/50 bg-background/70 text-muted-foreground transition-colors",
        disabled
          ? "cursor-not-allowed opacity-40"
          : danger
            ? "hover:border-red-300/70 hover:bg-red-50 hover:text-red-600"
            : "hover:bg-background hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function MessageActionBar({
  message,
  copyValue,
  canEdit,
  canRetry,
  canDelete,
  isStreaming,
  onEdit,
  onRetry,
  onDelete,
}: {
  message: Message;
  copyValue?: string;
  canEdit: boolean;
  canRetry: boolean;
  canDelete: boolean;
  isStreaming: boolean;
  onEdit: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);

  // Clear the pending "copied" reset on unmount so we don't setState on an
  // unmounted component if the user switches conversations within 2s of copying.
  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(copyValue ?? message.content ?? "");
    setCopied(true);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        "mt-0.5 flex gap-0.5 transition-opacity duration-150",
        message.role === "assistant" ? "justify-start" : "justify-end",
        isStreaming
          ? "pointer-events-none opacity-0"
          : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
      )}
    >
      {message.role === "user" && (
        <IconActionButton
          onClick={onEdit}
          title={getChatLabel("chat.action.edit")}
          disabled={!canEdit}
        >
          <Pencil size={13} />
        </IconActionButton>
      )}
      <IconActionButton
        onClick={() => void handleCopy()}
        title={copied ? getChatLabel("chat.action.copied") : getChatLabel("chat.action.copy")}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </IconActionButton>
      {message.role === "assistant" && (
        <IconActionButton
          onClick={onRetry}
          title={getChatLabel("chat.action.regenerate")}
          disabled={!canRetry}
        >
          <RefreshCw size={13} />
        </IconActionButton>
      )}
      <IconActionButton
        onClick={onDelete}
        title={getChatLabel("chat.action.delete")}
        danger
        disabled={!canDelete}
      >
        <Trash2 size={13} />
      </IconActionButton>
    </div>
  );
}
