'use client';

import { useState, useRef, useEffect } from 'react';
import { Paper, Textarea, Button, Group, Stack, Text, Alert, Badge, FileButton } from '@mantine/core';
import { useChatStore } from '../stores/chatStore';
import { streamChatMessage } from '../lib/chat-stream';
import { uploadAttachments } from '../lib/attachments';
import { api } from '../lib/api';
import { getEffectiveModelForConversation } from '@/lib/effective-model';
import { IconSend, IconCopy, IconRefresh, IconTrash, IconCheck } from '@tabler/icons-react';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { WRAP_TEXT } from '@/components/ui/wrapText';
import { MarkdownMessage } from '@/components/ui/MarkdownMessage';
import { buildSettingsLink } from '@/lib/settings-link';

const PAGE_PAD = 'var(--mantine-spacing-md)';
// Keep bottom safe area, but avoid adding extra desktop gap.
const COMPOSER_PAD_BOTTOM = 'env(safe-area-inset-bottom, 0px)';

function MessageBubble({
  msg,
  isStreaming,
  onRetry,
  onDelete,
  assistantWidth,
  userMaxWidth,
}: {
  msg: { id: string; role: 'user' | 'assistant'; content: string };
  isStreaming: boolean;
  onRetry: () => void;
  onDelete: () => void;
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

  return (
    <div
      style={{ alignSelf: isAssistant ? 'flex-start' : 'flex-end', width: isAssistant ? assistantWidth : undefined, maxWidth: isAssistant ? assistantWidth : userMaxWidth }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Paper
        px="md"
        py="xs"
        radius="lg"
        bg={isAssistant ? 'gray.0' : 'blue.0'}
      >
        {isAssistant ? (
          <div style={WRAP_TEXT}>
            <MarkdownMessage content={msg.content} />
          </div>
        ) : (
          <Text size="sm" style={WRAP_TEXT}>{msg.content}</Text>
        )}
      </Paper>
      <div
        style={{
          display: 'flex',
          gap: 2,
          marginTop: 2,
          justifyContent: isAssistant ? 'flex-start' : 'flex-end',
          opacity: hovered && !isStreaming ? 1 : 0,
          transition: 'opacity 0.15s',
          pointerEvents: hovered && !isStreaming ? 'auto' : 'none',
        }}
      >
        <ActionButton onClick={handleCopy} title={copied ? '已复制' : '复制'}>
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        </ActionButton>
        {isAssistant && (
          <ActionButton onClick={onRetry} title="重新生成">
            <IconRefresh size={13} />
          </ActionButton>
        )}
        <ActionButton onClick={onDelete} title="删除" danger>
          <IconTrash size={13} />
        </ActionButton>
      </div>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '3px 6px',
        border: '1px solid var(--mantine-color-gray-3)',
        borderRadius: 'var(--mantine-radius-sm)',
        background: 'transparent',
        color: danger ? 'var(--mantine-color-red-5)' : 'var(--mantine-color-gray-5)',
        cursor: 'pointer',
        fontSize: 11,
        gap: 3,
        fontFamily: 'inherit',
        transition: 'background 0.12s, color 0.12s',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = danger
          ? 'var(--mantine-color-red-0)'
          : 'var(--mantine-color-gray-1)';
        (e.currentTarget as HTMLButtonElement).style.color = danger
          ? 'var(--mantine-color-red-7)'
          : 'var(--mantine-color-gray-8)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
        (e.currentTarget as HTMLButtonElement).style.color = danger
          ? 'var(--mantine-color-red-5)'
          : 'var(--mantine-color-gray-5)';
      }}
    >
      {children}
      {title && <span>{title}</span>}
    </button>
  );
}

export function ChatArea() {
  const {
    currentConversation,
    messages,
    isLoading,
    addMessage,
    loadMessages,
    setIsLoading,
    setIsStreaming,
    channels,
    updateConversation,
    deleteMessage,
  } = useChatStore();
  
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ASSISTANT_BUBBLE_WIDTH = '92%';
  const USER_BUBBLE_MAX_WIDTH = '72%';

  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTo({ top: viewportRef.current.scrollHeight });
    }
  }, [messages]);

  const effective = getEffectiveModelForConversation(channels, currentConversation);
  const hasInput = Boolean(input.trim());
  const hasFiles = files.length > 0;
  const canSend =
    effective.ok
    && Boolean(currentConversation)
    && !isLoading
    && !isUploading
    && (hasInput || hasFiles);

  const handleSend = async () => {
    if (!canSend || !currentConversation) return;

    const conversationId = currentConversation.id;
    const effectiveContent = input.trim().length > 0
      ? input
      : files.length > 0
        ? `Attachments: ${files.map((file) => file.name).join(', ')}`
        : input;

    const userMessage = {
      id: `temp-${Date.now()}`,
      conversationId,
      role: 'user' as const,
      content: effectiveContent,
      createdAt: new Date(),
    };

    addMessage(userMessage);
    const assistantMessageId = `temp-assistant-${Date.now()}`;
    addMessage({
      id: assistantMessageId,
      conversationId,
      role: 'assistant' as const,
      content: '',
      createdAt: new Date(),
    });

    setInput('');
    // Keep the cursor in the input so users can continue typing while streaming.
    queueMicrotask(() => inputRef.current?.focus());
    setIsLoading(true);
    setIsStreaming(true);

    try {
      let assistantContent = '';
      let attachmentIds: string[] = [];

      if (files.length > 0) {
        setIsUploading(true);
        const upload = await uploadAttachments({
          conversationId,
          files,
        });
        attachmentIds = upload.attachments.map((attachment) => attachment.id);
        setFiles([]);
      }

      await streamChatMessage(
        { conversationId, content: effectiveContent, attachments: attachmentIds },
        {
          onDelta: (chunk) => {
            if (!chunk) return;
            assistantContent += chunk;
            useChatStore.getState().updateMessage(assistantMessageId, assistantContent);
          },
          onDone: async () => {
            await loadMessages(conversationId);
            // Auto-rename if still using the default title.
            const conv = useChatStore.getState().currentConversation;
            if (conv && /^新对话 \d{2}-\d{2} \d{2}:\d{2}$/.test(conv.title)) {
              void api.conversations.autoTitle(conversationId, effectiveContent).then((res) => {
                if (res.success && res.title) {
                  updateConversation(conversationId, { title: res.title });
                }
              }).catch(() => {});
            }
          },
          onError: (message) => {
            useChatStore.getState().updateMessage(assistantMessageId, `Error: ${message}`);
          },
        }
      );
    } catch (error) {
      console.error('Failed to send message:', error);
      useChatStore.getState().updateMessage(
        assistantMessageId,
        `Error: ${error instanceof Error ? error.message : 'Failed to send message'}`
      );
    } finally {
      setIsUploading(false);
      setIsLoading(false);
      setIsStreaming(false);
      queueMicrotask(() => inputRef.current?.focus());
    }
  };

  const handleRetry = async (msgIndex: number) => {
    if (!currentConversation) return;
    const assistantMsg = messages[msgIndex];
    if (!assistantMsg || assistantMsg.role !== 'assistant') return;
    if (assistantMsg.id.startsWith('temp-')) return;

    useChatStore.getState().updateMessage(assistantMsg.id, '');
    setIsLoading(true);
    setIsStreaming(true);

    try {
      const response = await api.messages.regenerate(assistantMsg.id);
      if (!response.ok) throw new Error(await response.text().catch(() => 'Failed'));

      await streamChatMessage(
        { conversationId: currentConversation.id, content: '' },
        {
          onDelta: (chunk) => {
            if (!chunk) return;
            const current = useChatStore.getState().messages.find((m) => m.id === assistantMsg.id);
            useChatStore.getState().updateMessage(assistantMsg.id, (current?.content || '') + chunk);
          },
          onDone: async () => { await loadMessages(currentConversation.id); },
          onError: (message) => {
            useChatStore.getState().updateMessage(assistantMsg.id, `Error: ${message}`);
          },
        },
        response
      );
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const ne = e.nativeEvent as any;
      // When using IME (e.g. Chinese input method), Enter confirms composition.
      // Don't treat it as "send".
      if (ne?.isComposing || ne?.keyCode === 229) {
        return;
      }
      e.preventDefault();
      handleSend();
    }
  };

  if (!currentConversation) {
    return (
      <Paper
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
        }}
      >
        <Text c="dimmed">在右侧选择一个对话，或创建新对话开始聊天</Text>
      </Paper>
    );
  }

  return (
    <Paper
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
      p={0}
    >
      <div style={{ padding: PAGE_PAD, paddingBottom: 'var(--mantine-spacing-xs)' }}>
        <ChatHeader />
      </div>

      {/* Custom scroll container so we can reliably pin short conversations to bottom. */}
      <div
        ref={viewportRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          paddingLeft: PAGE_PAD,
          paddingRight: PAGE_PAD,
        }}
      >
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
          <Stack gap="xs" pb="sm" style={{ marginTop: 'auto' }}>
          {messages.map((msg, idx) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              isStreaming={isLoading && idx === messages.length - 1}
              onRetry={() => handleRetry(idx)}
              onDelete={() => deleteMessage(msg.id)}
              assistantWidth={ASSISTANT_BUBBLE_WIDTH}
              userMaxWidth={USER_BUBBLE_MAX_WIDTH}
            />
          ))}

          {messages.length === 0 && (
            <Text c="dimmed" ta="center" py="xl">
              Start the conversation...
            </Text>
          )}
          </Stack>
        </div>
      </div>

      {!effective.ok && (
        <div style={{ paddingLeft: PAGE_PAD, paddingRight: PAGE_PAD }}>
          {effective.scope === 'conversation' ? (
            <Alert color="orange" mb="sm" title="当前对话模型不可用">
              {effective.reason}
              <Text size="xs" c="dimmed" mt={6}>
                点击顶部右侧的「修复模型」即可重新选择。
              </Text>
            </Alert>
          ) : (
            <Alert color="orange" mb="sm" title="需要先完成设置">
              {effective.reason}
              <Button component="a" href={buildSettingsLink({ tab: 'channels', focus: 'default' })} size="xs" variant="light" ml="sm">
                去设置
              </Button>
            </Alert>
          )}
        </div>
      )}

      <div style={{ paddingLeft: PAGE_PAD, paddingRight: PAGE_PAD, paddingBottom: COMPOSER_PAD_BOTTOM }}>
        <Paper
          p="sm"
          radius="lg"
          withBorder
          style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}
        >
          <Stack gap="xs">
            {files.length > 0 && (
              <Stack gap={4}>
                {files.map((file) => (
                  <Group key={`${file.name}-${file.size}`} gap="xs">
                    <Text size="xs" c="dimmed">{file.name}</Text>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      onClick={() => setFiles((prev) => prev.filter((f) => f !== file))}
                    >
                      Remove
                    </Button>
                  </Group>
                ))}
              </Stack>
            )}
            <Group gap="sm">
              <Textarea
                placeholder="Type your message..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                style={{ flex: 1 }}
                autosize
                minRows={1}
                maxRows={6}
                // Allow typing while streaming; only sending is blocked via canSend.
                disabled={!effective.ok || isUploading}
                ref={inputRef}
              />
              <FileButton
                onChange={(selected) => {
                  if (!selected) return;
                  const list = Array.isArray(selected) ? selected : [selected];
                  setFiles((prev) => [...prev, ...list]);
                }}
                accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown"
                multiple
              >
                {(props) => (
                  <Button variant="light" {...props} disabled={!effective.ok || isUploading}>
                    Attach
                  </Button>
                )}
              </FileButton>
              {effective.ok && (
                <Badge variant="light" color="gray">
                  {effective.label}
                </Badge>
              )}
              <Button
                onClick={handleSend}
                loading={isLoading || isUploading}
                disabled={!canSend}
              >
                <IconSend size={18} />
              </Button>
            </Group>
          </Stack>
        </Paper>
      </div>
    </Paper>
  );
}
