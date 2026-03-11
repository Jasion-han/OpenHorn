'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  TextInput,
  ScrollArea,
  Stack,
  Group,
  Text,
  Badge,
  Paper,
  Button,
} from '@mantine/core';
import { IconRefresh, IconSearch } from '@tabler/icons-react';
import { api, type ApiChannel } from '@/lib/api';
import { notifyError, notifySuccess } from '@/lib/notify';
import { useChatStore } from '@/stores/chatStore';

function buildOptions(channels: ApiChannel[]) {
  return channels
    .filter((c) => c.enabled)
    .map((c) => ({
      channel: c,
      models: c.models.filter((m) => m.enabled),
    }))
    .filter((x) => x.models.length > 0);
}

export function ModelPickerModal(props: {
  opened: boolean;
  onClose: () => void;
  conversationId: string;
  current?: { channelId: string; modelId: string } | null;
}) {
  const { opened, onClose, conversationId, current } = props;
  const { channels, setChannels, setConversationModel } = useChatStore();

  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setQuery('');
    void (async () => {
      try {
        const { channels } = await api.channels.list();
        setChannels(channels);
      } catch {
        // Best-effort; can still render from cached store.
      }
    })();
  }, [opened, setChannels]);

  const groups = useMemo(() => buildOptions(channels), [channels]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;

    return groups
      .map((g) => ({
        channel: g.channel,
        models: g.models.filter((m) =>
          m.modelId.toLowerCase().includes(q)
          || m.displayName.toLowerCase().includes(q)
          || g.channel.name.toLowerCase().includes(q)
          || g.channel.provider.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.models.length > 0);
  }, [groups, query]);

  const handleSyncModels = async () => {
    setBusy(true);
    try {
      const { channels: currentChannels } = await api.channels.list();
      const enabled = currentChannels.filter((c) => c.enabled);

      const results = await Promise.allSettled(
        enabled.map(async (c) => ({ channel: c, result: await api.channels.fetchModels(c.id) }))
      );

      const failed: Array<{ name: string; error: string }> = [];
      for (const r of results) {
        if (r.status === 'rejected') {
          failed.push({ name: '未知渠道', error: r.reason instanceof Error ? r.reason.message : '同步失败' });
          continue;
        }
        if (!r.value.result.success) {
          failed.push({ name: r.value.channel.name, error: r.value.result.error || '同步失败' });
        }
      }

      const { channels: next } = await api.channels.list();
      setChannels(next);

      if (failed.length > 0) {
        notifyError('同步未完成', `${failed[0].name}: ${failed[0].error}`);
      } else {
        notifySuccess('同步完成', '已更新模型列表');
      }
    } catch (error) {
      notifyError('同步失败', error instanceof Error ? error.message : '无法同步模型列表');
    } finally {
      setBusy(false);
    }
  };

  const handleSelect = async (channelId: string, modelId: string) => {
    setBusy(true);
    try {
      await setConversationModel(conversationId, channelId, modelId);
      notifySuccess('模型已更新', '已保存到当前对话');
      onClose();
    } catch (error) {
      notifyError('更新失败', error instanceof Error ? error.message : '无法更新模型选择');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="选择模型" size="lg" centered>
      <Stack gap="sm">
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <TextInput
            style={{ flex: 1 }}
            placeholder="搜索渠道或模型..."
            leftSection={<IconSearch size={16} />}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button
            variant="light"
            leftSection={<IconRefresh size={16} />}
            onClick={() => void handleSyncModels()}
            loading={busy}
          >
            同步
          </Button>
        </Group>

        <ScrollArea h={420} type="auto">
          <Stack gap="md" pr="sm">
            {filtered.map(({ channel, models }) => (
              <div key={channel.id}>
                <Group justify="space-between" mb={6}>
                  <Group gap="xs">
                    <Text fw={600} size="sm">{channel.name}</Text>
                    <Badge variant="light" color="gray">{channel.provider}</Badge>
                  </Group>
                  {channel.isDefault && <Badge color="blue">Default</Badge>}
                </Group>

                <Stack gap={6}>
                  {models.map((model) => {
                    const selected = current?.channelId === channel.id && current?.modelId === model.modelId;
                    return (
                      <Paper
                        key={`${channel.id}:${model.modelId}`}
                        withBorder
                        p="sm"
                        radius="md"
                        style={{
                          cursor: busy ? 'not-allowed' : 'pointer',
                          opacity: busy ? 0.7 : 1,
                          background: selected ? 'var(--mantine-color-blue-0)' : undefined,
                        }}
                        onClick={() => {
                          if (busy) return;
                          void handleSelect(channel.id, model.modelId);
                        }}
                      >
                        <Group justify="space-between" wrap="nowrap">
                          <div style={{ minWidth: 0 }}>
                            <Text size="sm" fw={500} truncate>
                              {model.displayName || model.modelId}
                            </Text>
                            <Text size="xs" c="dimmed" truncate>
                              {model.modelId}
                            </Text>
                          </div>
                          <Group gap="xs" wrap="nowrap">
                            {model.isDefault && <Badge variant="light">默认</Badge>}
                            {selected && <Badge color="blue">已选</Badge>}
                          </Group>
                        </Group>
                      </Paper>
                    );
                  })}
                </Stack>
              </div>
            ))}

            {filtered.length === 0 && (
              <Stack align="center" py="xl" gap="xs">
                <Text c="dimmed" size="sm">没有匹配的模型</Text>
                <Button variant="light" onClick={() => setQuery('')}>清空搜索</Button>
              </Stack>
            )}
          </Stack>
        </ScrollArea>
      </Stack>
    </Modal>
  );
}
