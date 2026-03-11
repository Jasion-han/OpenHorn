'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Paper,
  TextInput,
  Stack,
  Group,
  Text,
  ActionIcon,
  ScrollArea,
  Menu,
} from '@mantine/core';
import { IconDots, IconMessage, IconPlus, IconTrash } from '@tabler/icons-react';
import { useChatStore, type Conversation } from '../../stores/chatStore';
import { api } from '../../lib/api';

export function ChatAside() {
  const {
    conversations,
    currentConversation,
    setCurrentConversation,
    setMessages,
    loadConversations,
    createConversation,
    deleteConversation,
  } = useChatStore();

  const [newTitle, setNewTitle] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((conv) => conv.title.toLowerCase().includes(q));
  }, [conversations, query]);

  const handleNewConversation = async () => {
    if (!newTitle.trim()) return;

    setLoading(true);
    try {
      const conversation = await createConversation(newTitle.trim());
      setNewTitle('');
      setCurrentConversation(conversation);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectConversation = async (conversation: Conversation) => {
    setCurrentConversation(conversation);
    try {
      const { messages } = await api.messages.list(conversation.id);
      setMessages(messages as never[]);
    } catch (error) {
      console.error('Failed to load messages:', error);
    }
  };

  const handleDelete = async (id: string) => {
    const ok = confirm('Delete this conversation?');
    if (!ok) return;
    await deleteConversation(id);
  };

  return (
    <Paper
      style={{
        height: '100%',
        border: '1px solid var(--mantine-color-gray-3)',
        borderRadius: 'var(--mantine-radius-md)',
      }}
      p="sm"
    >
      <Stack h="100%" gap="sm">
        <TextInput
          placeholder="Search..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <TextInput
          placeholder="New conversation..."
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleNewConversation()}
          rightSection={
            <ActionIcon
              variant="filled"
              onClick={() => void handleNewConversation()}
              loading={loading}
            >
              <IconPlus size={16} />
            </ActionIcon>
          }
        />

        <ScrollArea flex={1} scrollbarSize={8}>
          <Stack gap="xs">
            {filtered.map((conv) => (
              <Paper
                key={conv.id}
                p="sm"
                radius="md"
                withBorder
                style={{
                  cursor: 'pointer',
                  backgroundColor: currentConversation?.id === conv.id
                    ? 'var(--mantine-color-blue-0)'
                    : undefined,
                }}
                onClick={() => void handleSelectConversation(conv)}
              >
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                    <IconMessage size={16} />
                    <Text size="sm" truncate style={{ flex: 1 }}>
                      {conv.title}
                    </Text>
                  </Group>
                  <Menu shadow="md" width={140} position="bottom-end">
                    <Menu.Target>
                      <ActionIcon variant="subtle" size="sm" onClick={(e) => e.stopPropagation()}>
                        <IconDots size={14} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconTrash size={14} />}
                        color="red"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDelete(conv.id);
                        }}
                      >
                        Delete
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Group>
              </Paper>
            ))}

            {filtered.length === 0 && (
              <Text size="sm" c="dimmed" ta="center" py="xl">
                No conversations
              </Text>
            )}
          </Stack>
        </ScrollArea>
      </Stack>
    </Paper>
  );
}

