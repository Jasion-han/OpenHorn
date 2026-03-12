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
  Button,
  Collapse,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconChevronDown, IconChevronRight, IconDots, IconMessage, IconPlus, IconTrash, IconPin, IconPencil } from '@tabler/icons-react';
import { useChatStore, type Conversation } from '../../stores/chatStore';
import { notifyError, notifySuccess } from '@/lib/notify';
import { api } from '@/lib/api';
import { BACKEND_UP_EVENT } from '@/stores/backendStatusStore';

type DateGroup = '今天' | '昨天' | '更早';

function groupByUpdatedAt(items: Conversation[]): Array<{ label: DateGroup; items: Conversation[] }> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;

  const today: Conversation[] = [];
  const yesterday: Conversation[] = [];
  const earlier: Conversation[] = [];

  for (const item of items) {
    const ts = item.updatedAt.getTime();
    if (ts >= todayStart) today.push(item);
    else if (ts >= yesterdayStart) yesterday.push(item);
    else earlier.push(item);
  }

  const groups: Array<{ label: DateGroup; items: Conversation[] }> = [];
  if (today.length) groups.push({ label: '今天', items: today });
  if (yesterday.length) groups.push({ label: '昨天', items: yesterday });
  if (earlier.length) groups.push({ label: '更早', items: earlier });
  return groups;
}

function formatNewConversationTitle() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `新对话 ${mm}-${dd} ${hh}:${min}`;
}

export function ChatAside() {
  const {
    conversations,
    currentConversation,
    setCurrentConversation,
    loadConversations,
    createConversation,
    deleteConversation,
    loadMessages,
    updateConversation,
  } = useChatStore();

  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(true);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    const onUp = () => {
      void loadConversations();
    };
    window.addEventListener(BACKEND_UP_EVENT, onUp);
    return () => {
      window.removeEventListener(BACKEND_UP_EVENT, onUp);
    };
  }, [loadConversations]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((conv) => conv.title.toLowerCase().includes(q));
  }, [conversations, query]);

  const handleNewConversation = async () => {
    setCreating(true);
    try {
      const conversation = await createConversation(formatNewConversationTitle());
      setCurrentConversation(conversation);
      await loadMessages(conversation.id);
      notifySuccess('已创建', '新对话已创建');
    } catch (error) {
      notifyError('创建失败', error instanceof Error ? error.message : '无法创建对话');
    } finally {
      setCreating(false);
    }
  };

  const handleSelectConversation = async (conversation: Conversation) => {
    setCurrentConversation(conversation);
    try {
      await loadMessages(conversation.id);
    } catch (error) {
      notifyError('加载失败', error instanceof Error ? error.message : '无法加载消息');
    }
  };

  const handleDelete = async (id: string) => {
    modals.openConfirmModal({
      title: '删除对话',
      children: <Text size="sm">确定删除该对话？此操作不可恢复。</Text>,
      labels: { confirm: '删除', cancel: '取消' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void (async () => {
          try {
            await deleteConversation(id);
            notifySuccess('已删除', '对话已删除');
          } catch (error) {
            notifyError('删除失败', error instanceof Error ? error.message : '无法删除对话');
          }
        })();
      },
    });
  };

  const handleTogglePin = async (conv: Conversation) => {
    const next = !conv.isPinned;
    updateConversation(conv.id, { isPinned: next });
    try {
      await api.conversations.update(conv.id, { isPinned: next });
    } catch (error) {
      updateConversation(conv.id, { isPinned: conv.isPinned });
      notifyError('操作失败', error instanceof Error ? error.message : '无法更新置顶状态');
    }
  };

  const handleRename = (conv: Conversation) => {
    let value = conv.title;
    modals.openConfirmModal({
      title: '重命名对话',
      children: (
        <TextInput
          label="标题"
          defaultValue={conv.title}
          onChange={(e) => {
            value = e.target.value;
          }}
        />
      ),
      labels: { confirm: '保存', cancel: '取消' },
      onConfirm: () => {
        const nextTitle = value.trim();
        if (!nextTitle) return;
        void (async () => {
          updateConversation(conv.id, { title: nextTitle });
          try {
            await api.conversations.update(conv.id, { title: nextTitle });
            notifySuccess('已保存', '标题已更新');
          } catch (error) {
            notifyError('保存失败', error instanceof Error ? error.message : '无法更新标题');
            void loadConversations();
          }
        })();
      },
    });
  };

  const pinned = filtered.filter((c) => c.isPinned);
  const rest = filtered.filter((c) => !c.isPinned);
  const groups = groupByUpdatedAt(rest);

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
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => void handleNewConversation()}
          loading={creating}
        >
          新对话
        </Button>

        <TextInput
          placeholder="搜索对话..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <ScrollArea flex={1} scrollbarSize={8}>
          <Stack gap="xs">
            {pinned.length > 0 && (
              <>
                <Group justify="space-between" mt="xs">
                  <Text size="xs" c="dimmed" fw={600}>置顶</Text>
                  <ActionIcon variant="subtle" size="sm" onClick={() => setPinnedOpen((v) => !v)}>
                    {pinnedOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                  </ActionIcon>
                </Group>
                <Collapse in={pinnedOpen}>
                  <Stack gap="xs">
                    {pinned.map((conv) => (
                      <Paper
                        key={`pinned-${conv.id}`}
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
                            <IconPin size={16} />
                            <Text size="sm" truncate style={{ flex: 1 }}>
                              {conv.title}
                            </Text>
                          </Group>
                          <Menu shadow="md" width={160} position="bottom-end">
                            <Menu.Target>
                              <ActionIcon variant="subtle" size="sm" onClick={(e) => e.stopPropagation()}>
                                <IconDots size={14} />
                              </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <Menu.Item
                                leftSection={<IconPencil size={14} />}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRename(conv);
                                }}
                              >
                                重命名
                              </Menu.Item>
                              <Menu.Item
                                leftSection={<IconPin size={14} />}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleTogglePin(conv);
                                }}
                              >
                                取消置顶
                              </Menu.Item>
                              <Menu.Item
                                leftSection={<IconTrash size={14} />}
                                color="red"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleDelete(conv.id);
                                }}
                              >
                                删除
                              </Menu.Item>
                            </Menu.Dropdown>
                          </Menu>
                        </Group>
                      </Paper>
                    ))}
                  </Stack>
                </Collapse>
              </>
            )}

            {groups.map((group) => (
              <div key={group.label}>
                <Text size="xs" c="dimmed" fw={600} mt="xs" mb={6}>{group.label}</Text>
                <Stack gap="xs">
                  {group.items.map((conv) => (
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
                        <Menu shadow="md" width={160} position="bottom-end">
                          <Menu.Target>
                            <ActionIcon variant="subtle" size="sm" onClick={(e) => e.stopPropagation()}>
                              <IconDots size={14} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item
                              leftSection={<IconPencil size={14} />}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRename(conv);
                              }}
                            >
                              重命名
                            </Menu.Item>
                            <Menu.Item
                              leftSection={<IconPin size={14} />}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleTogglePin(conv);
                              }}
                            >
                              置顶
                            </Menu.Item>
                            <Menu.Item
                              leftSection={<IconTrash size={14} />}
                              color="red"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleDelete(conv.id);
                              }}
                            >
                              删除
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              </div>
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
