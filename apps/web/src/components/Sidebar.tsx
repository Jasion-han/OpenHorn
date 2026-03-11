'use client';

import { useState, useEffect } from 'react';
import {
  Paper,
  TextInput,
  Button,
  Stack,
  Group,
  Text,
  ActionIcon,
  ScrollArea,
  Menu,
} from '@mantine/core';
import { IconPlus, IconMessage, IconSettings, IconTrash, IconPin, IconDots } from '@tabler/icons-react';
import { useChatStore, type Conversation } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import { api } from '../lib/api';

export function Sidebar() {
  const { user } = useAuthStore();
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
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user) {
      loadConversations();
    }
  }, [user, loadConversations]);

  const handleNewConversation = async () => {
    if (!newTitle.trim()) return;
    
    setLoading(true);
    try {
      const conversation = await createConversation(newTitle.trim());
      setNewTitle('');
      setCurrentConversation(conversation);
    } catch (error) {
      console.error('Failed to create conversation:', error);
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

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteConversation(id);
    } catch (error) {
      console.error('Failed to delete conversation:', error);
    }
  };

  return (
    <Paper
      style={{
        height: '100%',
        borderRight: '1px solid var(--mantine-color-gray-3)',
      }}
      p="md"
    >
      <Stack h="100%">
        <TextInput
          placeholder="New conversation..."
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleNewConversation()}
          rightSection={
            <ActionIcon
              variant="filled"
              onClick={handleNewConversation}
              loading={loading}
            >
              <IconPlus size={16} />
            </ActionIcon>
          }
        />

        <ScrollArea flex={1}>
          <Stack gap="xs">
            {conversations.map((conv) => (
              <Paper
                key={conv.id}
                p="sm"
                radius="sm"
                withBorder={currentConversation?.id === conv.id}
                style={{
                  cursor: 'pointer',
                  backgroundColor: currentConversation?.id === conv.id 
                    ? 'var(--mantine-color-blue-0)' 
                    : undefined,
                }}
                onClick={() => handleSelectConversation(conv)}
              >
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                    <IconMessage size={16} />
                    <Text size="sm" truncate style={{ flex: 1 }}>
                      {conv.title}
                    </Text>
                    {conv.isPinned && (
                      <IconPin size={14} style={{ flexShrink: 0 }} />
                    )}
                  </Group>
                  <Menu shadow="md" width={120} position="bottom-end">
                    <Menu.Target>
                      <ActionIcon variant="subtle" size="sm">
                        <IconDots size={14} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconTrash size={14} />}
                        color="red"
                        onClick={(e) => handleDelete(conv.id, e)}
                      >
                        Delete
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Group>
              </Paper>
            ))}
            
            {conversations.length === 0 && (
              <Text size="sm" c="dimmed" ta="center" py="xl">
                No conversations yet
              </Text>
            )}
          </Stack>
        </ScrollArea>

        <Group>
          <Button
            variant="subtle"
            fullWidth
            leftSection={<IconSettings size={16} />}
            component="a"
            href="/settings"
          >
            Settings
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
