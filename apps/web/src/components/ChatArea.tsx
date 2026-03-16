'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, Copy, MessageSquare, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { api, type ApiAgentRun, type ApiCitation, type ApiLiveRoute, type ApiLiveStatus } from '../lib/api';
import { uploadAttachments } from '../lib/attachments';
import { streamChatMessage } from '../lib/chat-stream';
import { useChatStore } from '../stores/chatStore';
import { notifyWarning } from '../lib/notify';
import { getEffectiveModelForConversation } from '@/lib/effective-model';
import { PromaComposer } from '@/components/composer/PromaComposer';
import { ModelPickerModal } from '@/components/chat/ModelPickerModal';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { MessageAttachments, type MessageAttachmentItem } from '@/components/attachments/MessageAttachments';
import { Button } from '@/components/ui/button';
import { IconActionButton } from '@/components/ui/IconActionButton';
import { MarkdownMessage } from '@/components/ui/MarkdownMessage';
import { StreamingMarkdownMessage } from '@/components/ui/StreamingMarkdownMessage';
import { Textarea } from '@/components/ui/textarea';
import { TypingIndicator } from '@/components/ui/TypingIndicator';
import { WRAP_TEXT } from '@/components/ui/wrapText';
import { createTextStreamSmoother, type TextStreamSmoother } from '@/lib/textStreamSmoother';
import { cn } from '@/lib/utils';

const PAGE_PAD = '16px';
const COMPOSER_PAD_BOTTOM = 'env(safe-area-inset-bottom, 0px)';

function AgentRunPanel({ run }: { run?: ApiAgentRun }) {
  if (!run) return null;

  return (
    <details className="mt-2 rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">{run.summary || 'Agent 执行记录'}</span>
          <span className="text-xs text-muted-foreground">{run.status}</span>
        </div>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {run.error && (
          <div className="rounded-md border border-orange-200 bg-orange-50 px-2 py-1.5 text-xs text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300">
            {run.error}
          </div>
        )}
        {run.steps.length === 0 ? (
          <p className="text-xs text-muted-foreground">无额外执行步骤。</p>
        ) : (
          run.steps.map((step, index) => (
            <div key={`${step.type}-${index}`} className="rounded-md border border-border/50 bg-background/60 px-2 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{step.type}</p>
                {step.toolName && <p className="text-xs text-muted-foreground">{step.toolName}</p>}
              </div>
              {step.content && (
                <p className="mt-1 text-sm" style={WRAP_TEXT}>{step.content}</p>
              )}
              {step.toolInput !== undefined && (
                <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-xs" style={WRAP_TEXT}>
                  {JSON.stringify(step.toolInput, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </details>
  );
}

function LiveStatusBadge({
  status,
  route,
  label,
}: {
  status?: ApiLiveStatus;
  route?: ApiLiveRoute;
  label?: string;
}) {
  if (!label) return null;

  const routeLabel = (() => {
    switch (route) {
      case 'local':
        return '本地';
      case 'structured_live':
        return '天气';
      case 'web_search':
        return '搜索';
      case 'research':
        return '调研';
      default:
        return '直答';
    }
  })();

  return (
    <div
      className={cn(
        'mb-2 inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium',
        status === 'live'
          ? 'border-emerald-300/60 bg-emerald-50 text-emerald-700 dark:border-emerald-700/70 dark:bg-emerald-950/50 dark:text-emerald-300'
          : 'border-amber-300/60 bg-amber-50 text-amber-700 dark:border-amber-700/70 dark:bg-amber-950/50 dark:text-amber-300'
      )}
    >
      <span className="rounded-full bg-black/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide dark:bg-white/10">{routeLabel}</span>
      <span>{label}</span>
    </div>
  );
}

function CitationList({ citations }: { citations?: ApiCitation[] }) {
  if (!citations || citations.length === 0) return null;

  return (
    <details className="group mb-2 rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm">
      <summary className="cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sources</span>
            <span className="text-[11px] text-muted-foreground/80">· {citations.length}</span>
          </div>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-150 group-open:rotate-180" />
        </div>
      </summary>

      <div className="mt-2 flex flex-col gap-1.5">
        {citations.map((citation, index) => (
          <a
            key={`${citation.url}-${index}`}
            href={citation.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-border/40 bg-background/70 px-2 py-1.5 text-xs transition-colors hover:bg-background"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-[10px] font-medium text-muted-foreground">[{index + 1}]</span>
              <div className="min-w-0 flex-1 font-medium text-foreground">{citation.title}</div>
            </div>
            <div className="truncate text-muted-foreground">{citation.url}</div>
            {citation.snippet && (
              <div className="mt-0.5 line-clamp-2 text-muted-foreground">{citation.snippet}</div>
            )}
          </a>
        ))}
      </div>
    </details>
  );
}

function MessageBubble({
  msg,
  isStreaming,
  canEdit,
  canRetry,
  onEdit,
  onRetry,
  onDelete,
  attachments,
  assistantWidth,
  userMaxWidth,
}: {
  msg: {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    mode: 'chat' | 'agent';
    agentRun?: ApiAgentRun;
    liveStatus?: ApiLiveStatus;
    liveRoute?: ApiLiveRoute;
    liveLabel?: string;
    citations?: ApiCitation[];
    streamTail?: string;
    streamPulseKey?: number;
  };
  isStreaming: boolean;
  canEdit: boolean;
  canRetry: boolean;
  onEdit: () => void;
  onRetry: () => void;
  onDelete: () => void;
  attachments?: MessageAttachmentItem[];
  assistantWidth: string;
  userMaxWidth: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isAssistant = msg.role === 'assistant';
  const hasAssistantText = isAssistant && Boolean((msg.content || '').trim());
  const isAssistantPlaceholder = isAssistant && isStreaming && !hasAssistantText;
  const isAgent = msg.mode === 'agent';
  const streamTailLength = isAssistant && isStreaming && hasAssistantText ? (msg.streamTail || '').length : 0;

  return (
    <div
      className={cn('flex flex-col', isAssistant ? 'items-start self-start' : 'items-end self-end')}
      style={{ maxWidth: isAssistant ? assistantWidth : userMaxWidth }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={cn(
          'inline-block max-w-full',
          isAssistantPlaceholder ? 'border-0 bg-transparent px-0 py-0' : 'rounded-2xl px-4 py-2',
          isAssistant
            ? (isAssistantPlaceholder ? '' : 'border border-border/50 bg-background/60')
            : 'border border-border/50 bg-foreground/[0.06]'
        )}
      >
        <div className={cn('mb-1 inline-flex items-center gap-1 text-[11px] font-medium', isAssistant ? 'text-muted-foreground' : 'text-foreground/60')}>
          {isAgent ? <Bot size={12} /> : <MessageSquare size={12} />}
          <span>{isAgent ? 'Agent' : 'Chat'}</span>
        </div>

        {!isAssistant && attachments && attachments.length > 0 && (
          <MessageAttachments attachments={attachments} />
        )}

        {isAssistant ? (
          <div style={WRAP_TEXT}>
            <LiveStatusBadge
              status={msg.liveStatus}
              route={msg.liveRoute}
              label={msg.liveLabel}
            />
            <CitationList citations={msg.citations} />
            {hasAssistantText ? (
              isStreaming ? (
                <StreamingMarkdownMessage
                  content={msg.content}
                  tailLength={streamTailLength}
                  pulseKey={msg.streamPulseKey ?? 0}
                />
              ) : (
                <MarkdownMessage content={msg.content} />
              )
            ) : isStreaming ? (
              <TypingIndicator className="ml-1" />
            ) : null}
          </div>
        ) : (
          msg.content?.trim() ? <p className="text-sm" style={WRAP_TEXT}>{msg.content}</p> : null
        )}

        {isAssistant && <AgentRunPanel run={msg.agentRun} />}
      </div>
      <div
        className={cn(
          'mt-0.5 flex gap-0.5 transition-opacity duration-150',
          isAssistant ? 'justify-start' : 'justify-end',
          hovered && !isStreaming ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        )}
      >
        {!isAssistant && canEdit && (
          <IconActionButton onClick={onEdit} title="编辑">
            <Pencil size={13} />
          </IconActionButton>
        )}
        <IconActionButton onClick={handleCopy} title={copied ? '已复制' : '复制'}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </IconActionButton>
        {isAssistant && (
          <IconActionButton onClick={onRetry} title="重新生成" disabled={!canRetry}>
            <RefreshCw size={13} />
          </IconActionButton>
        )}
        <IconActionButton onClick={onDelete} title="删除" danger>
          <Trash2 size={13} />
        </IconActionButton>
      </div>
    </div>
  );
}

export function ChatArea() {
  const {
    currentConversation,
    messages,
    isLoading,
    isStreaming,
    addMessage,
    appendMessageDelta,
    loadMessages,
    setIsLoading,
    setIsStreaming,
    channels,
    updateConversation,
    deleteMessage,
    composerMode,
    setComposerMode,
  } = useChatStore();

  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const textSmootherRef = useRef<TextStreamSmoother | null>(null);
  const pendingPreviewUrlsRef = useRef<Map<string, string[]>>(new Map());
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);

  const ASSISTANT_BUBBLE_WIDTH = '92%';
  const USER_BUBBLE_MAX_WIDTH = '72%';

  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTo({ top: viewportRef.current.scrollHeight });
    }
  }, [messages]);

  useEffect(() => {
    setStreamingAssistantId(null);
  }, [currentConversation?.id]);

  useEffect(() => {
    return () => {
      for (const urls of pendingPreviewUrlsRef.current.values()) {
        for (const url of urls) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore
          }
        }
      }
      pendingPreviewUrlsRef.current.clear();
    };
  }, [currentConversation?.id]);

  const effective = getEffectiveModelForConversation(channels, currentConversation);
  const hasInput = Boolean(input.trim());
  const hasFiles = files.length > 0;
  const forceWebSearch = currentConversation?.forceWebSearch ?? true;
  const canSend =
    effective.ok &&
    Boolean(currentConversation) &&
    !isLoading &&
    !isStreaming &&
    !isUploading &&
    (hasInput || hasFiles);

  const handleToggleWebSearch = async () => {
    if (!currentConversation) return;
    const next = !forceWebSearch;
    updateConversation(currentConversation.id, { forceWebSearch: next });
    if (next) {
      try {
        const status = await api.settings.searchStatus();
        if (!status.configured || status.source === 'none') {
          notifyWarning('未配置实时搜索', '未检测到 Tavily Key，联网搜索可能无法使用。请在设置中填写或配置服务端 TAVILY_API_KEY。');
        } else if (status.source === 'disabled') {
          notifyWarning('实时搜索已关闭', '在设置中启用 Tavily 搜索后才能联网。');
        }
      } catch {
        // ignore
      }
    }
    try {
      await api.conversations.update(currentConversation.id, { forceWebSearch: next });
    } catch {
      updateConversation(currentConversation.id, { forceWebSearch });
    }
  };

  const handleStop = async () => {
    try {
      streamAbortRef.current?.abort();
    } catch {
      // ignore
    }
    streamAbortRef.current = null;
    textSmootherRef.current?.cancel({ flush: true });
    textSmootherRef.current = null;
    setIsLoading(false);
    setIsStreaming(false);
    setStreamingAssistantId(null);
    if (currentConversation) {
      try {
        await loadMessages(currentConversation.id);
      } catch {
        // ignore
      }
    }
    queueMicrotask(() => inputRef.current?.focus());
  };

  const handleSend = async () => {
    if (!canSend || !currentConversation) return;

    const conversationId = currentConversation.id;
    const mode = composerMode;

    const trimmed = input.trim();
    const effectiveContent = trimmed.length > 0 ? trimmed : '';
    const autoTitleSeed = trimmed.length > 0
      ? trimmed
      : files.length > 0
        ? `Attachments: ${files.map((file) => file.name).join(', ')}`
        : '';

    const previewUrls: string[] = [];
    const localAttachmentMeta: MessageAttachmentItem[] = files.map((file) => {
      const previewUrl = file.type?.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      if (previewUrl) previewUrls.push(previewUrl);
      return {
        fileName: file.name,
        fileType: file.type || undefined,
        fileSize: file.size,
        previewUrl,
      };
    });

    const userMessageId = `temp-${Date.now()}`;
    if (previewUrls.length > 0) {
      pendingPreviewUrlsRef.current.set(userMessageId, previewUrls);
    }

    addMessage({
      id: userMessageId,
      conversationId,
      role: 'user',
      content: effectiveContent,
      mode,
      attachmentsMeta: localAttachmentMeta.length > 0 ? localAttachmentMeta : undefined,
      createdAt: new Date(),
    });

    const assistantMessageId = `temp-assistant-${Date.now()}`;
    let agentRunBuffer: ApiAgentRun | undefined = mode === 'agent'
      ? { status: 'partial', summary: 'Agent 正在执行', steps: [] }
      : undefined;

    addMessage({
      id: assistantMessageId,
      conversationId,
      role: 'assistant',
      content: '',
      mode,
      agentRun: agentRunBuffer,
      createdAt: new Date(),
    });

    setInput('');
    queueMicrotask(() => inputRef.current?.focus());
    setIsLoading(true);
    setIsStreaming(true);
    setStreamingAssistantId(assistantMessageId);

    try {
      try {
        streamAbortRef.current?.abort();
      } catch {
        // ignore
      }
      const abortController = new AbortController();
      streamAbortRef.current = abortController;

      let assistantContent = '';
      const smoother = createTextStreamSmoother({
        emit: (delta) => {
          assistantContent += delta;
          appendMessageDelta(assistantMessageId, delta, {
            agentRun: agentRunBuffer,
          });
        },
      });
      textSmootherRef.current = smoother;
      let postStream: Promise<void> | null = null;

      let attachmentIds: string[] = [];
      if (files.length > 0) {
        setIsUploading(true);
        const upload = await uploadAttachments({ conversationId, files });
        attachmentIds = upload.attachments.map((attachment) => attachment.id);
        setFiles([]);
      }

      const payload = {
        conversationId,
        content: effectiveContent,
        attachments: attachmentIds,
        mode,
      };

      const response = await api.messages.stream(payload, { signal: abortController.signal });

      await streamChatMessage(
        payload,
        {
          onLiveStatus: (event) => {
            useChatStore.getState().updateMessage(assistantMessageId, assistantContent, {
              liveStatus: event.status,
              liveRoute: event.route,
              liveLabel: event.label,
              agentRun: agentRunBuffer,
            });
          },
          onCitations: (event) => {
            useChatStore.getState().updateMessage(assistantMessageId, assistantContent, {
              citations: event.citations,
              agentRun: agentRunBuffer,
            });
          },
          onDelta: (chunk) => {
            if (!chunk) return;
            smoother.push(chunk);
          },
          onAgentEvent: (event) => {
            if (mode !== 'agent') return;
            if (!agentRunBuffer) {
              agentRunBuffer = { status: 'partial', summary: 'Agent 正在执行', steps: [] };
            }
            if (event.type === 'tool_start' || event.type === 'tool_result') {
              agentRunBuffer = {
                ...agentRunBuffer,
                summary: 'Agent 正在执行',
                steps: [
                  ...agentRunBuffer.steps,
                  {
                    type: event.type,
                    toolName: event.toolName,
                    content: event.content,
                    toolInput: event.toolInput,
                  },
                ],
              };
            }
            if (event.type === 'error') {
              agentRunBuffer = {
                ...agentRunBuffer,
                status: 'failed',
                summary: 'Agent 执行失败',
                error: event.content || 'Agent error',
                steps: [
                  ...agentRunBuffer.steps,
                  { type: 'error', content: event.content || 'Agent error' },
                ],
              };
            }
            useChatStore.getState().updateMessage(assistantMessageId, assistantContent, { agentRun: agentRunBuffer });
          },
          onDone: async (event) => {
            postStream = (async () => {
              if (mode === 'agent' && event.agentRun) {
                agentRunBuffer = event.agentRun;
                useChatStore.getState().updateMessage(assistantMessageId, assistantContent, { agentRun: agentRunBuffer });
              }
              await smoother.finish();
              await loadMessages(conversationId);
              const urls = pendingPreviewUrlsRef.current.get(userMessageId);
              if (urls) {
                for (const url of urls) {
                  try {
                    URL.revokeObjectURL(url);
                  } catch {
                    // ignore
                  }
                }
                pendingPreviewUrlsRef.current.delete(userMessageId);
              }
              const conv = useChatStore.getState().currentConversation;
              if (conv && /^新会话 \d{2}-\d{2} \d{2}:\d{2}$/.test(conv.title)) {
                if (!autoTitleSeed) return;
                void api.conversations.autoTitle(conversationId, autoTitleSeed).then((result) => {
                  if (result.success && result.title) {
                    updateConversation(conversationId, { title: result.title });
                  }
                }).catch(() => {});
              }
            })();
          },
          onError: (message) => {
            postStream = (async () => {
              smoother.cancel({ flush: true });
              if (mode === 'agent') {
                agentRunBuffer = {
                  status: 'failed',
                  summary: 'Agent 执行失败',
                  error: message,
                  steps: agentRunBuffer?.steps || [],
                };
              }
              useChatStore.getState().updateMessage(assistantMessageId, `Error: ${message}`, {
                agentRun: agentRunBuffer,
              });
            })();
          },
        },
        response
      );

      if (postStream) {
        await postStream;
      } else {
        await smoother.finish();
        await loadMessages(conversationId);
      }
    } catch (error) {
      if ((streamAbortRef.current as any)?.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return;
      }
      useChatStore.getState().updateMessage(
        assistantMessageId,
        `Error: ${error instanceof Error ? error.message : 'Failed to send message'}`,
        mode === 'agent'
          ? {
              agentRun: {
                status: 'failed',
                summary: 'Agent 执行失败',
                error: error instanceof Error ? error.message : 'Failed to send message',
                steps: agentRunBuffer?.steps || [],
              },
            }
          : undefined
      );
    } finally {
      setIsUploading(false);
      setIsLoading(false);
      setIsStreaming(false);
      setStreamingAssistantId(null);
      textSmootherRef.current?.cancel({ flush: true });
      textSmootherRef.current = null;
      streamAbortRef.current = null;
      queueMicrotask(() => inputRef.current?.focus());
    }
  };

  const handleRetry = async (msgIndex: number) => {
    if (!currentConversation) return;
    const assistantMsg = messages[msgIndex];
    if (!assistantMsg || assistantMsg.role !== 'assistant') return;
    if (assistantMsg.id.startsWith('temp-')) return;

    let agentRunBuffer: ApiAgentRun | undefined = assistantMsg.mode === 'agent'
      ? { status: 'partial', summary: 'Agent 正在执行', steps: [] }
      : undefined;

    useChatStore.getState().updateMessage(
      assistantMsg.id,
      '',
      {
        streamTail: undefined,
        streamPulseKey: 0,
        liveStatus: undefined,
        liveRoute: undefined,
        liveLabel: undefined,
        citations: undefined,
        agentRun: agentRunBuffer,
      }
    );
    setIsLoading(true);
    setIsStreaming(true);
    setStreamingAssistantId(assistantMsg.id);

    try {
      try {
        streamAbortRef.current?.abort();
      } catch {
        // ignore
      }
      const abortController = new AbortController();
      streamAbortRef.current = abortController;

      const smoother = createTextStreamSmoother({
        emit: (delta) => {
          appendMessageDelta(assistantMsg.id, delta);
        },
      });
      textSmootherRef.current = smoother;
      let postStream: Promise<void> | null = null;

      const response = await api.messages.regenerate(assistantMsg.id, { signal: abortController.signal });
      if (!response.ok) throw new Error(await response.text().catch(() => 'Failed'));

      await streamChatMessage(
        { conversationId: currentConversation.id, content: '' },
        {
          onLiveStatus: (event) => {
            useChatStore.getState().updateMessage(
              assistantMsg.id,
              useChatStore.getState().messages.find((m) => m.id === assistantMsg.id)?.content || '',
              {
                liveStatus: event.status,
                liveRoute: event.route,
                liveLabel: event.label,
                agentRun: agentRunBuffer,
              }
            );
          },
          onCitations: (event) => {
            useChatStore.getState().updateMessage(
              assistantMsg.id,
              useChatStore.getState().messages.find((m) => m.id === assistantMsg.id)?.content || '',
              {
                citations: event.citations,
                agentRun: agentRunBuffer,
              }
            );
          },
          onDelta: (chunk) => {
            if (!chunk) return;
            smoother.push(chunk);
          },
          onAgentEvent: (event) => {
            if (assistantMsg.mode !== 'agent') return;
            if (!agentRunBuffer) {
              agentRunBuffer = { status: 'partial', summary: 'Agent 正在执行', steps: [] };
            }
            if (event.type === 'tool_start' || event.type === 'tool_result') {
              agentRunBuffer = {
                ...agentRunBuffer,
                summary: 'Agent 正在执行',
                steps: [
                  ...agentRunBuffer.steps,
                  {
                    type: event.type,
                    toolName: event.toolName,
                    content: event.content,
                    toolInput: event.toolInput,
                  },
                ],
              };
            }
            if (event.type === 'error') {
              agentRunBuffer = {
                ...agentRunBuffer,
                status: 'failed',
                summary: 'Agent 执行失败',
                error: event.content || 'Agent error',
                steps: [
                  ...agentRunBuffer.steps,
                  { type: 'error', content: event.content || 'Agent error' },
                ],
              };
            }
            useChatStore.getState().updateMessage(assistantMsg.id, useChatStore.getState().messages.find((m) => m.id === assistantMsg.id)?.content || '', {
              agentRun: agentRunBuffer,
            });
          },
          onDone: async (event) => {
            postStream = (async () => {
              if (assistantMsg.mode === 'agent' && event.agentRun) {
                agentRunBuffer = event.agentRun;
                useChatStore.getState().updateMessage(
                  assistantMsg.id,
                  useChatStore.getState().messages.find((m) => m.id === assistantMsg.id)?.content || '',
                  { agentRun: agentRunBuffer }
                );
              }
              await smoother.finish();
              await loadMessages(currentConversation.id);
            })();
          },
          onError: (message) => {
            postStream = (async () => {
              smoother.cancel({ flush: true });
              useChatStore.getState().updateMessage(
                assistantMsg.id,
                `Error: ${message}`,
                assistantMsg.mode === 'agent'
                  ? {
                      agentRun: {
                        status: 'failed',
                        summary: 'Agent 执行失败',
                        error: message,
                        steps: agentRunBuffer?.steps || [],
                      },
                    }
                  : undefined
              );
            })();
          },
        },
        response
      );

      if (postStream) {
        await postStream;
      } else {
        await smoother.finish();
        await loadMessages(currentConversation.id);
      }
    } catch (error) {
      if ((streamAbortRef.current as any)?.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return;
      }
      useChatStore.getState().updateMessage(
        assistantMsg.id,
        `Error: ${error instanceof Error ? error.message : 'Failed to regenerate'}`,
        assistantMsg.mode === 'agent'
          ? {
              agentRun: {
                status: 'failed',
                summary: 'Agent 执行失败',
                error: error instanceof Error ? error.message : 'Failed to regenerate',
                steps: agentRunBuffer?.steps || [],
              },
            }
          : undefined
      );
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
      setStreamingAssistantId(null);
      textSmootherRef.current?.cancel({ flush: true });
      textSmootherRef.current = null;
      streamAbortRef.current = null;
    }
  };

  const handleEditSubmit = async (msgId: string, newContent: string) => {
    if (!currentConversation || !newContent.trim()) return;
    const msgIndex = messages.findIndex((message) => message.id === msgId);
    if (msgIndex < 0) return;
    if (messages[msgIndex]?.mode === 'agent') return;
    const assistantMsg = messages[msgIndex + 1];
    if (!assistantMsg || assistantMsg.role !== 'assistant' || assistantMsg.mode === 'agent') return;

    setEditingMsgId(null);
    useChatStore.getState().updateMessage(msgId, newContent.trim());
    useChatStore.getState().updateMessage(assistantMsg.id, '', {
      streamTail: undefined,
      streamPulseKey: 0,
      liveStatus: undefined,
      liveRoute: undefined,
      liveLabel: undefined,
      citations: undefined,
    });
    setIsLoading(true);
    setIsStreaming(true);
    setStreamingAssistantId(assistantMsg.id);

    try {
      try {
        streamAbortRef.current?.abort();
      } catch {
        // ignore
      }
      const abortController = new AbortController();
      streamAbortRef.current = abortController;

      const smoother = createTextStreamSmoother({
        emit: (delta) => {
          appendMessageDelta(assistantMsg.id, delta);
        },
      });
      textSmootherRef.current = smoother;
      let postStream: Promise<void> | null = null;

      const response = await api.messages.edit(msgId, newContent.trim(), { signal: abortController.signal });
      if (!response.ok) throw new Error(await response.text().catch(() => 'Failed'));

      await streamChatMessage(
        { conversationId: currentConversation.id, content: '' },
        {
          onLiveStatus: (event) => {
            useChatStore.getState().updateMessage(assistantMsg.id, '', {
              liveStatus: event.status,
              liveRoute: event.route,
              liveLabel: event.label,
            });
          },
          onCitations: (event) => {
            useChatStore.getState().updateMessage(assistantMsg.id, '', {
              citations: event.citations,
            });
          },
          onDelta: (chunk) => {
            if (!chunk) return;
            smoother.push(chunk);
          },
          onDone: async () => {
            postStream = (async () => {
              await smoother.finish();
              await loadMessages(currentConversation.id);
            })();
          },
          onError: (message) => {
            postStream = (async () => {
              smoother.cancel({ flush: true });
              useChatStore.getState().updateMessage(assistantMsg.id, `Error: ${message}`);
            })();
          },
        },
        response
      );

      if (postStream) {
        await postStream;
      } else {
        await smoother.finish();
        await loadMessages(currentConversation.id);
      }
    } catch (error) {
      if ((streamAbortRef.current as any)?.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return;
      }
      useChatStore.getState().updateMessage(
        assistantMsg.id,
        `Error: ${error instanceof Error ? error.message : 'Failed to edit message'}`
      );
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
      setStreamingAssistantId(null);
      textSmootherRef.current?.cancel({ flush: true });
      textSmootherRef.current = null;
      streamAbortRef.current = null;
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      const nativeEvent = event.nativeEvent as any;
      if (nativeEvent?.isComposing || nativeEvent?.keyCode === 229) {
        return;
      }
      event.preventDefault();
      void handleSend();
    }
  };

  if (!currentConversation) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">在左侧选择一个会话，或创建新会话开始交流</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div style={{ padding: PAGE_PAD, paddingBottom: '8px' }}>
        <ChatHeader />
      </div>

      <div
        ref={viewportRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-thin"
        style={{ paddingLeft: PAGE_PAD, paddingRight: PAGE_PAD }}
      >
        <div className="flex w-full flex-col">
          <div className="mt-auto flex flex-col gap-2 pb-2">
            {messages.map((msg, index) => (
              <React.Fragment key={msg.id}>
                <MessageBubble
                  msg={{
                    id: msg.id,
                    role: msg.role,
                    content: msg.content,
                    mode: msg.mode,
                    agentRun: msg.agentRun,
                    liveStatus: msg.liveStatus,
                    liveRoute: msg.liveRoute,
                    liveLabel: msg.liveLabel,
                    citations: msg.citations,
                    streamTail: msg.streamTail,
                    streamPulseKey: msg.streamPulseKey,
                  }}
                  isStreaming={Boolean(isStreaming && streamingAssistantId && msg.id === streamingAssistantId)}
                  canEdit={msg.role === 'user' && msg.mode !== 'agent'}
                  canRetry={msg.role === 'assistant'}
                  attachments={msg.role === 'user' ? (((msg as any).attachmentsMeta as MessageAttachmentItem[] | undefined) || undefined) : undefined}
                  onEdit={() => {
                    if (msg.role !== 'user' || msg.mode === 'agent') return;
                    setEditingMsgId(msg.id);
                    setEditingContent(msg.content || '');
                  }}
                  onRetry={() => void handleRetry(index)}
                  onDelete={() => void deleteMessage(msg.id)}
                  assistantWidth={ASSISTANT_BUBBLE_WIDTH}
                  userMaxWidth={USER_BUBBLE_MAX_WIDTH}
                />

                {editingMsgId === msg.id && (
                  <div className="flex w-full max-w-[72%] self-end flex-col items-end gap-1">
                    <Textarea
                      value={editingContent}
                      onChange={(event) => setEditingContent(event.currentTarget.value)}
                      className="w-full"
                      rows={3}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          void handleEditSubmit(msg.id, editingContent);
                        }
                        if (event.key === 'Escape') setEditingMsgId(null);
                      }}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditingMsgId(null)}>取消</Button>
                      <Button size="sm" onClick={() => void handleEditSubmit(msg.id, editingContent)} disabled={!editingContent.trim()}>确认</Button>
                    </div>
                  </div>
                )}
              </React.Fragment>
            ))}

            {messages.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">开始新一轮消息...</p>
            )}
          </div>
        </div>
      </div>

      {!effective.ok && (
        <div style={{ paddingLeft: PAGE_PAD, paddingRight: PAGE_PAD }}>
          {effective.scope === 'conversation' ? (
            <div className="mb-2 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm shadow-minimal dark:border-orange-800 dark:bg-orange-950">
              <p className="font-medium text-orange-800 dark:text-orange-200">当前会话模型不可用</p>
              <p className="text-orange-700 dark:text-orange-300">{effective.reason}</p>
              <p className="mt-1 text-xs text-muted-foreground">在下方输入框的 Model 里修复即可。</p>
            </div>
          ) : (
            <div className="mb-2 flex items-center gap-3 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm shadow-minimal dark:border-orange-800 dark:bg-orange-950">
              <p className="flex-1 text-orange-700 dark:text-orange-300">{effective.reason}</p>
              <p className="text-xs text-muted-foreground">Set a default model in Settings (gear) → Channels</p>
            </div>
          )}
        </div>
      )}

      <div style={{ paddingLeft: PAGE_PAD, paddingRight: PAGE_PAD, paddingBottom: COMPOSER_PAD_BOTTOM }}>
        <PromaComposer
          value={input}
          onChange={setInput}
          onKeyDown={handleKeyDown}
          placeholder={composerMode === 'agent' ? 'Describe a task…' : 'Type a message… (Enter to send, Shift+Enter for newline)'}
          disabled={isUploading}
          attachments={files}
          onAddAttachments={(list) => setFiles((prev) => [...prev, ...list])}
          onRemoveAttachment={(file) => setFiles((prev) => prev.filter((item) => item !== file))}
          mode={composerMode}
          onModeChange={setComposerMode}
          modelLabel={effective.ok ? effective.label : effective.scope === 'conversation' ? 'Fix model' : 'Select model'}
          modelTone={effective.ok ? 'normal' : 'warning'}
          onOpenModelPicker={() => setModelPickerOpen(true)}
          forceWebSearch={forceWebSearch}
          onToggleWebSearch={() => void handleToggleWebSearch()}
          streaming={isStreaming}
          canSubmit={canSend}
          onSubmit={() => void handleSend()}
          onStop={() => void handleStop()}
          inputRef={inputRef}
        />
      </div>

      {currentConversation && modelPickerOpen && (
        <ModelPickerModal
          opened={modelPickerOpen}
          onClose={() => setModelPickerOpen(false)}
          conversationId={currentConversation.id}
          conversationFixReason={!effective.ok && effective.scope === 'conversation' ? effective.reason : null}
          current={
            currentConversation.channelId && currentConversation.modelId
              ? { channelId: currentConversation.channelId, modelId: currentConversation.modelId }
              : effective.ok
                ? { channelId: effective.channelId, modelId: effective.modelId }
                : null
          }
        />
      )}
    </div>
  );
}
