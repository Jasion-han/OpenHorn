'use client';

import { Button, Checkbox, Group, Modal, PasswordInput, Select, Stack, TextInput } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { api, type ApiChannel } from '../../lib/api';
import { notifyError, notifySuccess } from '../../lib/notify';

const API_KEY_MASK = '********';

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

export type ChannelEditorMode = 'create' | 'edit';

export type ChannelEditorModalProps = {
  opened: boolean;
  mode: ChannelEditorMode;
  channel?: ApiChannel | null;
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
  const { opened, mode, channel, onClose, onSaved, applyFetchModelsOutcome } = props;

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

  useEffect(() => {
    if (!opened) return;

    if (mode === 'edit') {
      const c = channel;
      const p = c && c.provider in PROVIDERS ? (c.provider as ProviderKey) : 'openai';
      setName(c?.name || '');
      setProvider(p);
      setBaseUrl(c?.baseUrl || '');
      setEnabled(Boolean(c?.enabled ?? true));
      setApiKey(c?.hasApiKey ? API_KEY_MASK : '');
      return;
    }

    // create
    const lastProvider = readLastProvider();
    setName('');
    setProvider(lastProvider);
    setBaseUrl(readLastBaseUrl());
    setEnabled(true);
    setApiKey('');
  }, [opened, mode, channel?.id]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LAST_PROVIDER_KEY, provider);
  }, [provider]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (baseUrl.trim()) {
      window.localStorage.setItem(LAST_BASEURL_KEY, baseUrl.trim());
    }
  }, [baseUrl]);

  const title = mode === 'create' ? '添加渠道' : '编辑渠道';
  const submitLabel = mode === 'create' ? '创建并同步模型' : '保存并同步模型';

  const canSubmitCreate = normalizeCompareText(name) && normalizeCompareText(apiKey) && apiKey.trim() !== API_KEY_MASK;

  const handleSubmit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (mode === 'create') {
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
      if (!channel?.id) {
        notifyError('保存失败', 'Channel not found');
        return;
      }

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

  return (
    <Modal opened={opened} onClose={onClose} title={title}>
      <Stack gap="md">
        <TextInput
          label="名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />

        <Select
          label="厂商"
          value={provider}
          onChange={(value) => setProvider((value || 'openai') as ProviderKey)}
          data={providerOptions}
        />

        <Group align="flex-end">
          <TextInput
            label="Base URL"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            style={{ flex: 1 }}
          />
          <Button size="xs" variant="light" onClick={() => setBaseUrl(PROVIDERS[provider].defaultBaseUrl)}>
            填入默认
          </Button>
        </Group>

        <Checkbox
          label="启用该渠道"
          checked={enabled}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
        />

        <PasswordInput
          label="API Key"
          placeholder={mode === 'create' ? '输入 API Key' : '留空或保持为掩码表示不修改'}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          required={mode === 'create'}
          description={mode === 'edit' ? '出于安全原因，Web 端不会展示已保存的明文 Key。输入新 Key 才会更新。' : undefined}
        />

        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} loading={saving} disabled={mode === 'create' ? !canSubmitCreate : false}>
            {submitLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

