'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Collapse,
  Group,
  Loader,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconCheck, IconChevronDown, IconChevronUp, IconPlus, IconRefresh, IconStar, IconTrash } from '@tabler/icons-react';
import { useChatStore } from '../../stores/chatStore';
import { api, type ApiChannel, type ApiChannelModel } from '../../lib/api';
import { notifyError, notifySuccess } from '../../lib/notify';

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  anthropic: {
    name: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  deepseek: {
    name: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
  },
  google: {
    name: 'Google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  },
};

type ProviderKey = keyof typeof PROVIDERS;

export function ChannelSettings() {
  const { channels, setChannels } = useChatStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expandedChannelId, setExpandedChannelId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ProviderKey>('openai');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(PROVIDERS.openai.defaultBaseUrl);

  const providerOptions = useMemo(
    () => Object.entries(PROVIDERS).map(([value, item]) => ({ value, label: item.name })),
    []
  );

  useEffect(() => {
    void loadChannels();
  }, []);

  const loadChannels = async () => {
    try {
      const { channels } = await api.channels.list();
      setChannels(channels);
    } catch (error) {
      console.error('Failed to load channels:', error);
    }
  };

  const resetForm = () => {
    setName('');
    setProvider('openai');
    setApiKey('');
    setBaseUrl(PROVIDERS.openai.defaultBaseUrl);
  };

  const handleProviderChange = (value: string | null) => {
    const nextProvider = (value || 'openai') as ProviderKey;
    setProvider(nextProvider);
    setBaseUrl(PROVIDERS[nextProvider].defaultBaseUrl);
  };

  const handleCreate = async () => {
    if (!name.trim() || !apiKey.trim()) return;

    setLoading(true);
    try {
      const { channel } = await api.channels.create({
        name: name.trim(),
        provider,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        enabled: true,
      });
      // Best-effort: try to sync model list right after creating the channel.
      try {
        const synced = await api.channels.fetchModels(channel.id);
        if (!synced.success) {
          notifyError('模型同步失败', synced.error || '无法获取模型列表');
        }
      } catch (error) {
        notifyError('模型同步失败', error instanceof Error ? error.message : '无法获取模型列表');
      }
      setModalOpen(false);
      resetForm();
      await loadChannels();
      notifySuccess('已创建渠道', '渠道已保存');
    } catch (error) {
      console.error('Failed to create channel:', error);
      notifyError('创建失败', error instanceof Error ? error.message : 'Failed to create channel');
    } finally {
      setLoading(false);
    }
  };

  const runChannelAction = async (key: string, action: () => Promise<void>) => {
    setBusyKey(key);
    try {
      await action();
    } catch (error) {
      console.error('Channel action failed:', error);
      notifyError('操作失败', error instanceof Error ? error.message : 'Operation failed');
    } finally {
      setBusyKey(null);
    }
  };

  const handleDelete = async (channelId: string) => {
    await runChannelAction(`delete:${channelId}`, async () => {
      await api.channels.delete(channelId);
      if (expandedChannelId === channelId) {
        setExpandedChannelId(null);
      }
      await loadChannels();
    });
  };

  const handleTest = async (channelId: string) => {
    await runChannelAction(`test:${channelId}`, async () => {
      const result = await api.channels.test(channelId);
      if (result.success) {
        notifySuccess('连接成功', '该渠道可用');
      } else {
        notifyError('连接失败', result.error || '无法连接该渠道');
      }
    });
  };

  const handleFetchModels = async (channelId: string) => {
    await runChannelAction(`fetch:${channelId}`, async () => {
      const result = await api.channels.fetchModels(channelId);
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch models');
      }
      await loadChannels();
      setExpandedChannelId(channelId);
    });
  };

  const handleSetDefaultChannel = async (channelId: string) => {
    await runChannelAction(`default-channel:${channelId}`, async () => {
      await api.channels.setDefault(channelId);
      await loadChannels();
    });
  };

  const updateModels = async (channel: ApiChannel, models: ApiChannelModel[]) => {
    await api.channels.updateModels(channel.id, {
      models: models.map((model) => ({
        modelId: model.modelId,
        displayName: model.displayName,
        enabled: model.enabled,
        isDefault: model.isDefault,
      })),
    });
    await loadChannels();
  };

  const handleToggleModelEnabled = async (channel: ApiChannel, modelId: string) => {
    await runChannelAction(`toggle-model:${channel.id}:${modelId}`, async () => {
      const updated = channel.models.map((model) =>
        model.modelId === modelId
          ? { ...model, enabled: !model.enabled }
          : model
      );
      await updateModels(channel, updated);
    });
  };

  const handleSetDefaultModel = async (channel: ApiChannel, modelId: string) => {
    await runChannelAction(`default-model:${channel.id}:${modelId}`, async () => {
      await api.channels.setDefaultModel(channel.id, modelId);
      await loadChannels();
    });
  };

  const toggleExpanded = (channelId: string) => {
    setExpandedChannelId((current) => current === channelId ? null : channelId);
  };

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <div>
          <Text fw={600}>AI Channels</Text>
          <Text size="sm" c="dimmed">
            Global user-level providers shared by Chat and Agent.
          </Text>
        </div>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setModalOpen(true)}>
          Add Channel
        </Button>
      </Group>

      {channels.map((channel) => {
        const isExpanded = expandedChannelId === channel.id;
        return (
          <Card key={channel.id} withBorder>
            <Stack gap="sm">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Group gap="xs" mb={4}>
                    <Text fw={600}>{channel.name}</Text>
                    {channel.isDefault && <Badge color="blue">Default</Badge>}
                    {!channel.enabled && <Badge color="gray">Disabled</Badge>}
                  </Group>
                  <Group gap="xs">
                    <Badge variant="light">{channel.provider}</Badge>
                    {channel.defaultModelId && (
                      <Badge variant="outline">{channel.defaultModelId}</Badge>
                    )}
                    <Text size="sm" c="dimmed">
                      {channel.baseUrl || 'No Base URL'}
                    </Text>
                  </Group>
                </div>

                <Group gap="xs">
                  <ActionIcon
                    variant="subtle"
                    color="blue"
                    onClick={() => void handleTest(channel.id)}
                    loading={busyKey === `test:${channel.id}`}
                  >
                    <IconCheck size={18} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color="teal"
                    onClick={() => void handleFetchModels(channel.id)}
                    loading={busyKey === `fetch:${channel.id}`}
                  >
                    <IconRefresh size={18} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color={channel.isDefault ? 'yellow' : 'gray'}
                    onClick={() => void handleSetDefaultChannel(channel.id)}
                    loading={busyKey === `default-channel:${channel.id}`}
                  >
                    <IconStar size={18} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    onClick={() => toggleExpanded(channel.id)}
                  >
                    {isExpanded ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    onClick={() => void handleDelete(channel.id)}
                    loading={busyKey === `delete:${channel.id}`}
                  >
                    <IconTrash size={18} />
                  </ActionIcon>
                </Group>
              </Group>

              <Collapse in={isExpanded}>
                <Stack gap="xs" mt="sm">
                  <Group justify="space-between">
                    <Text size="sm" fw={500}>Models</Text>
                    <Text size="xs" c="dimmed">
                      {channel.models.length} synced
                    </Text>
                  </Group>

                  {channel.models.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      No models yet. Use refresh to sync models from the provider.
                    </Text>
                  ) : (
                    channel.models.map((model) => (
                      <Card key={model.id} withBorder padding="sm">
                        <Group justify="space-between" wrap="nowrap">
                          <Group gap="sm" wrap="nowrap">
                            <Checkbox
                              checked={model.enabled}
                              onChange={() => void handleToggleModelEnabled(channel, model.modelId)}
                              disabled={busyKey === `toggle-model:${channel.id}:${model.modelId}`}
                            />
                            <div>
                              <Text size="sm" fw={500}>{model.displayName}</Text>
                              <Text size="xs" c="dimmed">{model.modelId}</Text>
                            </div>
                          </Group>
                          <Button
                            size="xs"
                            variant={model.isDefault ? 'filled' : 'light'}
                            onClick={() => void handleSetDefaultModel(channel, model.modelId)}
                            loading={busyKey === `default-model:${channel.id}:${model.modelId}`}
                          >
                            {model.isDefault ? 'Default' : 'Set Default'}
                          </Button>
                        </Group>
                      </Card>
                    ))
                  )}
                </Stack>
              </Collapse>
            </Stack>
          </Card>
        );
      })}

      {channels.length === 0 && (
        <Card withBorder>
          <Text c="dimmed" ta="center" py="xl">
            No channels configured. Add a channel to connect your models.
          </Text>
        </Card>
      )}

      <Modal opened={modalOpen} onClose={() => setModalOpen(false)} title="Add Channel">
        <Stack gap="md">
          <TextInput
            label="Name"
            placeholder="My OpenAI"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />

          <Select
            label="Provider"
            value={provider}
            onChange={handleProviderChange}
            data={providerOptions}
          />

          <TextInput
            label="Base URL"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />

          <PasswordInput
            label="API Key"
            placeholder="Enter your API key"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            required
          />

          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreate()} loading={loading}>
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>

      {busyKey && (
        <Group gap="xs">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">Applying channel update...</Text>
        </Group>
      )}
    </Stack>
  );
}
