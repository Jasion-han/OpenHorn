"use client";

import { Check, Copy, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  type MessageAttachmentItem,
  MessageAttachments,
} from "@/components/attachments/MessageAttachments";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconActionButton } from "@/components/ui/IconActionButton";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { StreamingMarkdownMessage } from "@/components/ui/StreamingMarkdownMessage";
import { TypingIndicator } from "@/components/ui/TypingIndicator";
import { WRAP_TEXT } from "@/components/ui/wrapText";
import { cn } from "@/lib/utils";
import type { AgentEvent } from "@/stores/agentStore";

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <IconActionButton onClick={handleCopy} title={copied ? "已复制" : "复制"}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </IconActionButton>
  );
}

export function AgentEventCard({
  event,
  isNewTurn = false,
  onDelete,
  onRetry,
  onEdit,
  isStreaming = false,
}: {
  event: AgentEvent;
  isNewTurn?: boolean;
  onDelete?: () => void;
  onRetry?: () => void;
  onEdit?: () => void;
  isStreaming?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (event.type === "meta") return null;

  if (event.type === "user") {
    const attachments = (() => {
      const toolInput = event.toolInput;
      if (!toolInput || typeof toolInput !== "object") return [];
      const input = toolInput as Record<string, unknown>;
      const list = input.attachments;
      if (!Array.isArray(list)) return [];
      const out: MessageAttachmentItem[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const fileName =
          typeof obj.fileName === "string"
            ? obj.fileName
            : typeof obj.file_name === "string"
              ? obj.file_name
              : "";
        if (!fileName) continue;
        out.push({
          id: typeof obj.id === "string" ? obj.id : undefined,
          fileName,
          fileType: typeof obj.fileType === "string" ? obj.fileType : undefined,
          fileSize: typeof obj.fileSize === "number" ? obj.fileSize : undefined,
          previewUrl: typeof obj.previewUrl === "string" ? obj.previewUrl : undefined,
        });
      }
      return out;
    })();

    return (
      <div className={cn("group flex w-full flex-col items-end", isNewTurn && "mt-6")}>
        <div className="inline-block max-w-[72%] rounded-xl border border-border/50 bg-foreground/[0.06] px-4 py-2">
          {attachments.length > 0 && <MessageAttachments attachments={attachments} />}
          {(event.content || "").trim() ? (
            <p className="text-sm" style={WRAP_TEXT}>
              {event.content || ""}
            </p>
          ) : null}
        </div>
        <div
          className={cn(
            "mt-0.5 flex gap-0.5 transition-opacity duration-150 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto",
          )}
        >
          {onEdit && (
            <IconActionButton onClick={onEdit} title="编辑">
              <Pencil size={13} />
            </IconActionButton>
          )}
          <CopyAction text={event.content || ""} />
          {onDelete && (
            <IconActionButton onClick={onDelete} title="删除" danger disabled={!event.id}>
              <Trash2 size={13} />
            </IconActionButton>
          )}
        </div>
      </div>
    );
  }

  if (event.type === "text") {
    const hasText = Boolean((event.content || "").trim());
    const tailLength = isStreaming && hasText ? (event.streamTail || "").length : 0;

    return (
      <div className="group flex max-w-[92%] flex-col items-start">
        {isStreaming && !hasText ? (
          <div className="mt-1 inline-flex items-center">
            <TypingIndicator />
          </div>
        ) : (
          <div className="inline-block max-w-full rounded-xl border border-border/50 bg-background/60 px-4 py-2">
            {isStreaming ? (
              <StreamingMarkdownMessage
                content={event.content || ""}
                tailLength={tailLength}
                pulseKey={event.streamPulseKey ?? 0}
              />
            ) : (
              <div style={WRAP_TEXT}>
                <MarkdownMessage content={event.content || ""} />
              </div>
            )}
          </div>
        )}
        {!isStreaming && (
          <div
            className={cn(
              "mt-0.5 flex gap-0.5 transition-opacity duration-150 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto",
            )}
          >
            <CopyAction text={event.content || ""} />
            <IconActionButton onClick={onRetry || (() => {})} title="重试" disabled={!onRetry}>
              <RefreshCw size={13} />
            </IconActionButton>
            {onDelete && (
              <IconActionButton onClick={onDelete} title="删除" danger disabled={!event.id}>
                <Trash2 size={13} />
              </IconActionButton>
            )}
          </div>
        )}
      </div>
    );
  }

  if (event.type === "tool_start") {
    return (
      <div className="w-full rounded-xl border border-border/50 bg-background/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="secondary">Tool</Badge>
            <span className="truncate text-sm">{event.toolName || "Unknown tool"}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Collapse" : "Show input"}
          </Button>
        </div>
        {open && (
          <div className="mt-2 rounded-md border border-border/50 bg-muted/20 p-2">
            <p className="text-xs text-muted-foreground mb-1">Input</p>
            <pre className="text-xs font-mono whitespace-pre-wrap break-words" style={WRAP_TEXT}>
              {JSON.stringify(event.toolInput ?? {}, null, 2)}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (event.type === "tool_result") {
    return (
      <div className="w-full rounded-xl border border-border/50 bg-background/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary">Result</Badge>
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Collapse" : "Show output"}
          </Button>
        </div>
        {open && (
          <div className="mt-2 rounded-md border border-border/50 bg-muted/20 p-2">
            <p className="text-xs text-muted-foreground mb-1">Output</p>
            <pre className="text-xs font-mono whitespace-pre-wrap break-words" style={WRAP_TEXT}>
              {typeof event.content === "string"
                ? event.content
                : JSON.stringify(event.content ?? {}, null, 2)}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (event.type === "error") {
    return (
      <div className="w-full rounded-xl border border-destructive/20 bg-destructive/5 p-3">
        <p className="text-sm text-destructive" style={WRAP_TEXT}>
          {event.content}
        </p>
      </div>
    );
  }

  return null;
}
