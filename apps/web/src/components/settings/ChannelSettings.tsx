'use client';

import { useEffect, useRef, useState } from 'react';
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
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconCheck, IconChevronDown, IconChevronUp, IconPlus, IconRefresh, IconRobot, IconStar, IconTrash } from '@tabler/icons-react';
import { useChatStore } from '../../stores/chatStore';
import { api, type ApiChannel, type ApiChannelModel } from '../../lib/api';
import { notifyError, notifySuccess } from '../../lib/notify';
import { BACKEND_UP_EVENT } from '../../stores/backendStatusStore';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChannelEditorModal } from './ChannelEditorModal';

function getPreferredChannelToFix(channels: ApiChannel[]): ApiChannel | null {
  const enabled = channels.filter((c) => c.enabled);
  const def = enabled.find((c) => c.isDefault);
  if (def) return def;
  if (enabled.length === 0) return null;
  return enabled
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] || null;
}

export function ChannelSettings() {
  const { channels, setChannels } = useChatStore();
  const router = useRouter();
  const search = useSearchParams();
  const [editorOpen, setEditorOpen] = useState(false);
  const [agentCheckOpen, setAgentCheckOpen] = useState(false);
  const [agentCheckChannelId, setAgentCheckChannelId] = useState<string | null>(null);
  const [agentCheckModelId, setAgentCheckModelId] = useState('');
  const [expandedChannelId, setExpandedChannelId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const didApplyFocusRef = useRef(false);
  const [channelNotice, setChannelNotice] = useState<Record<string, { kind: 'error' | 'warn'; title?: string; message: string; action?: 'switch_openai' }>>({});

  useEffect(() => {
    void loadChannels();
  }, []);

  useEffect(() => {
    const onUp = () => {
      void loadChannels();
    };
    window.addEventListener(BACKEND_UP_EVENT, onUp);
    return () => {
      window.removeEventListener(BACKEND_UP_EVENT, onUp);
    };
  }, []);

  const loadChannels = async () => {
    try {
      const { channels } = await api.channels.list();
      setChannels(channels);
    } catch (error) {
      console.error('Failed to load channels:', error);
    }
  };

  const closeEditor = () => {
    setEditorOpen(false);
  };

  const openEditor = () => {
    setEditorOpen(true);
  };

  const closeAgentCheck = () => {
    setAgentCheckOpen(false);
    setAgentCheckChannelId(null);
    setAgentCheckModelId('');
  };

  const openAgentCheck = (channel: ApiChannel) => {
    setAgentCheckChannelId(channel.id);
    setAgentCheckModelId(channel.defaultModelId || channel.models.find((m) => m.isDefault)?.modelId || '');
    setAgentCheckOpen(true);
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

  const applyFetchModelsOutcome = (
    channelId: string,
    result: { success: boolean; error?: string }
  ) => {
    if (!result.success) {
      const msg = result.error || '无法获取模型列表';
      setChannelNotice((prev) => {
        const action = msg.includes('Provider') || msg.includes('OpenAI 兼容') ? 'switch_openai' : undefined;
        return { ...prev, [channelId]: { kind: 'error', title: '同步失败', message: msg, action } };
      });
      return { ok: false as const };
    }

    if (result.error) {
      setChannelNotice((prev) => ({ ...prev, [channelId]: { kind: 'warn', title: '需要处理', message: result.error || '' } }));
      return { ok: true as const, warn: true as const };
    }

    setChannelNotice((prev) => {
      if (!prev[channelId]) return prev;
      const { [channelId]: _, ...rest } = prev;
      return rest;
    });
    return { ok: true as const, warn: false as const };
  };

  const handleDelete = async (channelId: string) => {
      await runChannelAction(`delete:${channelId}`, async () => {
        await api.channels.delete(channelId);
        if (expandedChannelId === channelId) {
          setExpandedChannelId(null);
        }
        setChannelNotice((prev) => {
          if (!prev[channelId]) return prev;
          const { [channelId]: _, ...rest } = prev;
          return rest;
        });
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
      // Always refresh so UI reflects the latest state, even when sync fails.
      await loadChannels();
      setExpandedChannelId(channelId);
      const outcome = applyFetchModelsOutcome(channelId, result);
      if (outcome.ok && !outcome.warn) {
        notifySuccess('同步完成', '已更新模型列表');
      }
    });
  };

  const handleAgentCheck = async (channelId: string, modelId: string) => {
    const trimmed = modelId.trim();
    if (!trimmed) {
      notifyError('缺少模型', '请选择或输入一个 modelId');
      return;
    }

    await runChannelAction(`agent-check:${channelId}`, async () => {
      const result = await api.channels.agentCheck(channelId, { modelId: trimmed });
      if (result.success) {
        setChannelNotice((prev) => {
          if (!prev[channelId]) return prev;
          const { [channelId]: _, ...rest } = prev;
          return rest;
        });
        notifySuccess('Agent 兼容', '该渠道可用于 Agent');
        closeAgentCheck();
        return;
      }

      const msg = result.error || 'Agent 检查失败';
      setChannelNotice((prev) => ({
        ...prev,
        [channelId]: { kind: 'error', title: 'Agent 检查失败', message: msg },
      }));
      closeAgentCheck();
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

  useEffect(() => {
    if (didApplyFocusRef.current) return;
    const focus = search.get('focus');
    if (!focus) return;
    if (focus !== 'default' && focus.trim().length === 0) return;

    // If we haven't loaded channels yet, wait.
    // Channels live in a global store; "channels.length===0" could mean "not loaded" or "none".
    // We'll apply focus as soon as the store updates at least once after mount.
    didApplyFocusRef.current = true;

    const apply = () => {
      let target: ApiChannel | null = null;
      if (focus !== 'default') {
        target = channels.find((c) => c.id === focus) || null;
      }
      if (!target) {
        target = getPreferredChannelToFix(channels);
      }

      if (!target) {
        openEditor();
      } else {
        setExpandedChannelId(target.id);
        queueMicrotask(() => {
          const el = document.getElementById(`channel-${target.id}`);
          el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
      }

      // Clear focus params so refresh doesn't re-run the guide.
      const params = new URLSearchParams(search.toString());
      params.delete('focus');
      params.delete('action');
      const next = params.toString();
      router.replace(next ? `/settings?${next}` : '/settings?tab=channels');
    };

    // If channels are empty, still apply (might open modal).
    // Defer to ensure the UI is mounted.
    queueMicrotask(apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, router, search]);

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <div>
          <Text fw={600}>渠道配置</Text>
          <Text size="sm" c="dimmed">
            全局用户级配置，Chat 与 Agent 共用。
          </Text>
        </div>
        <Button leftSection={<IconPlus size={16} />} onClick={openEditor}>
          渠道编辑器
        </Button>
      </Group>

      {channels.map((channel) => {
        const isExpanded = expandedChannelId === channel.id;
        const needsDefaultModel = Boolean(channel.isDefault && channel.enabled && !channel.defaultModelId);
        const notice = channelNotice[channel.id] || null;
        const agentCheckKey = `agent-check:${channel.id}`;
        return (
          <Card key={channel.id} withBorder id={`channel-${channel.id}`}>
            <Stack gap="sm">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Group gap="xs" mb={4}>
                    <Text fw={600}>{channel.name}</Text>
                    {channel.isDefault && <Badge color="blue">默认</Badge>}
                    {needsDefaultModel && <Badge color="orange">缺少默认模型</Badge>}
                    {!channel.enabled && <Badge color="gray">已禁用</Badge>}
                  </Group>
                  <Group gap="xs">
                    <Badge variant="light">{channel.provider}</Badge>
                    {channel.defaultModelId && (
                      <Badge variant="outline">{channel.defaultModelId}</Badge>
                    )}
                    <Text size="sm" c="dimmed">
                      {channel.baseUrl || '未设置 Base URL'}
                    </Text>
                  </Group>
                </div>

                <Group gap="xs">
                  <ActionIcon
                    variant="subtle"
                    color="grape"
                    onClick={() => openAgentCheck(channel)}
                    disabled={busyKey === agentCheckKey}
                  >
                    <IconRobot size={18} />
                  </ActionIcon>
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

              {notice && (
                <Card withBorder padding="sm" bg={notice.kind === 'error' ? 'red.0' : 'orange.0'}>
                  <Group justify="space-between" wrap="nowrap" align="flex-start">
                    <div style={{ minWidth: 0 }}>
                      <Text size="sm" fw={600}>
                        {notice.title || (notice.kind === 'error' ? '同步失败' : '需要处理')}
                      </Text>
                      <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                        {notice.message}
                      </Text>
                    </div>
                    <Group gap="xs" wrap="nowrap">
                      {notice.action === 'switch_openai' && (
                        <Button
                          size="xs"
                          variant="light"
                          onClick={() => {
                            void runChannelAction(`fix-provider:${channel.id}`, async () => {
                              await api.channels.update(channel.id, { provider: 'openai' });
                              await loadChannels();
                              setChannelNotice((prev) => {
                                const { [channel.id]: _, ...rest } = prev;
                                return rest;
                              });
                              notifySuccess('已更新', '已切换为 OpenAI 兼容 Provider，请重新同步模型。');
                            });
                          }}
                        >
                          切换为 OpenAI 兼容
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="subtle"
                        onClick={() => setChannelNotice((prev) => {
                          const { [channel.id]: _, ...rest } = prev;
                          return rest;
                        })}
                      >
                        关闭
                      </Button>
                    </Group>
                  </Group>
                </Card>
              )}

              <Collapse in={isExpanded}>
                <Stack gap="xs" mt="sm">
                  <Group justify="space-between">
                    <Text size="sm" fw={500}>模型</Text>
                    <Text size="xs" c="dimmed">
                      已同步 {channel.models.length} 个
                    </Text>
                  </Group>

                  {channel.models.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      暂无模型。点击上方同步按钮拉取模型列表。
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
                            {model.isDefault ? '默认' : '设为默认'}
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
            还没有渠道。添加一个渠道来连接你的模型。
          </Text>
        </Card>
      )}

      <ChannelEditorModal
        opened={editorOpen}
        channels={channels}
        onClose={closeEditor}
        onSaved={async (channelId) => {
          await loadChannels();
          setExpandedChannelId(channelId);
        }}
        applyFetchModelsOutcome={applyFetchModelsOutcome}
      />

      <Modal
        opened={agentCheckOpen}
        onClose={closeAgentCheck}
        title="Agent 兼容性检查"
      >
        <Stack gap="md">
          {(() => {
            const channel = channels.find((c) => c.id === agentCheckChannelId) || null;
            const items = (channel?.models || []).map((m) => ({
              value: m.modelId,
              label: m.enabled ? m.displayName : `${m.displayName}（已禁用）`,
            }));

            if (!channel) {
              return (
                <Text size="sm" c="dimmed">
                  请选择一个渠道。
                </Text>
              );
            }

            if (items.length === 0) {
              return (
                <TextInput
                  label="modelId"
                  placeholder="例如：claude-4.5-sonnet"
                  value={agentCheckModelId}
                  onChange={(e) => setAgentCheckModelId(e.target.value)}
                  required
                />
              );
            }

            return (
              <Select
                label="选择 modelId"
                value={agentCheckModelId}
                onChange={(v) => setAgentCheckModelId(v || '')}
                data={items}
                searchable
                nothingFoundMessage="未找到模型"
              />
            );
          })()}

          <Group justify="flex-end">
            <Button variant="subtle" onClick={closeAgentCheck}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (!agentCheckChannelId) return;
                void handleAgentCheck(agentCheckChannelId, agentCheckModelId);
              }}
              loading={agentCheckChannelId ? busyKey === `agent-check:${agentCheckChannelId}` : false}
            >
              开始检查
            </Button>
          </Group>
        </Stack>
      </Modal>

      {busyKey && (
        <Group gap="xs">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">正在应用配置...</Text>
        </Group>
      )}
    </Stack>
  );
}
