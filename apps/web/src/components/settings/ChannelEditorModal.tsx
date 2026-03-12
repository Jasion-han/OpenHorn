'use client';

import { ActionIcon, Badge, Button, Checkbox, Group, Modal, Paper, PasswordInput, ScrollArea, Select, SimpleGrid, Stack, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useEffect, useMemo, useState } from 'react';
import { IconPlus, IconSearch, IconWand } from '@tabler/icons-react';
import { api, type ApiChannel } from '../../lib/api';
import { notifyError, notifySuccess } from '../../lib/notify';

const API_KEY_MASK = '********';
const NEW_CHANNEL_KEY = '__new__';

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

const LAST_PROVIDER_KEY = 'channels.lastProvider';
const LAST_BASEURL_KEY = 'channels.lastBaseUrl';

export type ChannelEditorModalProps = {
  opened: boolean;
  channels: ApiChannel[];
  onClose: () => void;
  onSaved: (channelId: string) => void | Promise<void>;
  applyFetchModelsOutcome: (channelId: string, result: { success: boolean; error?: string }) => void;
};

function normalizeCompareText(value: string | null | undefined) {
  return (value || '').trim();
}

function normalizeCompareBaseUrl(value: string | null | undefined) {
  return normalizeCompareText(value).replace(/\/+$/, '');
}

function readLastProvider(): ProviderKey {
  if (typeof window === 'undefined') return 'openai';
  const raw = window.localStorage.getItem(LAST_PROVIDER_KEY);
  return (raw && raw in PROVIDERS ? (raw as ProviderKey) : 'openai');
}

function readLastBaseUrl(): string {
  if (typeof window === 'undefined') return PROVIDERS.openai.defaultBaseUrl;
  return window.localStorage.getItem(LAST_BASEURL_KEY) || PROVIDERS.openai.defaultBaseUrl;
}

export function ChannelEditorModal(props: ChannelEditorModalProps) {
  const { opened, channels, onClose, onSaved, applyFetchModelsOutcome } = props;

  const isMobile = useMediaQuery('(max-width: 48em)');

  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string>(NEW_CHANNEL_KEY);

  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ProviderKey>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  const providerOptions = useMemo(
    () => Object.entries(PROVIDERS).map(([value, item]) => ({ value, label: item.name })),
    []
  );

  const sortedChannels = useMemo(() => {
    const next = channels.slice();
    next.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      if (Boolean(a.enabled) !== Boolean(b.enabled)) return a.enabled ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    return next;
  }, [channels]);

  const filteredChannels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sortedChannels;
    return sortedChannels.filter((c) => {
      return (c.name || '').toLowerCase().includes(q)
        || (c.provider || '').toLowerCase().includes(q)
        || (c.baseUrl || '').toLowerCase().includes(q);
    });
  }, [query, sortedChannels]);

  const isCreate = activeKey === NEW_CHANNEL_KEY;
  const activeChannel = useMemo(() => {
    if (isCreate) return null;
    return channels.find((c) => c.id === activeKey) || null;
  }, [activeKey, channels, isCreate]);

  const setProviderAndRemember = (next: ProviderKey) => {
    setProvider(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LAST_PROVIDER_KEY, next);
    }
  };

  const setBaseUrlAndRemember = (next: string) => {
    setBaseUrl(next);
    if (typeof window !== 'undefined' && next.trim()) {
      window.localStorage.setItem(LAST_BASEURL_KEY, next.trim());
    }
  };

  const prefillCreateDefaults = () => {
    const lastProvider = readLastProvider();
    setName('');
    setProvider(lastProvider);
    setBaseUrl(readLastBaseUrl());
    setEnabled(true);
    setApiKey('');
  };

  const prefillFromChannel = (c: ApiChannel) => {
    const p = c.provider in PROVIDERS ? (c.provider as ProviderKey) : 'openai';
    setName(c.name || '');
    setProvider(p);
    setBaseUrl(c.baseUrl || '');
    setEnabled(Boolean(c.enabled ?? true));
    setApiKey(c.hasApiKey ? API_KEY_MASK : '');
  };

  const pickDefaultChannelId = () => {
    const enabled = channels.filter((c) => c.enabled);
    const enabledDefault = enabled.find((c) => c.isDefault);
    if (enabledDefault) return enabledDefault.id;
    const anyDefault = channels.find((c) => c.isDefault);
    if (anyDefault) return anyDefault.id;
    if (channels.length === 0) return null;
    return channels
      .slice()
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]?.id || null;
  };

  useEffect(() => {
    if (!opened) return;
    setQuery('');

    if (channels.length === 0) {
      setActiveKey(NEW_CHANNEL_KEY);
      prefillCreateDefaults();
      return;
    }

    const id = pickDefaultChannelId();
    if (id) {
      setActiveKey(id);
      const c = channels.find((ch) => ch.id === id) || null;
      if (c) prefillFromChannel(c);
      return;
    }

    setActiveKey(NEW_CHANNEL_KEY);
    prefillCreateDefaults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  useEffect(() => {
    if (!opened) return;
    if (isCreate) {
      prefillCreateDefaults();
      return;
    }

    if (!activeKey || activeKey === NEW_CHANNEL_KEY) {
      setActiveKey(NEW_CHANNEL_KEY);
      return;
    }
    const c = channels.find((ch) => ch.id === activeKey) || null;
    if (c) {
      prefillFromChannel(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, opened]);

  const title = '渠道管理';
  const submitLabel = isCreate ? '创建并同步模型' : '保存并同步模型';

  const canSubmitCreate = normalizeCompareText(name) && normalizeCompareText(apiKey) && apiKey.trim() !== API_KEY_MASK;
  const canSubmitEdit = Boolean(activeChannel?.id) && normalizeCompareText(name);

  const handleSubmit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (isCreate) {
        if (!canSubmitCreate) {
          notifyError('创建失败', '请填写名称与 API Key');
          return;
        }

        const { channel: created } = await api.channels.create({
          name: name.trim(),
          provider,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || undefined,
          enabled,
        });

        const sync = await api.channels.fetchModels(created.id);
        applyFetchModelsOutcome(created.id, sync);

        notifySuccess('已创建', sync.success ? '已同步模型列表' : '模型同步结果请看该渠道的提示');
        await onSaved(created.id);
        onClose();
        return;
      }

      // edit
      if (!activeChannel?.id) {
        notifyError('保存失败', 'Channel not found');
        return;
      }
      const channel = activeChannel;

      const payload: Record<string, unknown> = {};

      if (normalizeCompareText(name) !== normalizeCompareText(channel.name)) {
        payload.name = name.trim();
      }
      if (normalizeCompareText(provider) !== normalizeCompareText(channel.provider)) {
        payload.provider = provider;
      }
      if (normalizeCompareBaseUrl(baseUrl) !== normalizeCompareBaseUrl(channel.baseUrl)) {
        payload.baseUrl = baseUrl.trim();
      }
      if (Boolean(enabled) !== Boolean(channel.enabled)) {
        payload.enabled = Boolean(enabled);
      }

      const apiKeyTrimmed = apiKey.trim();
      const wantsChangeKey = apiKeyTrimmed.length > 0 && apiKeyTrimmed !== API_KEY_MASK;
      if (wantsChangeKey) {
        payload.apiKey = apiKeyTrimmed;
      }

      if (Object.keys(payload).length > 0) {
        await api.channels.update(channel.id, payload as any);
      }

      const sync = await api.channels.fetchModels(channel.id);
      applyFetchModelsOutcome(channel.id, sync);

      notifySuccess('已保存', sync.success ? '已同步模型列表' : '模型同步结果请看该渠道的提示');
      await onSaved(channel.id);
      onClose();
    } catch (error) {
      notifyError('操作失败', error instanceof Error ? error.message : 'Operation failed');
    } finally {
      setSaving(false);
    }
  };

  const openCreate = () => {
    setActiveKey(NEW_CHANNEL_KEY);
    prefillCreateDefaults();
  };

  const openEdit = (channelId: string) => {
    setActiveKey(channelId);
    const c = channels.find((ch) => ch.id === channelId) || null;
    if (c) prefillFromChannel(c);
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={title}
      size="xl"
      radius="md"
      overlayProps={{ blur: 6, opacity: 0.55 }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          gap: 12,
          height: 'clamp(420px, 72vh, 760px)',
        }}
      >
        {!isMobile && (
          <Paper
            withBorder
            radius="md"
            p="sm"
            style={{
              flex: '0 0 35%',
              minWidth: 260,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            <Group justify="space-between" align="center" wrap="nowrap">
              <Text fw={600} style={{ whiteSpace: 'nowrap' }}>渠道</Text>
              <Button
                size="xs"
                leftSection={<IconPlus size={14} />}
                onClick={openCreate}
                variant="light"
              >
                新建
              </Button>
            </Group>

            <TextInput
              mt="sm"
              placeholder="搜索渠道..."
              leftSection={<IconSearch size={16} />}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <ScrollArea mt="sm" style={{ flex: 1 }} type="auto">
              <Stack gap={6} pr="sm">
                {filteredChannels.map((c) => {
                  const selected = c.id === activeKey;
                  return (
                    <UnstyledButton
                      key={c.id}
                      onClick={() => openEdit(c.id)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                      }}
                    >
                      <Paper
                        withBorder
                        radius="md"
                        px="sm"
                        py={8}
                        style={{
                          background: selected ? 'var(--mantine-color-blue-light)' : undefined,
                          opacity: c.enabled ? 1 : 0.72,
                        }}
                      >
                        <Group justify="space-between" wrap="nowrap" gap="xs">
                          <div style={{ minWidth: 0 }}>
                            <Text fw={600} size="sm" lineClamp={1}>
                              {c.name || '未命名渠道'}
                            </Text>
                            <Group gap={6} wrap="nowrap" mt={2}>
                              <Badge size="xs" variant="light" color="gray">
                                {c.provider}
                              </Badge>
                              {c.isDefault && (
                                <Badge size="xs" variant="outline" color="blue">
                                  默认
                                </Badge>
                              )}
                              {!c.enabled && (
                                <Badge size="xs" color="gray">
                                  已禁用
                                </Badge>
                              )}
                            </Group>
                          </div>
                          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                            {c.models.length}
                          </Text>
                        </Group>
                      </Paper>
                    </UnstyledButton>
                  );
                })}

                {filteredChannels.length === 0 && (
                  <Text size="sm" c="dimmed" ta="center" py="md">
                    没有匹配的渠道
                  </Text>
                )}
              </Stack>
            </ScrollArea>
          </Paper>
        )}

        <Paper
          withBorder
          radius="md"
          p="sm"
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Stack gap={10} style={{ flex: 1, minHeight: 0 }}>
            {isMobile && (
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <Select
                  style={{ flex: 1 }}
                  label="渠道"
                  value={isCreate ? null : activeKey}
                  placeholder="选择一个渠道..."
                  onChange={(value) => {
                    if (!value) return;
                    openEdit(value);
                  }}
                  data={sortedChannels.map((c) => ({
                    value: c.id,
                    label: `${c.name}${c.isDefault ? ' · 默认' : ''}${c.enabled ? '' : ' · 已禁用'}`,
                  }))}
                  searchable
                  nothingFoundMessage="未找到渠道"
                />
                <Button
                  mt={22}
                  size="xs"
                  leftSection={<IconPlus size={14} />}
                  onClick={openCreate}
                  variant="light"
                >
                  新建
                </Button>
              </Group>
            )}

            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Text fw={600} lineClamp={1}>
                  {isCreate ? '新建渠道' : (activeChannel?.name || '编辑渠道')}
                </Text>
                <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                  Provider 切换不会自动修改 Base URL。保存后会自动同步模型列表。
                </Text>
              </div>
              {!isCreate && activeChannel?.isDefault && (
                <Badge variant="outline" color="blue">
                  默认
                </Badge>
              )}
            </Group>

            <ScrollArea style={{ flex: 1 }} type="auto">
              <Stack gap="sm" pr="sm">
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                  <TextInput
                    label="名称"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    placeholder="例如：我的 Claude 中转"
                  />

                  <Select
                    label="厂商"
                    value={provider}
                    onChange={(value) => setProviderAndRemember((value || 'openai') as ProviderKey)}
                    data={providerOptions}
                  />
                </SimpleGrid>

                <Group align="flex-end" wrap="nowrap">
                  <TextInput
                    label="Base URL"
                    value={baseUrl}
                    onChange={(event) => setBaseUrlAndRemember(event.target.value)}
                    style={{ flex: 1 }}
                    placeholder="例如：https://api.anthropic.com"
                    styles={{
                      input: { overflowWrap: 'anywhere' as any },
                    }}
                  />
                  <Tooltip label="填入该厂商默认 Base URL" withArrow>
                    <ActionIcon
                      variant="light"
                      size={34}
                      onClick={() => setBaseUrlAndRemember(PROVIDERS[provider].defaultBaseUrl)}
                      aria-label="填入默认 Base URL"
                    >
                      <IconWand size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>

                <Checkbox
                  label="启用该渠道"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.currentTarget.checked)}
                />

                <PasswordInput
                  label="API Key"
                  placeholder={isCreate ? '输入 API Key' : '保持为 ******** 或留空表示不修改'}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  required={isCreate}
                  description={!isCreate ? '出于安全原因，Web 端不会展示已保存的明文 Key。输入新 Key 才会更新。' : undefined}
                />
              </Stack>
            </ScrollArea>

            <Group justify="flex-end" wrap="nowrap">
              <Button variant="subtle" onClick={onClose}>
                取消
              </Button>
              <Button
                onClick={() => void handleSubmit()}
                loading={saving}
                disabled={isCreate ? !canSubmitCreate : !canSubmitEdit}
              >
                {submitLabel}
              </Button>
            </Group>
          </Stack>
        </Paper>
      </div>
    </Modal>
  );
}
