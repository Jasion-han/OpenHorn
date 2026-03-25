import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  cn,
} from "ui";
import { createServerApi } from "../../lib/serverApi";
import type { Channel } from "../../types/chat";
import { DesktopProviderLogo } from "../chat/DesktopProviderLogo";

const api = createServerApi();
const API_KEY_MASK = "********";
const NEW_CHANNEL_KEY = "__new__";

const COMMON_PROVIDER_PRESETS = [
  {
    value: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    hint: "OpenAI 兼容",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    hint: "Anthropic 协议",
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    hint: "OpenAI 兼容",
  },
  {
    value: "google",
    label: "Google",
    baseUrl: "https://generativelanguage.googleapis.com",
    hint: "Gemini 原生",
  },
] as const;

type NoticeKind = "success" | "error" | "warn";

export type SettingsNotice = {
  kind: NoticeKind;
  title: string;
  message: string;
};

export type ChannelEditorModalProps = {
  opened: boolean;
  channels: Channel[];
  initialChannelId?: string | null;
  onClose: () => void;
  onSaved: (channelId: string, notice: SettingsNotice) => void | Promise<void>;
  applyFetchModelsOutcome: (
    channelId: string,
    result: { success: boolean; error?: string },
  ) => { ok: boolean; warn: boolean };
};

function normalizeCompareText(value: string | null | undefined) {
  return (value || "").trim();
}

function normalizeCompareBaseUrl(value: string | null | undefined) {
  return normalizeCompareText(value).replace(/\/+$/, "");
}

function getProviderPreset(provider: string | null | undefined) {
  const normalized = normalizeCompareText(provider).toLowerCase();
  return COMMON_PROVIDER_PRESETS.find((item) => item.value === normalized) || null;
}

function providerNeedsExplicitBaseUrl(provider: string | null | undefined) {
  return !getProviderPreset(provider);
}

export function ChannelEditorModal(props: ChannelEditorModalProps) {
  const { opened, channels, initialChannelId, onClose, onSaved, applyFetchModelsOutcome } = props;

  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string>(NEW_CHANNEL_KEY);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [enabled, setEnabled] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [formNotice, setFormNotice] = useState<SettingsNotice | null>(null);

  const sortedChannels = useMemo(() => {
    const next = channels.slice();
    next.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return next;
  }, [channels]);

  const filteredChannels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sortedChannels;

    return sortedChannels.filter((channel) => {
      return (
        channel.name.toLowerCase().includes(normalized) ||
        channel.provider.toLowerCase().includes(normalized) ||
        (channel.baseUrl || "").toLowerCase().includes(normalized)
      );
    });
  }, [query, sortedChannels]);

  const isCreate = activeKey === NEW_CHANNEL_KEY;
  const activeChannel = useMemo(() => {
    if (isCreate) return null;
    return channels.find((channel) => channel.id === activeKey) || null;
  }, [activeKey, channels, isCreate]);

  const prefillCreate = () => {
    setName("");
    setProvider("openai");
    setBaseUrl("https://api.openai.com/v1");
    setEnabled(true);
    setApiKey("");
    setFormNotice(null);
  };

  const prefillFromChannel = (channel: Channel) => {
    setName(channel.name || "");
    setProvider(channel.provider || "");
    setBaseUrl(channel.baseUrl || getProviderPreset(channel.provider)?.baseUrl || "");
    setEnabled(Boolean(channel.enabled));
    setApiKey(channel.hasApiKey ? API_KEY_MASK : "");
    setFormNotice(null);
  };

  const pickInitialChannelId = () => {
    const defaultChannel = channels.find((channel) => channel.isDefault);
    if (defaultChannel) return defaultChannel.id;
    return channels[0]?.id || null;
  };

  useEffect(() => {
    if (!opened) return;

    setQuery("");

    if (initialChannelId === NEW_CHANNEL_KEY) {
      setActiveKey(NEW_CHANNEL_KEY);
      prefillCreate();
      return;
    }

    const targetedChannel =
      initialChannelId && initialChannelId !== NEW_CHANNEL_KEY
        ? channels.find((channel) => channel.id === initialChannelId) || null
        : null;

    if (targetedChannel) {
      setActiveKey(targetedChannel.id);
      prefillFromChannel(targetedChannel);
      return;
    }

    if (channels.length === 0) {
      setActiveKey(NEW_CHANNEL_KEY);
      prefillCreate();
      return;
    }

    const nextId = pickInitialChannelId();
    if (nextId) {
      setActiveKey(nextId);
      const nextChannel = channels.find((channel) => channel.id === nextId) || null;
      if (nextChannel) {
        prefillFromChannel(nextChannel);
        return;
      }
    }

    setActiveKey(NEW_CHANNEL_KEY);
    prefillCreate();
  }, [channels, initialChannelId, opened]);

  const openCreate = () => {
    setActiveKey(NEW_CHANNEL_KEY);
    prefillCreate();
  };

  const openEdit = (channelId: string) => {
    setActiveKey(channelId);
    const nextChannel = channels.find((channel) => channel.id === channelId) || null;
    if (nextChannel) {
      prefillFromChannel(nextChannel);
    }
  };

  const applyPreset = (value: string) => {
    const preset = getProviderPreset(value);
    if (!preset) return;
    setProvider(preset.value);
    setBaseUrl(preset.baseUrl);
  };

  const handleSubmit = async () => {
    if (saving) return;

    const trimmedName = name.trim();
    const trimmedProvider = provider.trim();
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedApiKey = apiKey.trim();
    const nextBaseUrl = trimmedBaseUrl || activeChannel?.baseUrl || "";

    if (!trimmedName) {
      setFormNotice({ kind: "error", title: "无法保存", message: "请填写渠道名称。" });
      return;
    }

    if (!trimmedProvider) {
      setFormNotice({ kind: "error", title: "无法保存", message: "请填写 provider。" });
      return;
    }

    if (isCreate) {
      if (!trimmedApiKey || trimmedApiKey === API_KEY_MASK) {
        setFormNotice({ kind: "error", title: "无法创建", message: "请填写 API Key。" });
        return;
      }
      if (providerNeedsExplicitBaseUrl(trimmedProvider) && !trimmedBaseUrl) {
        setFormNotice({
          kind: "error",
          title: "无法创建",
          message: "自定义 provider 需要显式填写 Base URL。",
        });
        return;
      }
    } else if (providerNeedsExplicitBaseUrl(trimmedProvider) && !nextBaseUrl) {
      setFormNotice({
        kind: "error",
        title: "无法保存",
        message: "自定义 provider 需要显式填写 Base URL。",
      });
      return;
    }

    setSaving(true);
    setFormNotice(null);

    try {
      if (isCreate) {
        const { channel } = await api.channels.create({
          name: trimmedName,
          provider: trimmedProvider,
          apiKey: trimmedApiKey,
          baseUrl: trimmedBaseUrl || undefined,
          enabled,
        });

        const sync = await api.channels.fetchModels(channel.id);
        const syncOutcome = applyFetchModelsOutcome(channel.id, sync);
        await onSaved(channel.id, {
          kind: syncOutcome.warn ? "warn" : "success",
          title: "渠道已创建",
          message: syncOutcome.warn
            ? "渠道已保存，模型同步结果请看列表中的提示。"
            : "渠道已保存，并已同步模型列表。",
        });
        onClose();
        return;
      }

      if (!activeChannel) {
        setFormNotice({ kind: "error", title: "无法保存", message: "目标渠道不存在。" });
        return;
      }

      const payload: Parameters<typeof api.channels.update>[1] = {};

      if (normalizeCompareText(trimmedName) !== normalizeCompareText(activeChannel.name)) {
        payload.name = trimmedName;
      }
      if (normalizeCompareText(trimmedProvider) !== normalizeCompareText(activeChannel.provider)) {
        payload.provider = trimmedProvider;
      }
      if (normalizeCompareBaseUrl(trimmedBaseUrl) !== normalizeCompareBaseUrl(activeChannel.baseUrl)) {
        payload.baseUrl = trimmedBaseUrl;
      }
      if (Boolean(enabled) !== Boolean(activeChannel.enabled)) {
        payload.enabled = enabled;
      }
      if (trimmedApiKey && trimmedApiKey !== API_KEY_MASK) {
        payload.apiKey = trimmedApiKey;
      }

      if (Object.keys(payload).length > 0) {
        await api.channels.update(activeChannel.id, payload);
      }

      const sync = await api.channels.fetchModels(activeChannel.id);
      const syncOutcome = applyFetchModelsOutcome(activeChannel.id, sync);
      await onSaved(activeChannel.id, {
        kind: syncOutcome.warn ? "warn" : "success",
        title: "渠道已保存",
        message: syncOutcome.warn
          ? "已保存渠道，模型同步结果请看列表中的提示。"
          : "已保存渠道，并已同步模型列表。",
      });
      onClose();
    } catch (error) {
      setFormNotice({
        kind: "error",
        title: "操作失败",
        message: error instanceof Error ? error.message : "无法保存当前渠道。",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={opened} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="flex h-[min(76vh,820px)] max-w-5xl flex-col p-0">
        <DialogHeader className="px-4 pt-4 pb-0">
          <DialogTitle>{isCreate ? "新增渠道" : "编辑渠道"}</DialogTitle>
          <DialogDescription className="sr-only">
            管理桌面端渠道配置，包括 provider、Base URL、API Key 和模型同步。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-3 p-4">
          <div className="flex w-[36%] min-w-[240px] flex-col gap-2 rounded-xl border border-border/60 bg-muted/10 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">渠道列表</span>
              <Button size="sm" variant="outline" onClick={openCreate}>
                <Plus size={14} /> 新建
              </Button>
            </div>

            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                placeholder="搜索渠道..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-8"
              />
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-1.5 pr-2">
                {filteredChannels.map((channel) => {
                  const selected = channel.id === activeKey;
                  return (
                    <button
                      key={channel.id}
                      type="button"
                      onClick={() => openEdit(channel.id)}
                      className={cn(
                        "rounded-lg border px-3 py-2 text-left transition-colors",
                        selected
                          ? "border-primary bg-accent"
                          : "border-border/60 hover:bg-accent/50",
                        !channel.enabled && "opacity-75",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <DesktopProviderLogo provider={channel.provider} />
                        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{channel.name}</p>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
                          {channel.provider}
                        </Badge>
                        {channel.isDefault && <Badge className="px-1.5 py-0 text-[11px]">默认</Badge>}
                        {!channel.enabled && (
                          <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                            已禁用
                          </Badge>
                        )}
                        {channel.hasApiKey && (
                          <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                            已配置 Key
                          </Badge>
                        )}
                      </div>
                    </button>
                  );
                })}

                {filteredChannels.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-sm text-muted-foreground">
                    没有匹配的渠道
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-4 rounded-xl border border-border/60 bg-background p-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="channel-name">渠道名称</Label>
                {!isCreate && activeChannel?.isDefault && <Badge>当前默认渠道</Badge>}
              </div>
              <Input
                id="channel-name"
                placeholder="例如：Anthropic 官方 / Relay A"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="channel-provider">Provider</Label>
              <Input
                id="channel-provider"
                placeholder="例如：anthropic / openai / my-relay"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                {COMMON_PROVIDER_PRESETS.map((preset) => (
                  <Button
                    key={preset.value}
                    type="button"
                    size="sm"
                    variant={provider.trim().toLowerCase() === preset.value ? "default" : "outline"}
                    onClick={() => applyPreset(preset.value)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                使用 <code>anthropic</code> 可走 Anthropic 协议。其他任意 provider 默认按
                OpenAI 兼容协议处理；若不是上面的常见 provider，请手动填写 Base URL。
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="channel-base-url">Base URL</Label>
              <Input
                id="channel-base-url"
                placeholder="留空时将按常见 provider 默认值处理"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              {getProviderPreset(provider) ? (
                <p className="text-xs text-muted-foreground">
                  当前常见 provider 默认地址：{getProviderPreset(provider)?.baseUrl}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  自定义 provider 需要你提供完整 Base URL。
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="channel-api-key">API Key</Label>
              <Input
                id="channel-api-key"
                type="password"
                placeholder={isCreate ? "sk-..." : "留空表示不修改"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>

            <label className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
              <Checkbox
                checked={enabled}
                onCheckedChange={(value) => setEnabled(Boolean(value))}
              />
              <div className="space-y-0.5">
                <p className="text-sm font-medium">启用渠道</p>
                <p className="text-xs text-muted-foreground">
                  禁用后该渠道不会出现在模型选择和默认配置中。
                </p>
              </div>
            </label>

            {formNotice && (
              <div
                className={cn(
                  "rounded-lg border px-3 py-2",
                  formNotice.kind === "error"
                    ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200"
                    : formNotice.kind === "warn"
                      ? "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/70 dark:bg-orange-950/40 dark:text-orange-200"
                      : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-200",
                )}
              >
                <p className="text-sm font-semibold">{formNotice.title}</p>
                <p className="mt-1 text-sm">{formNotice.message}</p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="px-4 pb-4">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={saving}>
            {saving ? "保存中..." : isCreate ? "创建渠道" : "保存变更"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
