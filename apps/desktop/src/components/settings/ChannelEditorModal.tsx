import { Plus, Search, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  cn,
} from "ui";
import { getCredentialKey, listCredentialSources } from "../../lib/credentialApi";
import { createServerApi } from "../../lib/serverApi";
import type { Channel } from "../../types/chat";
import { DesktopProviderLogo } from "../chat/DesktopProviderLogo";

const api = createServerApi();
const API_KEY_MASK = "********";
const NEW_CHANNEL_KEY = "__new__";

const CHANNEL_PROTOCOLS = {
  openai: {
    label: "OpenAI 兼容",
    baseUrl: "https://api.openai.com/v1",
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
  },
  google: {
    label: "Google",
    baseUrl: "https://generativelanguage.googleapis.com",
  },
} as const;

type ChannelProtocol = keyof typeof CHANNEL_PROTOCOLS;

const COMMON_PROVIDER_PRESETS = [
  {
    value: "openai",
    label: "OpenAI",
    protocol: "openai" as const,
    baseUrl: "https://api.openai.com/v1",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    protocol: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    protocol: "openai" as const,
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    value: "google",
    label: "Google",
    protocol: "google" as const,
    baseUrl: "https://generativelanguage.googleapis.com",
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

function inferProtocolFromProvider(
  provider: string | null | undefined,
  baseUrl: string | null | undefined,
  fallback: ChannelProtocol = "openai",
): ChannelProtocol {
  const normalized = `${normalizeCompareText(provider)} ${normalizeCompareText(baseUrl)}`
    .trim()
    .toLowerCase();

  if (!normalized) return fallback;
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "anthropic";
  if (
    normalized.includes("google") ||
    normalized.includes("gemini") ||
    normalized.includes("generativelanguage")
  ) {
    return "google";
  }
  if (normalized.includes("openai") || normalized.includes("deepseek")) return "openai";
  return fallback;
}

function getDefaultBaseUrlForProvider(
  provider: string | null | undefined,
  baseUrl: string | null | undefined,
  fallback: ChannelProtocol = "openai",
) {
  const protocol = inferProtocolFromProvider(provider, baseUrl, fallback);
  return CHANNEL_PROTOCOLS[protocol].baseUrl;
}

export function ChannelEditorModal(props: ChannelEditorModalProps) {
  const { opened, channels, initialChannelId, onClose, onSaved, applyFetchModelsOutcome } = props;

  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string>(NEW_CHANNEL_KEY);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("openai");
  const [baseUrl, setBaseUrl] = useState<string>(CHANNEL_PROTOCOLS.openai.baseUrl);
  const [enabled, setEnabled] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [envKeySources, setEnvKeySources] = useState<Array<{ id: string; provider: string; sourceName: string }>>([]);
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
    setBaseUrl(CHANNEL_PROTOCOLS.openai.baseUrl);
    setEnabled(true);
    setApiKey("");
    setFormNotice(null);
  };

  const prefillFromChannel = (channel: Channel) => {
    setName(channel.name || "");
    setProvider(channel.provider || "");
    setBaseUrl(
      channel.baseUrl ||
        getDefaultBaseUrlForProvider(channel.provider, channel.baseUrl, channel.protocol || "openai"),
    );
    setEnabled(Boolean(channel.enabled));
    setApiKey(channel.hasApiKey ? API_KEY_MASK : "");
    setFormNotice(null);
  };

  const pickInitialChannelId = () => {
    const defaultChannel = channels.find((channel) => channel.isDefault);
    if (defaultChannel) return defaultChannel.id;
    return channels[0]?.id || null;
  };

  const loadEnvSources = useCallback(async () => {
    try {
      const all = await listCredentialSources();
      setEnvKeySources(
        all
          .filter((s) => s.sourceType === "env_var" && s.status === "available")
          .map((s) => ({ id: s.id, provider: s.provider, sourceName: s.sourceName })),
      );
    } catch {
      setEnvKeySources([]);
    }
  }, []);

  useEffect(() => {
    if (!opened) return;
    loadEnvSources();

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

  const suggestedBaseUrl = getDefaultBaseUrlForProvider(
    provider,
    baseUrl,
    activeChannel?.protocol || "openai",
  );
  const canSubmitCreate =
    Boolean(normalizeCompareText(name)) &&
    Boolean(normalizeCompareText(apiKey)) &&
    apiKey.trim() !== API_KEY_MASK;
  const canSubmitEdit = Boolean(activeChannel?.id) && Boolean(normalizeCompareText(name));

  const handleSubmit = async () => {
    if (saving) return;

    const trimmedName = name.trim();
    const trimmedProvider = provider.trim();
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedApiKey = apiKey.trim();

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
    }

    setSaving(true);
    setFormNotice(null);

    try {
      if (isCreate) {
        const { channel } = await api.channels.create({
          name: trimmedName,
          provider: trimmedProvider,
          protocol: inferProtocolFromProvider(trimmedProvider, trimmedBaseUrl, "openai"),
          apiKey: trimmedApiKey,
          baseUrl: trimmedBaseUrl || undefined,
          enabled,
        });

        const sync = await api.channels.fetchModels(channel.id);
        const syncOutcome = applyFetchModelsOutcome(channel.id, sync);
        await onSaved(channel.id, {
          kind: syncOutcome.ok ? (syncOutcome.warn ? "warn" : "success") : "warn",
          title: "渠道已创建",
          message: !syncOutcome.ok
            ? "渠道已保存，但模型同步失败。请看列表中的提示并继续处理。"
            : syncOutcome.warn
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
      if (
        inferProtocolFromProvider(trimmedProvider, trimmedBaseUrl, activeChannel.protocol) !==
        activeChannel.protocol
      ) {
        payload.protocol = inferProtocolFromProvider(
          trimmedProvider,
          trimmedBaseUrl,
          activeChannel.protocol,
        );
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
        kind: syncOutcome.ok ? (syncOutcome.warn ? "warn" : "success") : "warn",
        title: "渠道已保存",
        message: !syncOutcome.ok
          ? "已保存渠道，但模型同步失败。请看列表中的提示并继续处理。"
          : syncOutcome.warn
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
      <DialogContent className="flex h-[min(72vh,760px)] max-w-4xl flex-col p-0">
        <DialogHeader className="px-4 pt-4 pb-0">
          <DialogTitle>渠道管理</DialogTitle>
          <DialogDescription className="sr-only">
            管理桌面端渠道配置，包括 provider、Base URL、API Key 和模型同步。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-3 p-4">
          <div className="flex w-[35%] min-w-[220px] flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">渠道</span>
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

            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-1 pr-2">
                {filteredChannels.map((channel) => {
                  const selected = channel.id === activeKey;
                  return (
                    <button
                      key={channel.id}
                      type="button"
                      onClick={() => openEdit(channel.id)}
                      className={cn(
                        "w-full rounded-md border px-3 py-2 text-left transition-colors",
                        selected ? "border-primary bg-accent" : "hover:bg-accent/50",
                        !channel.enabled && "opacity-70",
                      )}
                    >
                      <p className="truncate text-sm font-semibold">{channel.name || "未命名渠道"}</p>
                      <div className="mt-0.5 flex items-center gap-1">
                        <Badge
                          variant="secondary"
                          className="gap-1 px-1 py-0 text-xs"
                          title={channel.provider}
                        >
                          <DesktopProviderLogo provider={channel.provider} className="size-4" />
                          <span className="sr-only">{channel.provider}</span>
                        </Badge>
                        {channel.isDefault && (
                          <Badge variant="outline" className="px-1 py-0 text-xs">
                            默认
                          </Badge>
                        )}
                        {!channel.enabled && (
                          <Badge variant="secondary" className="px-1 py-0 text-xs">
                            已禁用
                          </Badge>
                        )}
                      </div>
                    </button>
                  );
                })}

                {filteredChannels.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">没有匹配的渠道</p>
                )}
              </div>
            </ScrollArea>
          </div>

          <div className="flex min-w-0 flex-1 flex-col rounded-lg border p-3">
            <div className="mb-3 flex items-start justify-between">
              <div className="min-w-0">
                <p className="truncate font-semibold">
                  {isCreate ? "新建渠道" : activeChannel?.name || "编辑渠道"}
                </p>
                <p className="text-xs text-muted-foreground">
                  provider 用于标识该渠道兼容的接口类型，保存后会自动同步模型列表。
                </p>
              </div>
              {!isCreate && (
                <div className="flex shrink-0 items-center gap-1.5">
                  {activeChannel?.isDefault && <Badge variant="outline">默认</Badge>}
                  {activeChannel && !activeChannel.enabled && <Badge variant="secondary">已禁用</Badge>}
                </div>
              )}
            </div>

            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-3 pr-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="channel-name">名称 *</Label>
                    <Input
                      id="channel-name"
                      placeholder="例如：我的 Claude 中转"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="channel-provider">Provider</Label>
                    <Input
                      id="channel-provider"
                      placeholder="例如：anthropic / openrouter / my-relay"
                      value={provider}
                      onChange={(event) => setProvider(event.target.value)}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>常见预设</Label>
                  <div className="flex flex-wrap gap-2">
                    {COMMON_PROVIDER_PRESETS.map((preset) => (
                      <Button
                        key={preset.value}
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => applyPreset(preset.value)}
                      >
                        <DesktopProviderLogo provider={preset.value} className="size-4" />
                        <span>{preset.label}</span>
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="channel-base-url">Base URL</Label>
                  <div className="flex gap-2">
                    <Input
                      id="channel-base-url"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder="例如：https://api.anthropic.com"
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      title="填入当前默认 Base URL"
                      onClick={() => setBaseUrl(suggestedBaseUrl)}
                    >
                      <Wand2 size={16} />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">当前建议地址：{suggestedBaseUrl}</p>
                  <p className="text-xs text-muted-foreground">
                    会根据 provider 与 Base URL 自动判断兼容链路；中转服务填写兼容类型即可。
                  </p>
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
                  <Label htmlFor="channel-api-key">API Key {isCreate && "*"}</Label>
                  <Input
                    id="channel-api-key"
                    type="password"
                    placeholder={isCreate ? "输入 API Key" : "保持为 ******** 或留空表示不修改"}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  {!isCreate && (
                    <p className="text-xs text-muted-foreground">
                      出于安全原因，不会展示已保存的明文 Key。输入新 Key 才会更新。
                    </p>
                  )}
                  {envKeySources.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {envKeySources
                        .filter((s) => {
                          const prot = inferProtocolFromProvider(provider, baseUrl);
                          if (prot === "anthropic") return s.provider === "anthropic";
                          if (prot === "google") return s.provider === "google";
                          return s.provider === "openai";
                        })
                        .map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            className="rounded border border-green-300 bg-green-50 px-2 py-0.5 text-xs text-green-700 hover:bg-green-100 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50"
                            onClick={async () => {
                              try {
                                const key = await getCredentialKey(s.id);
                                setApiKey(key);
                                setFormNotice({ kind: "success", title: "已填入", message: `已使用 ${s.sourceName} 的 API Key` });
                              } catch (err) {
                                setFormNotice({ kind: "error", title: "获取失败", message: err instanceof Error ? err.message : "未知错误" });
                              }
                            }}
                          >
                            从 {s.sourceName} 填入
                          </button>
                        ))}
                    </div>
                  )}
                </div>

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
            </ScrollArea>

            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={saving}>
                取消
              </Button>
              <Button
                onClick={() => void handleSubmit()}
                disabled={saving || (isCreate ? !canSubmitCreate : !canSubmitEdit)}
              >
                {saving ? "处理中..." : isCreate ? "创建并同步模型" : "保存并同步模型"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
