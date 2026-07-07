import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  PenSquare,
  Pin,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "ui";
import { formatChannelLabel, getChannelLabel } from "../../lib/i18n/agent";
import { notifyError, notifySuccess, notifyWarning } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import { useChatStore } from "../../stores/chatStore";
import type { ApiAgentCheckResult, Channel, ChannelModel } from "../../types/chat";
import { DesktopProviderLogo } from "../chat/DesktopProviderLogo";
import { ChannelEditorModal, type SettingsNotice } from "./ChannelEditorModal";

const api = createServerApi();
const NEW_CHANNEL_KEY = "__new__";

function sortChannels(a: Channel, b: Channel) {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function getAgentCheckErrorTitle(result: ApiAgentCheckResult) {
  switch (result.errorCode) {
    case "model_not_found":
      return getChannelLabel("settings.channel.agentCheck.error.modelNotFound");
    case "auth_failed":
      return getChannelLabel("settings.channel.agentCheck.error.authFailed");
    case "quota_exhausted":
      return getChannelLabel("settings.channel.agentCheck.error.quotaExhausted");
    case "ssl_handshake_failed":
      return getChannelLabel("settings.channel.agentCheck.error.sslHandshakeFailed");
    case "gateway_failed":
      return getChannelLabel("settings.channel.agentCheck.error.gatewayFailed");
    case "timeout":
      return getChannelLabel("settings.channel.agentCheck.error.timeout");
    case "protocol_incompatible":
      return getChannelLabel("settings.channel.agentCheck.error.protocolIncompatible");
    default:
      return getChannelLabel("settings.channel.agentCheck.error.default");
  }
}

function formatAgentCheckErrorMessage(result: ApiAgentCheckResult) {
  const base = (result.error || getChannelLabel("settings.channel.agentCheck.defaultError")).trim();
  if (!result.retryable) return base;
  return base.includes(getChannelLabel("settings.channel.agentCheck.retryPhrase"))
    ? base
    : `${base}${getChannelLabel("settings.channel.agentCheck.retrySuffix")}`;
}

export function ChannelSettings() {
  const channels = useChatStore((state) => state.channels);
  const loadChannels = useChatStore((state) => state.loadChannels);

  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expandedChannelId, setExpandedChannelId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorChannelId, setEditorChannelId] = useState<string | null>(null);
  const [agentCheckOpen, setAgentCheckOpen] = useState(false);
  const [agentCheckChannelId, setAgentCheckChannelId] = useState<string | null>(null);
  const [agentCheckModelId, setAgentCheckModelId] = useState("");
  const [draftModelIdByChannel, setDraftModelIdByChannel] = useState<Record<string, string>>({});
  const [channelNotice, setChannelNotice] = useState<
    Record<string, { kind: "error" | "warn"; title?: string; message: string }>
  >({});

  const sortedChannels = useMemo(() => channels.slice().sort(sortChannels), [channels]);

  const loadChannelList = async (options?: { preserveExpanded?: boolean }) => {
    setLoading(true);
    try {
      await loadChannels();
    } catch (error) {
      notifyError(
        getChannelLabel("settings.channel.notify.loadFailedTitle"),
        error instanceof Error
          ? error.message
          : getChannelLabel("settings.channel.notify.loadFailedBody"),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadChannelList();
  }, []);

  const applyFetchModelsOutcome = (
    channelId: string,
    result: { success: boolean; error?: string },
  ) => {
    if (!result.success) {
      const message =
        result.error || getChannelLabel("settings.channel.notify.fetchModelsFailedBody");
      setChannelNotice((prev) => ({
        ...prev,
        [channelId]: {
          kind: "error",
          title: getChannelLabel("settings.channel.notice.syncFailedTitle"),
          message,
        },
      }));
      return { ok: false, warn: false };
    }

    if (result.error) {
      setChannelNotice((prev) => ({
        ...prev,
        [channelId]: {
          kind: "warn",
          title: getChannelLabel("settings.channel.notice.needsAttentionTitle"),
          message: result.error || "",
        },
      }));
      return { ok: true, warn: true };
    }

    setChannelNotice((prev) => {
      if (!prev[channelId]) return prev;
      const { [channelId]: _removed, ...rest } = prev;
      return rest;
    });
    return { ok: true, warn: false };
  };

  const runChannelAction = async (key: string, action: () => Promise<void>) => {
    setBusyKey(key);
    try {
      await action();
    } catch (error) {
      notifyError(
        getChannelLabel("settings.channel.notify.actionFailedTitle"),
        error instanceof Error
          ? error.message
          : getChannelLabel("settings.channel.notify.actionFailedBody"),
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleEditorSaved = async (channelId: string, notice: SettingsNotice) => {
    await loadChannelList({ preserveExpanded: true });
    setExpandedChannelId(channelId);
    if (notice.kind === "error") {
      notifyError(notice.title, notice.message);
      return;
    }
    if (notice.kind === "warn") {
      notifyWarning(notice.title, notice.message);
      return;
    }
    notifySuccess(notice.title, notice.message);
  };

  const openEditor = (channelId?: string | null) => {
    setEditorChannelId(channelId || null);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditorChannelId(null);
  };

  const openAgentCheck = (channel: Channel) => {
    setAgentCheckChannelId(channel.id);
    setAgentCheckModelId(
      channel.defaultModelId || channel.models.find((item) => item.isDefault)?.modelId || "",
    );
    setAgentCheckOpen(true);
  };

  const closeAgentCheck = () => {
    setAgentCheckOpen(false);
    setAgentCheckChannelId(null);
    setAgentCheckModelId("");
  };

  const toggleExpanded = (channelId: string) => {
    setExpandedChannelId((current) => (current === channelId ? null : channelId));
  };

  const dismissChannelNotice = (channelId: string) => {
    setChannelNotice((prev) => {
      if (!prev[channelId]) return prev;
      const { [channelId]: _removed, ...rest } = prev;
      return rest;
    });
  };

  const handleDelete = async (channelId: string) => {
    await runChannelAction(`delete:${channelId}`, async () => {
      await api.channels.delete(channelId);
      setChannelNotice((prev) => {
        if (!prev[channelId]) return prev;
        const { [channelId]: _removed, ...rest } = prev;
        return rest;
      });
      if (expandedChannelId === channelId) {
        setExpandedChannelId(null);
      }
      await loadChannelList();
      notifySuccess(
        getChannelLabel("settings.channel.notify.deletedTitle"),
        getChannelLabel("settings.channel.notify.deletedBody"),
      );
    });
  };

  const handleTest = async (channelId: string) => {
    await runChannelAction(`test:${channelId}`, async () => {
      const result = await api.channels.test(channelId);
      if (result.success) {
        notifySuccess(
          getChannelLabel("settings.channel.notify.testSuccessTitle"),
          getChannelLabel("settings.channel.notify.testSuccessBody"),
        );
        return;
      }
      notifyError(
        getChannelLabel("settings.channel.notify.testFailedTitle"),
        result.error || getChannelLabel("settings.channel.notify.testFailedBody"),
      );
    });
  };

  const handleFetchModels = async (channelId: string) => {
    await runChannelAction(`fetch:${channelId}`, async () => {
      const result = await api.channels.fetchModels(channelId);
      await loadChannelList({ preserveExpanded: true });
      setExpandedChannelId(channelId);
      const outcome = applyFetchModelsOutcome(channelId, result);
      if (!outcome.ok) {
        notifyError(
          getChannelLabel("settings.channel.notice.syncFailedTitle"),
          result.error || getChannelLabel("settings.channel.notify.fetchModelsFailedBody"),
        );
        return;
      }
      if (outcome.warn) {
        notifyWarning(
          getChannelLabel("settings.channel.notify.syncDoneWarnTitle"),
          getChannelLabel("settings.channel.notify.syncDoneWarnBody"),
        );
        return;
      }
      notifySuccess(
        getChannelLabel("settings.channel.notify.syncSuccessTitle"),
        getChannelLabel("settings.channel.notify.syncSuccessBody"),
      );
    });
  };

  const handleAgentCheck = async (channelId: string, modelId: string) => {
    const trimmed = modelId.trim();
    if (!trimmed) {
      notifyError(
        getChannelLabel("settings.channel.notify.missingModelTitle"),
        getChannelLabel("settings.channel.notify.missingModelBody"),
      );
      return;
    }

    await runChannelAction(`agent-check:${channelId}`, async () => {
      const result = await api.channels.agentCheck(channelId, { modelId: trimmed });
      if (result.success) {
        setChannelNotice((prev) => {
          if (!prev[channelId]) return prev;
          const { [channelId]: _removed, ...rest } = prev;
          return rest;
        });
        notifySuccess(
          getChannelLabel("settings.channel.notify.agentOkTitle"),
          formatChannelLabel("settings.channel.notify.agentOkBody", { modelId: trimmed }),
        );
      } else {
        const title = getAgentCheckErrorTitle(result);
        const message = formatAgentCheckErrorMessage(result);
        setChannelNotice((prev) => ({
          ...prev,
          [channelId]: {
            kind: "error",
            title,
            message,
          },
        }));
        notifyError(title, message);
      }
      closeAgentCheck();
    });
  };

  const handleSetDefaultChannel = async (channelId: string) => {
    await runChannelAction(`default:${channelId}`, async () => {
      await api.channels.setDefault(channelId);
      await loadChannelList({ preserveExpanded: true });
      notifySuccess(
        getChannelLabel("settings.channel.notify.updatedTitle"),
        getChannelLabel("settings.channel.notify.defaultChannelUpdatedBody"),
      );
    });
  };

  const updateModels = async (channel: Channel, models: ChannelModel[]) => {
    await api.channels.updateModels(channel.id, {
      models: models.map((model) => ({
        modelId: model.modelId,
        displayName: model.displayName,
        enabled: model.enabled,
        isDefault: model.isDefault,
      })),
    });
    await loadChannelList({ preserveExpanded: true });
    setExpandedChannelId(channel.id);
  };

  const handleToggleModelEnabled = async (channel: Channel, modelId: string) => {
    await runChannelAction(`toggle:${channel.id}:${modelId}`, async () => {
      const nextModels = channel.models.map((model) =>
        model.modelId === modelId ? { ...model, enabled: !model.enabled } : model,
      );
      await updateModels(channel, nextModels);
      notifySuccess(
        getChannelLabel("settings.channel.notify.updatedTitle"),
        getChannelLabel("settings.channel.notify.modelEnabledUpdatedBody"),
      );
    });
  };

  const handleSetDefaultModel = async (channel: Channel, modelId: string) => {
    await runChannelAction(`default-model:${channel.id}:${modelId}`, async () => {
      await api.channels.setDefaultModel(channel.id, modelId);
      await loadChannelList({ preserveExpanded: true });
      setExpandedChannelId(channel.id);
      notifySuccess(
        getChannelLabel("settings.channel.notify.updatedTitle"),
        getChannelLabel("settings.channel.notify.defaultModelUpdatedBody"),
      );
    });
  };

  const handleAddModel = async (channel: Channel) => {
    const modelId = (draftModelIdByChannel[channel.id] || "").trim();
    if (!modelId) {
      notifyError(
        getChannelLabel("settings.channel.notify.missingModelIdTitle"),
        getChannelLabel("settings.channel.notify.missingModelIdBody"),
      );
      return;
    }
    if (channel.models.some((model) => model.modelId === modelId)) {
      notifyWarning(
        getChannelLabel("settings.channel.notify.modelExistsTitle"),
        formatChannelLabel("settings.channel.notify.modelExistsBody", { modelId }),
      );
      return;
    }

    await runChannelAction(`add-model:${channel.id}`, async () => {
      const nextModels = channel.models.concat({
        id: `draft:${modelId}`,
        channelId: channel.id,
        modelId,
        displayName: modelId,
        enabled: true,
        isDefault: channel.models.every((model) => !model.isDefault),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await updateModels(channel, nextModels);
      setDraftModelIdByChannel((prev) => ({ ...prev, [channel.id]: "" }));
      notifySuccess(
        getChannelLabel("settings.channel.notify.addedTitle"),
        formatChannelLabel("settings.channel.notify.addedBody", { modelId }),
      );
    });
  };

  const handleRemoveModel = async (channel: Channel, modelId: string) => {
    await runChannelAction(`remove-model:${channel.id}:${modelId}`, async () => {
      const remainingModels = channel.models.filter((model) => model.modelId !== modelId);
      if (remainingModels.length === channel.models.length) {
        return;
      }

      const preservedDefaultModelId =
        remainingModels.find((model) => model.isDefault && model.enabled)?.modelId ||
        remainingModels.find((model) => model.enabled)?.modelId ||
        null;
      const nextModels = remainingModels.map((model) => ({
        ...model,
        isDefault: preservedDefaultModelId ? model.modelId === preservedDefaultModelId : false,
      }));

      await updateModels(channel, nextModels);
      notifySuccess(
        getChannelLabel("settings.channel.notify.removedTitle"),
        formatChannelLabel("settings.channel.notify.removedBody", { modelId }),
      );
    });
  };

  return (
    <>
      <SettingsSection
        title={getChannelLabel("settings.channel.title")}
        description={getChannelLabel("settings.channel.description")}
        action={
          <Button onClick={() => openEditor(NEW_CHANNEL_KEY)}>
            <Plus size={16} /> {getChannelLabel("settings.channel.manageButton")}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {sortedChannels.map((channel) => {
            const isExpanded = expandedChannelId === channel.id;
            const needsDefaultModel = Boolean(
              channel.isDefault && channel.enabled && !channel.defaultModelId,
            );
            const notice = channelNotice[channel.id] || null;

            return (
              <div
                key={channel.id}
                className="rounded-xl border border-border/60 bg-card p-4 shadow-minimal"
              >
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <p className="font-semibold">{channel.name}</p>
                        {channel.isDefault && (
                          <Badge>{getChannelLabel("settings.channel.badge.default")}</Badge>
                        )}
                        {needsDefaultModel && (
                          <Badge variant="outline" className="border-orange-400 text-orange-600">
                            {getChannelLabel("settings.channel.badge.missingDefaultModel")}
                          </Badge>
                        )}
                        {!channel.enabled && (
                          <Badge variant="secondary">
                            {getChannelLabel("settings.channel.badge.disabled")}
                          </Badge>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                        <Badge variant="secondary" className="gap-1" title={channel.provider}>
                          <DesktopProviderLogo provider={channel.provider} />
                          <span className="sr-only">{channel.provider}</span>
                        </Badge>
                        {channel.defaultModelId && (
                          <Badge variant="outline">{channel.defaultModelId}</Badge>
                        )}
                        <span className="break-all">
                          {channel.baseUrl || getChannelLabel("settings.channel.baseUrlUnset")}
                        </span>
                      </div>
                    </div>

                    <TooltipProvider>
                      <div className="flex shrink-0 items-center gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => openEditor(channel.id)}
                              aria-label={getChannelLabel("settings.channel.action.edit")}
                            >
                              <PenSquare size={16} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p>{getChannelLabel("settings.channel.action.edit")}</p>
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => openAgentCheck(channel)}
                              disabled={busyKey === `agent-check:${channel.id}`}
                              aria-label={getChannelLabel("settings.channel.action.agentCheck")}
                            >
                              <Bot size={16} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p>{getChannelLabel("settings.channel.action.agentCheck")}</p>
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => void handleTest(channel.id)}
                              disabled={busyKey === `test:${channel.id}`}
                              aria-label={getChannelLabel("settings.channel.action.test")}
                            >
                              <Check size={16} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p>{getChannelLabel("settings.channel.action.test")}</p>
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => void handleFetchModels(channel.id)}
                              disabled={busyKey === `fetch:${channel.id}`}
                              aria-label={getChannelLabel("settings.channel.action.syncModels")}
                            >
                              <RefreshCw
                                size={16}
                                className={busyKey === `fetch:${channel.id}` ? "animate-spin" : ""}
                              />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p>{getChannelLabel("settings.channel.action.syncModels")}</p>
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className={channel.isDefault ? "text-yellow-500" : ""}
                              onClick={() => void handleSetDefaultChannel(channel.id)}
                              disabled={Boolean(busyKey)}
                              aria-label={getChannelLabel("settings.channel.action.setDefault")}
                            >
                              <Pin size={16} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p>{getChannelLabel("settings.channel.action.setDefault")}</p>
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => toggleExpanded(channel.id)}
                              aria-label={
                                isExpanded
                                  ? getChannelLabel("settings.channel.action.collapse")
                                  : getChannelLabel("settings.channel.action.expand")
                              }
                            >
                              {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p>
                              {isExpanded
                                ? getChannelLabel("settings.channel.action.collapse")
                                : getChannelLabel("settings.channel.action.expand")}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-destructive"
                              onClick={() => void handleDelete(channel.id)}
                              disabled={busyKey === `delete:${channel.id}`}
                              aria-label={getChannelLabel("settings.channel.action.delete")}
                            >
                              <Trash2 size={16} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p>{getChannelLabel("settings.channel.action.delete")}</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </TooltipProvider>
                  </div>

                  {notice && (
                    <div
                      className={cn(
                        "rounded-xl border p-3",
                        notice.kind === "error"
                          ? "border-red-200 bg-red-50 dark:border-red-900/70 dark:bg-red-950/40"
                          : "border-orange-200 bg-orange-50 dark:border-orange-900/70 dark:bg-orange-950/40",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">
                            {notice.title ||
                              getChannelLabel("settings.channel.notice.needsAttentionTitle")}
                          </p>
                          <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">
                            {notice.message}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0"
                          onClick={() => dismissChannelNotice(channel.id)}
                          aria-label={getChannelLabel("settings.channel.notice.dismiss")}
                          title={getChannelLabel("settings.channel.notice.dismiss")}
                        >
                          <X size={14} />
                        </Button>
                      </div>
                    </div>
                  )}

                  {isExpanded && (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border/60 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium">
                              {getChannelLabel("settings.channel.models.heading")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatChannelLabel("settings.channel.models.syncedCount", {
                                count: channel.models.length,
                              })}
                            </p>
                          </div>
                          <div className="flex w-full max-w-md items-center gap-2">
                            <Input
                              placeholder={getChannelLabel(
                                "settings.channel.models.addPlaceholder",
                              )}
                              value={draftModelIdByChannel[channel.id] || ""}
                              onChange={(event) =>
                                setDraftModelIdByChannel((prev) => ({
                                  ...prev,
                                  [channel.id]: event.target.value,
                                }))
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void handleAddModel(channel);
                                }
                              }}
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleAddModel(channel)}
                              disabled={busyKey === `add-model:${channel.id}`}
                            >
                              {getChannelLabel("settings.channel.models.addButton")}
                            </Button>
                          </div>
                        </div>
                        {channel.baseUrl?.includes("coding.dashscope.aliyuncs.com") && (
                          <p className="text-xs text-muted-foreground">
                            {getChannelLabel("settings.channel.models.dashscopeHint")}
                          </p>
                        )}
                      </div>

                      {channel.models.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-sm text-muted-foreground">
                          {getChannelLabel("settings.channel.models.empty")}
                        </div>
                      ) : (
                        <div className="max-h-[400px] overflow-y-auto rounded-md">
                          <div className="flex flex-col gap-2 pr-1">
                            {channel.models.map((model) => (
                              <div
                                key={model.id}
                                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
                              >
                                <div className="flex min-w-0 items-center gap-3">
                                  <Checkbox
                                    checked={model.enabled}
                                    onCheckedChange={() =>
                                      void handleToggleModelEnabled(channel, model.modelId)
                                    }
                                    disabled={busyKey === `toggle:${channel.id}:${model.modelId}`}
                                  />
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">
                                      {model.displayName || model.modelId}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                      {model.modelId}
                                    </p>
                                  </div>
                                </div>

                                <div className="flex shrink-0 items-center gap-2">
                                  {model.isDefault && (
                                    <Badge variant="secondary">
                                      {getChannelLabel("settings.channel.badge.default")}
                                    </Badge>
                                  )}
                                  {!model.enabled && (
                                    <Badge variant="outline">
                                      {getChannelLabel("settings.channel.badge.disabled")}
                                    </Badge>
                                  )}
                                  <Button
                                    size="sm"
                                    variant={model.isDefault ? "default" : "outline"}
                                    onClick={() =>
                                      void handleSetDefaultModel(channel, model.modelId)
                                    }
                                    disabled={
                                      busyKey === `default-model:${channel.id}:${model.modelId}`
                                    }
                                  >
                                    {model.isDefault
                                      ? getChannelLabel("settings.channel.badge.default")
                                      : getChannelLabel("settings.channel.action.setDefault")}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-destructive"
                                    onClick={() => void handleRemoveModel(channel, model.modelId)}
                                    disabled={
                                      busyKey === `remove-model:${channel.id}:${model.modelId}`
                                    }
                                  >
                                    {getChannelLabel("settings.channel.model.remove")}
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {!loading && sortedChannels.length === 0 && (
            <div className="rounded-xl border border-dashed border-border/60 bg-card px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                {getChannelLabel("settings.channel.emptyState")}
              </p>
            </div>
          )}

          {(loading || busyKey) && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span>
                {loading
                  ? getChannelLabel("settings.channel.loading")
                  : getChannelLabel("settings.channel.applying")}
              </span>
            </div>
          )}
        </div>

        <ChannelEditorModal
          opened={editorOpen}
          channels={sortedChannels}
          initialChannelId={editorChannelId}
          onClose={closeEditor}
          onSaved={handleEditorSaved}
          applyFetchModelsOutcome={applyFetchModelsOutcome}
        />

        <Dialog open={agentCheckOpen} onOpenChange={(nextOpen) => !nextOpen && closeAgentCheck()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {getChannelLabel("settings.channel.agentCheck.dialogTitle")}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {getChannelLabel("settings.channel.agentCheck.dialogDescription")}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              {(() => {
                const channel =
                  sortedChannels.find((item) => item.id === agentCheckChannelId) || null;
                if (!channel) {
                  return (
                    <p className="text-sm text-muted-foreground">
                      {getChannelLabel("settings.channel.agentCheck.selectChannel")}
                    </p>
                  );
                }

                if (channel.models.length === 0) {
                  return (
                    <div className="flex flex-col gap-1.5">
                      <p className="text-sm font-medium">modelId</p>
                      <Input
                        placeholder={getChannelLabel(
                          "settings.channel.agentCheck.modelIdPlaceholder",
                        )}
                        value={agentCheckModelId}
                        onChange={(event) => setAgentCheckModelId(event.target.value)}
                      />
                    </div>
                  );
                }

                return (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-sm font-medium">
                      {getChannelLabel("settings.channel.agentCheck.selectModelId")}
                    </p>
                    <Select value={agentCheckModelId} onValueChange={setAgentCheckModelId}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {channel.models.map((model) => (
                          <SelectItem key={model.modelId} value={model.modelId}>
                            {model.enabled
                              ? model.displayName
                              : `${model.displayName}${getChannelLabel("settings.channel.agentCheck.modelDisabledSuffix")}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })()}
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={closeAgentCheck}>
                {getChannelLabel("settings.channel.agentCheck.cancel")}
              </Button>
              <Button
                onClick={() => {
                  if (!agentCheckChannelId) return;
                  void handleAgentCheck(agentCheckChannelId, agentCheckModelId);
                }}
                disabled={
                  agentCheckChannelId ? busyKey === `agent-check:${agentCheckChannelId}` : false
                }
              >
                {getChannelLabel("settings.channel.agentCheck.start")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SettingsSection>
    </>
  );
}
