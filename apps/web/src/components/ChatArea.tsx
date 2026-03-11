'use client';

import { useState, useRef, useEffect } from 'react';
import { Paper, Textarea, Button, Group, Stack, Text, Alert, Badge, FileButton } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';
import { useChatStore } from '../stores/chatStore';
import { streamChatMessage } from '../lib/chat-stream';
import { uploadAttachments } from '../lib/attachments';
import { getEffectiveModelForConversation } from '@/lib/effective-model';
import { ChatHeader } from '@/components/chat/ChatHeader';

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

  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTo({ top: viewportRef.current.scrollHeight });
    }
  }, [messages]);

  const effectiveModel = getEffectiveModelForConversation(channels, currentConversation);
  const hasInput = Boolean(input.trim());
  const hasFiles = files.length > 0;
  const canSend = Boolean(effectiveModel) && Boolean(currentConversation) && !isLoading && !isUploading && (hasInput || hasFiles);

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
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text c="dimmed">Select a conversation or start a new one</Text>
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
      p="md"
    >
      <ChatHeader />

      {/* Custom scroll container so we can reliably pin short conversations to bottom. */}
      <div
        ref={viewportRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Stack gap="md" pb="md" style={{ marginTop: 'auto' }}>
          {messages.map((msg) => (
            <Paper
              key={msg.id}
              p="md"
              radius="lg"
              bg={msg.role === 'user' ? 'blue.0' : 'gray.0'}
              style={{
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
              }}
            >
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {msg.content}
              </Text>
            </Paper>
          ))}

          {messages.length === 0 && (
            <Text c="dimmed" ta="center" py="xl">
              Start the conversation...
            </Text>
          )}
        </Stack>
      </div>

      {!effectiveModel && (
        <Alert color="orange" mb="sm" title="需要先完成设置">
          未配置默认渠道或模型，请先完成设置后再开始对话。
          <Button component="a" href="/settings" size="xs" variant="light" ml="sm">
            去设置
          </Button>
        </Alert>
      )}

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
              disabled={!effectiveModel || isLoading || isUploading}
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
                <Button variant="light" {...props} disabled={!effectiveModel || isLoading || isUploading}>
                  Attach
                </Button>
              )}
            </FileButton>
            {effectiveModel && (
              <Badge variant="light" color="gray">
                {effectiveModel.label}
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
    </Paper>
  );
}
