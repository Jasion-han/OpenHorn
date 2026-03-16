'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Search, Wand2 } from 'lucide-react';
import { api, type ApiChannel } from '../../lib/api';
import { notifyError, notifySuccess } from '../../lib/notify';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { Checkbox } from '../ui/checkbox';
import { ScrollArea } from '../ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { cn } from '@/lib/utils';

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
    <Dialog open={opened} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl h-[min(72vh,760px)] flex flex-col p-0">
        <DialogHeader className="px-4 pt-4 pb-0">
          <DialogTitle>渠道管理</DialogTitle>
        </DialogHeader>
        <div className="flex flex-1 min-h-0 gap-3 p-4">
          {/* Left panel: channel list */}
          <div className="flex w-[35%] min-w-[220px] flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">渠道</span>
              <Button size="sm" variant="outline" onClick={openCreate}>
                <Plus size={14} /> 新建
              </Button>
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="搜索渠道..." value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
            </div>
            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-1 pr-2">
                {filteredChannels.map((c) => {
                  const selected = c.id === activeKey;
                  return (
                    <button
                      key={c.id}
                      onClick={() => openEdit(c.id)}
                      className={cn(
                        'w-full rounded-md border px-3 py-2 text-left transition-colors',
                        selected ? 'bg-accent border-primary' : 'hover:bg-accent/50',
                        !c.enabled && 'opacity-70'
                      )}
                    >
                      <p className="text-sm font-semibold truncate">{c.name || '未命名渠道'}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <Badge variant="secondary" className="text-xs px-1 py-0">{c.provider}</Badge>
                        {c.isDefault && <Badge variant="outline" className="text-xs px-1 py-0">默认</Badge>}
                        {!c.enabled && <Badge variant="secondary" className="text-xs px-1 py-0">已禁用</Badge>}
                      </div>
                    </button>
                  );
                })}
                {filteredChannels.length === 0 && (
                  <p className="text-center text-sm text-muted-foreground py-4">没有匹配的渠道</p>
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Right panel: form */}
          <div className="flex flex-1 min-w-0 flex-col rounded-lg border p-3">
            <div className="flex items-start justify-between mb-3">
              <div className="min-w-0">
                <p className="font-semibold truncate">{isCreate ? '新建渠道' : (activeChannel?.name || '编辑渠道')}</p>
                <p className="text-xs text-muted-foreground">Provider 切换不会自动修改 Base URL。保存后会自动同步模型列表。</p>
              </div>
              {!isCreate && (
                <div className="flex items-center gap-1.5 shrink-0">
                  {activeChannel?.isDefault && <Badge variant="outline">默认</Badge>}
                  {activeChannel && !activeChannel.enabled && <Badge variant="secondary">已禁用</Badge>}
                </div>
              )}
            </div>

            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-3 pr-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>名称 *</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：我的 Claude 中转" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>厂商</Label>
                    <Select value={provider} onValueChange={(v) => setProviderAndRemember(v as ProviderKey)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {providerOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Base URL</Label>
                  <div className="flex gap-2">
                    <Input
                      value={baseUrl}
                      onChange={(e) => setBaseUrlAndRemember(e.target.value)}
                      placeholder="例如：https://api.anthropic.com"
                      className="flex-1"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      title="填入该厂商默认 Base URL"
                      onClick={() => setBaseUrlAndRemember(PROVIDERS[provider].defaultBaseUrl)}
                    >
                      <Wand2 size={16} />
                    </Button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Checkbox
                    id="channel-enabled"
                    checked={enabled}
                    onCheckedChange={(checked) => setEnabled(Boolean(checked))}
                  />
                  <Label htmlFor="channel-enabled">启用该渠道</Label>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>API Key {isCreate && '*'}</Label>
                  <Input
                    type="password"
                    placeholder={isCreate ? '输入 API Key' : '保持为 ******** 或留空表示不修改'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  {!isCreate && (
                    <p className="text-xs text-muted-foreground">出于安全原因，Web 端不会展示已保存的明文 Key。输入新 Key 才会更新。</p>
                  )}
                </div>
              </div>
            </ScrollArea>

            <div className="flex justify-end gap-2 mt-3">
              <Button variant="ghost" onClick={onClose}>取消</Button>
              <Button
                onClick={() => void handleSubmit()}
                disabled={saving || (isCreate ? !canSubmitCreate : !canSubmitEdit)}
              >
                {saving ? '处理中...' : (isCreate ? '创建并同步模型' : '保存并同步模型')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
