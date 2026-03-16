'use client';

import { useState } from 'react';
import { Copy, Check, Trash2, RefreshCw, Pencil } from 'lucide-react';
import type { AgentEvent } from '@/stores/agentStore';
import { WRAP_TEXT } from '@/components/ui/wrapText';
import { MarkdownMessage } from '@/components/ui/MarkdownMessage';
import { StreamingMarkdownMessage } from '@/components/ui/StreamingMarkdownMessage';
import { IconActionButton } from '@/components/ui/IconActionButton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { MessageAttachments, type MessageAttachmentItem } from '@/components/attachments/MessageAttachments';
import { TypingIndicator } from '@/components/ui/TypingIndicator';

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <IconActionButton onClick={handleCopy} title={copied ? '已复制' : '复制'}>
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
  const [hovered, setHovered] = useState(false);

  if (event.type === 'meta') return null;

  if (event.type === 'user') {
    const attachments = (() => {
      const input = event.toolInput as any;
      const list = input?.attachments;
      if (!Array.isArray(list)) return [];
      return list
        .filter(Boolean)
        .map((it: any) => ({
          id: typeof it.id === 'string' ? it.id : undefined,
          fileName: String(it.fileName || it.file_name || ''),
          fileType: typeof it.fileType === 'string' ? it.fileType : undefined,
          fileSize: typeof it.fileSize === 'number' ? it.fileSize : undefined,
          previewUrl: typeof it.previewUrl === 'string' ? it.previewUrl : undefined,
        }))
        .filter((it: MessageAttachmentItem) => Boolean(it.fileName));
    })();

    return (
      <div
        className={cn('flex w-full flex-col items-end', isNewTurn && 'mt-6')}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="inline-block max-w-[72%] rounded-xl border border-border/50 bg-foreground/[0.06] px-4 py-2">
          {attachments.length > 0 && (
            <MessageAttachments attachments={attachments} />
          )}
          {(event.content || '').trim() ? (
            <p className="text-sm" style={WRAP_TEXT}>{event.content || ''}</p>
          ) : null}
        </div>
        <div className={cn('mt-0.5 flex gap-0.5 transition-opacity duration-150', hovered ? 'opacity-100' : 'opacity-0 pointer-events-none')}>
          {onEdit && (
            <IconActionButton onClick={onEdit} title="编辑">
              <Pencil size={13} />
            </IconActionButton>
          )}
          <CopyAction text={event.content || ''} />
          {onDelete && (
            <IconActionButton onClick={onDelete} title="删除" danger disabled={!event.id}>
              <Trash2 size={13} />
            </IconActionButton>
          )}
        </div>
      </div>
    );
  }

  if (event.type === 'text') {
    const hasText = Boolean((event.content || '').trim());
    const tailLength = isStreaming && hasText ? (event.streamTail || '').length : 0;

    return (
      <div
        className="flex max-w-[92%] flex-col items-start"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {isStreaming && !hasText ? (
          <div className="mt-1 inline-flex items-center">
            <TypingIndicator />
          </div>
        ) : (
          <div className="inline-block max-w-full rounded-xl border border-border/50 bg-background/60 px-4 py-2">
            {isStreaming ? (
              <StreamingMarkdownMessage
                content={event.content || ''}
                tailLength={tailLength}
                pulseKey={event.streamPulseKey ?? 0}
              />
            ) : (
              <div style={WRAP_TEXT}>
                <MarkdownMessage content={event.content || ''} />
              </div>
            )}
          </div>
        )}
        {!isStreaming && (
          <div className={cn('mt-0.5 flex gap-0.5 transition-opacity duration-150', hovered ? 'opacity-100' : 'opacity-0 pointer-events-none')}>
            <CopyAction text={event.content || ''} />
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

  if (event.type === 'tool_start') {
    return (
      <div className="w-full rounded-xl border border-border/50 bg-background/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="secondary">Tool</Badge>
            <span className="truncate text-sm">{event.toolName || 'Unknown tool'}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? 'Collapse' : 'Show input'}
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

  if (event.type === 'tool_result') {
    return (
      <div className="w-full rounded-xl border border-border/50 bg-background/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary">Result</Badge>
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? 'Collapse' : 'Show output'}
          </Button>
        </div>
        {open && (
          <div className="mt-2 rounded-md border border-border/50 bg-muted/20 p-2">
            <p className="text-xs text-muted-foreground mb-1">Output</p>
            <pre className="text-xs font-mono whitespace-pre-wrap break-words" style={WRAP_TEXT}>
              {typeof event.content === 'string'
                ? event.content
                : JSON.stringify(event.content ?? {}, null, 2)}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (event.type === 'error') {
    return (
      <div className="w-full rounded-xl border border-destructive/20 bg-destructive/5 p-3">
        <p className="text-sm text-destructive" style={WRAP_TEXT}>{event.content}</p>
      </div>
    );
  }

  return null;
}
