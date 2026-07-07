import { Plus, Search, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui";
import { getCredentialKey, listCredentialSources } from "../../lib/credentialApi";
import { formatChannelLabel, getChannelLabel, getCredentialLabel } from "../../lib/i18n/agent";
import { createServerApi } from "../../lib/serverApi";
import type { DetectedCredential } from "../../lib/sidecarClient";
import { useSidecarStore } from "../../stores/sidecarStore";
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
    value: "google",
    label: "Google",
    protocol: "google" as const,
    baseUrl: "https://generativelanguage.googleapis.com",
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    protocol: "openai" as const,
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    value: "qwen",
    label: "通义千问",
    protocol: "openai" as const,
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    value: "kimi",
    label: "Kimi",
    protocol: "openai" as const,
    baseUrl: "https://api.moonshot.cn/v1",
  },
  {
    value: "glm",
    label: "GLM",
    protocol: "openai" as const,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    value: "doubao",
    label: "豆包",
    protocol: "openai" as const,
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  {
    value: "minimax",
    label: "MiniMax",
    protocol: "openai" as const,
    baseUrl: "https://api.minimax.chat/v1",
  },
  {
    value: "ollama",
    label: "Ollama",
    protocol: "openai" as const,
    baseUrl: "http://localhost:11434/v1",
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
  const [envKeySources, setEnvKeySources] = useState<
    Array<{ id: string; provider: string; sourceName: string }>
  >([]);
  const [sidecarCredentials, setSidecarCredentials] = useState<DetectedCredential[]>([]);
  const [authSource, setAuthSource] = useState<"manual" | "local">("manual");
  const [saving, setSaving] = useState(false);
  const [formNotice, setFormNotice] = useState<SettingsNotice | null>(null);

  const sidecarClient = useSidecarStore((state) => state.client);
  const sidecarStatus = useSidecarStore((state) => state.status);

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
    setAuthSource("manual");
    setFormNotice(null);
  };

  const prefillFromChannel = (channel: Channel) => {
    setName(channel.name || "");
    setProvider(channel.provider || "");
    setBaseUrl(
      channel.baseUrl ||
        getDefaultBaseUrlForProvider(
          channel.provider,
          channel.baseUrl,
          channel.protocol || "openai",
        ),
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

    // Load sidecar-detected credentials
    if (sidecarClient && sidecarStatus === "ready") {
      try {
        const detected = await sidecarClient.detectCredentials();
        setSidecarCredentials(detected);
      } catch {
        setSidecarCredentials([]);
      }
    }
  }, [sidecarClient, sidecarStatus]);

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
  const matchingSidecarCredentials = useMemo(() => {
    const protocol = inferProtocolFromProvider(provider, baseUrl);
    return sidecarCredentials.filter((cred) => {
      if (protocol === "anthropic") return cred.provider === "anthropic";
      if (protocol === "google") return cred.provider === "google";
      return cred.provider === "openai";
    });
  }, [sidecarCredentials, provider, baseUrl]);

  const canSubmitCreate =
    authSource === "local"
      ? Boolean(normalizeCompareText(name)) && matchingSidecarCredentials.length > 0
      : Boolean(normalizeCompareText(name)) &&
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
      setFormNotice({
        kind: "error",
        title: getChannelLabel("settings.channel.editor.saveErrorTitle"),
        message: getChannelLabel("settings.channel.editor.nameRequired"),
      });
      return;
    }

    if (!trimmedProvider) {
      setFormNotice({
        kind: "error",
        title: getChannelLabel("settings.channel.editor.saveErrorTitle"),
        message: getChannelLabel("settings.channel.editor.providerRequired"),
      });
      return;
    }

    if (isCreate && authSource === "manual") {
      if (!trimmedApiKey || trimmedApiKey === API_KEY_MASK) {
        setFormNotice({
          kind: "error",
          title: getChannelLabel("settings.channel.editor.createErrorTitle"),
          message: getChannelLabel("settings.channel.editor.apiKeyRequired"),
        });
        return;
      }
    }

    if (isCreate && authSource === "local" && matchingSidecarCredentials.length === 0) {
      setFormNotice({
        kind: "error",
        title: getChannelLabel("settings.channel.editor.createErrorTitle"),
        message: getChannelLabel("settings.channel.editor.noLocalAuth"),
      });
      return;
    }

    setSaving(true);
    setFormNotice(null);

    try {
      if (isCreate) {
        const resolvedApiKey =
          authSource === "local" && matchingSidecarCredentials.length > 0
            ? `__sidecar_auto__:${matchingSidecarCredentials[0].source}`
            : trimmedApiKey;

        const { channel } = await api.channels.create({
          name: trimmedName,
          provider: trimmedProvider,
          protocol: inferProtocolFromProvider(trimmedProvider, trimmedBaseUrl, "openai"),
          apiKey: resolvedApiKey,
          baseUrl: trimmedBaseUrl || undefined,
          enabled,
        });

        const sync = await api.channels.fetchModels(channel.id);
        const syncOutcome = applyFetchModelsOutcome(channel.id, sync);
        await onSaved(channel.id, {
          kind: syncOutcome.ok ? (syncOutcome.warn ? "warn" : "success") : "warn",
          title: getChannelLabel("settings.channel.editor.createdTitle"),
          message: !syncOutcome.ok
            ? getChannelLabel("settings.channel.editor.createdSyncFailed")
            : syncOutcome.warn
              ? getChannelLabel("settings.channel.editor.createdSyncWarn")
              : getChannelLabel("settings.channel.editor.createdSyncOk"),
        });
        onClose();
        return;
      }

      if (!activeChannel) {
        setFormNotice({
          kind: "error",
          title: getChannelLabel("settings.channel.editor.saveErrorTitle"),
          message: getChannelLabel("settings.channel.editor.channelNotFound"),
        });
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
      if (
        normalizeCompareBaseUrl(trimmedBaseUrl) !== normalizeCompareBaseUrl(activeChannel.baseUrl)
      ) {
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
        title: getChannelLabel("settings.channel.editor.savedTitle"),
        message: !syncOutcome.ok
          ? getChannelLabel("settings.channel.editor.savedSyncFailed")
          : syncOutcome.warn
            ? getChannelLabel("settings.channel.editor.savedSyncWarn")
            : getChannelLabel("settings.channel.editor.savedSyncOk"),
      });
      onClose();
    } catch (error) {
      setFormNotice({
        kind: "error",
        title: getChannelLabel("settings.channel.notify.actionFailedTitle"),
        message:
          error instanceof Error
            ? error.message
            : getChannelLabel("settings.channel.editor.saveFailedGeneric"),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={opened} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="flex h-[min(72vh,760px)] max-w-4xl flex-col p-0">
        <DialogHeader className="px-4 pt-4 pb-0">
          <DialogTitle>{getChannelLabel("settings.channel.manageButton")}</DialogTitle>
          <DialogDescription className="sr-only">
            {getChannelLabel("settings.channel.editor.dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-3 p-4">
          <div className="flex w-[35%] min-w-[220px] flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">
                {getChannelLabel("settings.channel.editor.listHeading")}
              </span>
              <Button size="sm" variant="outline" onClick={openCreate}>
                <Plus size={14} /> {getChannelLabel("settings.channel.editor.newButton")}
              </Button>
            </div>

            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                placeholder={getChannelLabel("settings.channel.editor.searchPlaceholder")}
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
                      <p className="truncate text-sm font-semibold">
                        {channel.name || getChannelLabel("settings.channel.editor.unnamedChannel")}
                      </p>
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
                            {getChannelLabel("settings.channel.badge.default")}
                          </Badge>
                        )}
                        {!channel.enabled && (
                          <Badge variant="secondary" className="px-1 py-0 text-xs">
                            {getChannelLabel("settings.channel.badge.disabled")}
                          </Badge>
                        )}
                      </div>
                    </button>
                  );
                })}

                {filteredChannels.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    {getChannelLabel("settings.channel.editor.noMatch")}
                  </p>
                )}
              </div>
            </ScrollArea>
          </div>

          <div className="flex min-w-0 flex-1 flex-col rounded-lg border p-3">
            <div className="mb-3 flex items-start justify-between">
              <div className="min-w-0">
                <p className="truncate font-semibold">
                  {isCreate
                    ? getChannelLabel("settings.channel.editor.createTitle")
                    : activeChannel?.name || getChannelLabel("settings.channel.editor.editTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {getChannelLabel("settings.channel.editor.providerHint")}
                </p>
              </div>
              {!isCreate && (
                <div className="flex shrink-0 items-center gap-1.5">
                  {activeChannel?.isDefault && (
                    <Badge variant="outline">
                      {getChannelLabel("settings.channel.badge.default")}
                    </Badge>
                  )}
                  {activeChannel && !activeChannel.enabled && (
                    <Badge variant="secondary">
                      {getChannelLabel("settings.channel.badge.disabled")}
                    </Badge>
                  )}
                </div>
              )}
            </div>

            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-3 pr-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="channel-name">
                      {getChannelLabel("settings.channel.editor.nameLabel")} *
                    </Label>
                    <Input
                      id="channel-name"
                      placeholder={getChannelLabel("settings.channel.editor.namePlaceholder")}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="channel-provider">Provider</Label>
                    <Input
                      id="channel-provider"
                      placeholder={getChannelLabel("settings.channel.editor.providerPlaceholder")}
                      value={provider}
                      onChange={(event) => setProvider(event.target.value)}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>{getChannelLabel("settings.channel.editor.presetsLabel")}</Label>
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
                      placeholder={getChannelLabel("settings.channel.editor.baseUrlPlaceholder")}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      title={getChannelLabel("settings.channel.editor.fillDefaultBaseUrl")}
                      onClick={() => setBaseUrl(suggestedBaseUrl)}
                    >
                      <Wand2 size={16} />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatChannelLabel("settings.channel.editor.suggestedBaseUrl", {
                      url: suggestedBaseUrl,
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {getChannelLabel("settings.channel.editor.baseUrlHint")}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Checkbox
                    id="channel-enabled"
                    checked={enabled}
                    onCheckedChange={(checked) => setEnabled(Boolean(checked))}
                  />
                  <Label htmlFor="channel-enabled">
                    {getChannelLabel("settings.channel.editor.enableLabel")}
                  </Label>
                </div>

                {isCreate && sidecarStatus === "ready" && matchingSidecarCredentials.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <Label>{getCredentialLabel("channel.selectAuth")}</Label>
                    <Select
                      value={authSource}
                      onValueChange={(v) => setAuthSource(v as "manual" | "local")}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="manual">
                          {getCredentialLabel("channel.authManual")}
                        </SelectItem>
                        <SelectItem value="local">
                          {getCredentialLabel("channel.authFromLocal")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    {authSource === "local" && (
                      <div className="mt-1 flex flex-col gap-1">
                        {matchingSidecarCredentials.map((cred) => {
                          const sourceLabel =
                            cred.source === "codex_cli"
                              ? "Codex CLI (ChatGPT Plus)"
                              : cred.source === "claude_code"
                                ? "Claude Code"
                                : cred.source === "gemini_cli"
                                  ? "Gemini CLI"
                                  : cred.source;
                          return (
                            <div
                              key={`${cred.provider}-${cred.source}`}
                              className="flex items-center gap-2 rounded border border-green-200 bg-green-50 px-2 py-1.5 text-xs dark:border-green-800 dark:bg-green-900/20"
                            >
                              <span className="text-green-600 dark:text-green-400">✓</span>
                              <span className="font-medium">{sourceLabel}</span>
                              {cred.email && (
                                <span className="text-neutral-500">({cred.email})</span>
                              )}
                            </div>
                          );
                        })}
                        <p className="text-xs text-muted-foreground">
                          {getChannelLabel("settings.channel.editor.localAuthHint")}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {!(isCreate && authSource === "local") && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="channel-api-key">
                      API Key {isCreate && authSource === "manual" && "*"}
                    </Label>
                    <Input
                      id="channel-api-key"
                      type="password"
                      placeholder={
                        isCreate
                          ? getChannelLabel("settings.channel.editor.apiKeyPlaceholderCreate")
                          : getChannelLabel("settings.channel.editor.apiKeyPlaceholderEdit")
                      }
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                    />
                    {!isCreate && (
                      <p className="text-xs text-muted-foreground">
                        {getChannelLabel("settings.channel.editor.apiKeyHint")}
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
                                  setFormNotice({
                                    kind: "success",
                                    title: getChannelLabel("settings.channel.editor.filledTitle"),
                                    message: formatChannelLabel(
                                      "settings.channel.editor.filledBody",
                                      { source: s.sourceName },
                                    ),
                                  });
                                } catch (err) {
                                  setFormNotice({
                                    kind: "error",
                                    title: getChannelLabel(
                                      "settings.channel.editor.fetchKeyFailedTitle",
                                    ),
                                    message:
                                      err instanceof Error
                                        ? err.message
                                        : getChannelLabel("settings.channel.editor.unknownError"),
                                  });
                                }
                              }}
                            >
                              {formatChannelLabel("settings.channel.editor.fillFromSource", {
                                source: s.sourceName,
                              })}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                )}

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
                {getChannelLabel("settings.channel.agentCheck.cancel")}
              </Button>
              <Button
                onClick={() => void handleSubmit()}
                disabled={saving || (isCreate ? !canSubmitCreate : !canSubmitEdit)}
              >
                {saving
                  ? getChannelLabel("settings.channel.editor.processing")
                  : isCreate
                    ? getChannelLabel("settings.channel.editor.createAndSync")
                    : getChannelLabel("settings.channel.editor.saveAndSync")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
