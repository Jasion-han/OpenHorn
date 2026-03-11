'use client';

import { useState, useRef, useEffect } from 'react';
import { Paper, Textarea, Button, Group, Stack, Text, Alert, Badge, FileButton } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';
import { useChatStore } from '../stores/chatStore';
import { streamChatMessage } from '../lib/chat-stream';
import { uploadAttachments } from '../lib/attachments';
import { getEffectiveModelForConversation } from '@/lib/effective-model';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { WRAP_TEXT } from '@/components/ui/wrapText';
import { MarkdownMessage } from '@/components/ui/MarkdownMessage';

const PAGE_PAD = 'var(--mantine-spacing-md)';
// Keep bottom safe area, but avoid adding extra desktop gap.
const COMPOSER_PAD_BOTTOM = 'env(safe-area-inset-bottom, 0px)';

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
  } = useChatStore();
  
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
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
        <div style={{ width: '100%', maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column' }}>
          <Stack gap="xs" pb="sm" style={{ marginTop: 'auto' }}>
          {messages.map((msg) => (
            <Paper
              key={msg.id}
              p="xs"
              radius="lg"
              bg={msg.role === 'user' ? 'blue.0' : 'gray.0'}
              style={{
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
              }}
            >
              {msg.role === 'assistant' ? (
                <div style={WRAP_TEXT}>
                  <MarkdownMessage content={msg.content} />
                </div>
              ) : (
                <Text size="sm" style={WRAP_TEXT}>
                  {msg.content}
                </Text>
              )}
            </Paper>
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
              <Button component="a" href="/settings" size="xs" variant="light" ml="sm">
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
