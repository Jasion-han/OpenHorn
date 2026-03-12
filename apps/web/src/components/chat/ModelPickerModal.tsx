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
import { notifyError, notifySuccess, notifyWarning } from '@/lib/notify';
import { useChatStore } from '@/stores/chatStore';
import Link from 'next/link';
import { buildSettingsLink } from '@/lib/settings-link';

type ModelGroup = {
  channel: ApiChannel;
  models: ApiChannel['models'];
  isChannelDisabled: boolean;
  needsDefaultModel: boolean;
};

function sortChannels(a: ApiChannel, b: ApiChannel) {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function sortModels(a: ApiChannel['models'][number], b: ApiChannel['models'][number]) {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return (a.displayName || a.modelId).localeCompare(b.displayName || b.modelId);
}

function buildOptions(channels: ApiChannel[]): ModelGroup[] {
  const enabled = channels.filter((c) => c.enabled).sort(sortChannels);
  const disabled = channels.filter((c) => !c.enabled).sort(sortChannels);

  return [...enabled, ...disabled].map((c) => ({
    channel: c,
    models: [...c.models].sort(sortModels),
    isChannelDisabled: !c.enabled,
    needsDefaultModel: Boolean(c.isDefault && c.enabled && !c.defaultModelId),
  }));
}

export function ModelPickerModal(props: {
  opened: boolean;
  onClose: () => void;
  conversationId: string;
  current?: { channelId: string; modelId: string } | null;
  conversationFixReason?: string | null;
}) {
  const { opened, onClose, conversationId, current, conversationFixReason } = props;
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
        isChannelDisabled: g.isChannelDisabled,
        needsDefaultModel: g.needsDefaultModel,
        models: (() => {
          const channelMatch = g.channel.name.toLowerCase().includes(q)
            || g.channel.provider.toLowerCase().includes(q)
            || g.channel.baseUrl?.toLowerCase().includes(q);
          if (channelMatch) return g.models;
          return g.models.filter((m) =>
            m.modelId.toLowerCase().includes(q)
            || m.displayName.toLowerCase().includes(q)
          );
        })(),
      }))
      .filter((g) => g.models.length > 0 || g.channel.name.toLowerCase().includes(q) || g.channel.provider.toLowerCase().includes(q));
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
      const warned: Array<{ name: string; warning: string }> = [];
      for (const r of results) {
        if (r.status === 'rejected') {
          failed.push({ name: '未知渠道', error: r.reason instanceof Error ? r.reason.message : '同步失败' });
          continue;
        }
        if (!r.value.result.success) {
          failed.push({ name: r.value.channel.name, error: r.value.result.error || '同步失败' });
          continue;
        }
        if (r.value.result.error) {
          warned.push({ name: r.value.channel.name, warning: r.value.result.error });
        }
      }

      const { channels: next } = await api.channels.list();
      setChannels(next);

      if (failed.length > 0) {
        notifyError('同步未完成', `${failed[0].name}: ${failed[0].error}`);
      } else if (warned.length > 0) {
        notifyWarning('同步完成（需要处理）', `${warned[0].name}: ${warned[0].warning}`);
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
        {conversationFixReason && (
          <Paper withBorder p="sm" radius="md" bg="orange.0">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Text fw={600} size="sm">当前对话模型不可用</Text>
                <Text size="sm" style={{ wordBreak: 'break-word' }}>
                  {conversationFixReason}
                </Text>
              </div>
              <Button
                component={Link}
                href={buildSettingsLink({ tab: 'channels', focus: 'default' })}
                size="xs"
                variant="light"
              >
                去设置
              </Button>
            </Group>
          </Paper>
        )}

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
            {filtered.map(({ channel, models, isChannelDisabled, needsDefaultModel }) => (
              <div key={channel.id}>
                <Group justify="space-between" mb={6}>
                  <Group gap="xs">
                    <Text fw={600} size="sm">{channel.name}</Text>
                    <Badge variant="light" color="gray">{channel.provider}</Badge>
                  </Group>
                  <Group gap="xs">
                    {channel.isDefault && <Badge color="blue">默认</Badge>}
                    {needsDefaultModel && <Badge color="orange">缺少默认模型</Badge>}
                    {isChannelDisabled && <Badge color="gray">已禁用</Badge>}
                  </Group>
                </Group>

                <Stack gap={6}>
                  {models.length === 0 && (
                    <Text size="sm" c="dimmed">
                      暂无模型，请先点击上方「同步」获取模型列表。
                    </Text>
                  )}

                  {models.map((model) => {
                    const selected = current?.channelId === channel.id && current?.modelId === model.modelId;
                    const isModelDisabled = !model.enabled;
                    const disabled = busy || isChannelDisabled || isModelDisabled;
                    return (
                      <Paper
                        key={`${channel.id}:${model.modelId}`}
                        withBorder
                        p="sm"
                        radius="md"
                        style={{
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          opacity: disabled ? 0.6 : 1,
                          background: selected ? 'var(--mantine-color-blue-0)' : undefined,
                        }}
                        onClick={() => {
                          if (disabled) return;
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
                            {isModelDisabled && <Badge color="gray" variant="light">已禁用</Badge>}
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
