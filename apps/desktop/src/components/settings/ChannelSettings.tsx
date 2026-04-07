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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
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
  cn,
} from "ui";
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
      return "模型不可用";
    case "auth_failed":
      return "鉴权失败";
    case "quota_exhausted":
      return "配额不足";
    case "ssl_handshake_failed":
      return "SSL 握手失败";
    case "gateway_failed":
      return "网关异常";
    case "timeout":
      return "请求超时";
    case "protocol_incompatible":
      return "协议不兼容";
    default:
      return "Agent 检查失败";
  }
}

function formatAgentCheckErrorMessage(result: ApiAgentCheckResult) {
  const base = (result.error || "当前配置不能用于 Agent。").trim();
  if (!result.retryable) return base;
  return base.includes("请稍后重试") ? base : `${base} 可稍后重试。`;
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
      notifyError("加载失败", error instanceof Error ? error.message : "无法加载渠道列表。");
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
      const message = result.error || "无法获取模型列表。";
      setChannelNotice((prev) => ({
        ...prev,
        [channelId]: { kind: "error", title: "同步失败", message },
      }));
      return { ok: false, warn: false };
    }

    if (result.error) {
      setChannelNotice((prev) => ({
        ...prev,
        [channelId]: { kind: "warn", title: "需要处理", message: result.error || "" },
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
      notifyError("操作失败", error instanceof Error ? error.message : "渠道操作失败。");
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
    setAgentCheckModelId(channel.defaultModelId || channel.models.find((item) => item.isDefault)?.modelId || "");
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
      notifySuccess("已删除", "渠道已删除。");
    });
  };

  const handleTest = async (channelId: string) => {
    await runChannelAction(`test:${channelId}`, async () => {
      const result = await api.channels.test(channelId);
      if (result.success) {
        notifySuccess("连接成功", "该渠道可正常连接。");
        return;
      }
      notifyError("连接失败", result.error || "无法连接该渠道。");
    });
  };

  const handleFetchModels = async (channelId: string) => {
    await runChannelAction(`fetch:${channelId}`, async () => {
      const result = await api.channels.fetchModels(channelId);
      await loadChannelList({ preserveExpanded: true });
      setExpandedChannelId(channelId);
      const outcome = applyFetchModelsOutcome(channelId, result);
      if (!outcome.ok) {
        notifyError("同步失败", result.error || "无法获取模型列表。");
        return;
      }
      if (outcome.warn) {
        notifyWarning("同步已完成", "模型列表已刷新，但该渠道还有待处理项。");
        return;
      }
      notifySuccess("同步成功", "模型列表已更新。");
    });
  };

  const handleAgentCheck = async (channelId: string, modelId: string) => {
    const trimmed = modelId.trim();
    if (!trimmed) {
      notifyError("缺少模型", "请选择或输入 modelId。");
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
        notifySuccess("Agent 可用", `模型 ${trimmed} 已通过 Agent 兼容性检查。`);
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
      notifySuccess("已更新", "默认渠道已更新。");
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
      notifySuccess("已更新", "模型启用状态已保存。");
    });
  };

  const handleSetDefaultModel = async (channel: Channel, modelId: string) => {
    await runChannelAction(`default-model:${channel.id}:${modelId}`, async () => {
      await api.channels.setDefaultModel(channel.id, modelId);
      await loadChannelList({ preserveExpanded: true });
      setExpandedChannelId(channel.id);
      notifySuccess("已更新", "默认模型已更新。");
    });
  };

  const handleAddModel = async (channel: Channel) => {
    const modelId = (draftModelIdByChannel[channel.id] || "").trim();
    if (!modelId) {
      notifyError("缺少 modelId", "请输入要添加的 modelId。");
      return;
    }
    if (channel.models.some((model) => model.modelId === modelId)) {
      notifyWarning("模型已存在", `${modelId} 已在当前渠道中。`);
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
      notifySuccess("已添加", `${modelId} 已加入当前渠道。`);
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
      notifySuccess("已移除", `${modelId} 已从当前渠道移除。`);
    });
  };

  return (
    <SettingsSection
      title="渠道配置"
      description="全局用户级配置，对话与 Agent 共用。"
      action={
        <Button onClick={() => openEditor(NEW_CHANNEL_KEY)}>
          <Plus size={16} /> 渠道管理
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {sortedChannels.map((channel) => {
          const isExpanded = expandedChannelId === channel.id;
          const needsDefaultModel = Boolean(channel.isDefault && channel.enabled && !channel.defaultModelId);
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
                      {channel.isDefault && <Badge>默认</Badge>}
                      {needsDefaultModel && (
                        <Badge variant="outline" className="border-orange-400 text-orange-600">
                          缺少默认模型
                        </Badge>
                      )}
                      {!channel.enabled && <Badge variant="secondary">已禁用</Badge>}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                      <Badge variant="secondary" className="gap-1" title={channel.provider}>
                        <DesktopProviderLogo provider={channel.provider} />
                        <span className="sr-only">{channel.provider}</span>
                      </Badge>
                      {channel.defaultModelId && <Badge variant="outline">{channel.defaultModelId}</Badge>}
                      <span className="break-all">{channel.baseUrl || "未设置 Base URL"}</span>
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
                            aria-label="编辑渠道"
                          >
                            <PenSquare size={16} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <p>编辑渠道</p>
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => openAgentCheck(channel)}
                            disabled={busyKey === `agent-check:${channel.id}`}
                            aria-label="Agent 检查"
                          >
                            <Bot size={16} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <p>Agent 检查</p>
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => void handleTest(channel.id)}
                            disabled={busyKey === `test:${channel.id}`}
                            aria-label="连接测试"
                          >
                            <Check size={16} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <p>连接测试</p>
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => void handleFetchModels(channel.id)}
                            disabled={busyKey === `fetch:${channel.id}`}
                            aria-label="同步模型"
                          >
                            <RefreshCw
                              size={16}
                              className={busyKey === `fetch:${channel.id}` ? "animate-spin" : ""}
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <p>同步模型</p>
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
                            aria-label="设为默认"
                          >
                            <Pin size={16} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <p>设为默认</p>
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => toggleExpanded(channel.id)}
                            aria-label={isExpanded ? "收起" : "展开"}
                          >
                            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <p>{isExpanded ? "收起" : "展开"}</p>
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
                            aria-label="删除渠道"
                          >
                            <Trash2 size={16} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <p>删除渠道</p>
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
                        <p className="text-sm font-semibold">{notice.title || "需要处理"}</p>
                        <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">
                          {notice.message}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0"
                        onClick={() => dismissChannelNotice(channel.id)}
                        aria-label="关闭提示"
                        title="关闭提示"
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
                          <p className="text-sm font-medium">模型</p>
                          <p className="text-xs text-muted-foreground">
                            已同步 {channel.models.length} 个，可手动补充 modelId
                          </p>
                        </div>
                        <div className="flex w-full max-w-md items-center gap-2">
                          <Input
                            placeholder="手动添加 modelId，例如：qwen3.5-plus"
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
                            添加
                          </Button>
                        </div>
                      </div>
                      {channel.baseUrl?.includes("coding.dashscope.aliyuncs.com") && (
                        <p className="text-xs text-muted-foreground">
                          百炼/Coding Plan 不支持接口查询模型列表，可直接手动添加，例如：
                          qwen3.5-plus、qwen3-coder-next、glm-5、kimi-k2.5。
                        </p>
                      )}
                    </div>

                    {channel.models.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-sm text-muted-foreground">
                        当前还没有模型。该渠道如果不支持同步，可直接在上方手动添加 modelId。
                      </div>
                    ) : (
                      <ScrollArea className="max-h-[320px]">
                        <div className="flex flex-col gap-2 pr-3">
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
                                {model.isDefault && <Badge variant="secondary">默认</Badge>}
                                {!model.enabled && <Badge variant="outline">已禁用</Badge>}
                                <Button
                                  size="sm"
                                  variant={model.isDefault ? "default" : "outline"}
                                  onClick={() => void handleSetDefaultModel(channel, model.modelId)}
                                  disabled={busyKey === `default-model:${channel.id}:${model.modelId}`}
                                >
                                  {model.isDefault ? "默认" : "设为默认"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-destructive"
                                  onClick={() => void handleRemoveModel(channel, model.modelId)}
                                  disabled={busyKey === `remove-model:${channel.id}:${model.modelId}`}
                                >
                                  移除
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {!loading && sortedChannels.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/60 bg-card px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">还没有配置渠道，先新增一个渠道。</p>
          </div>
        )}

        {(loading || busyKey) && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span>{loading ? "正在加载渠道..." : "正在应用配置..."}</span>
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
            <DialogTitle>Agent 兼容性检查</DialogTitle>
            <DialogDescription className="sr-only">
              为当前渠道和模型执行一次真实的 Agent 兼容性检查。
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {(() => {
              const channel = sortedChannels.find((item) => item.id === agentCheckChannelId) || null;
              if (!channel) {
                return <p className="text-sm text-muted-foreground">请选择一个渠道。</p>;
              }

              if (channel.models.length === 0) {
                return (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-sm font-medium">modelId</p>
                    <Input
                      placeholder="例如：claude-4.6-sonnet"
                      value={agentCheckModelId}
                      onChange={(event) => setAgentCheckModelId(event.target.value)}
                    />
                  </div>
                );
              }

              return (
                <div className="flex flex-col gap-1.5">
                  <p className="text-sm font-medium">选择 modelId</p>
                  <Select value={agentCheckModelId} onValueChange={setAgentCheckModelId}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {channel.models.map((model) => (
                        <SelectItem key={model.modelId} value={model.modelId}>
                          {model.enabled ? model.displayName : `${model.displayName}（已禁用）`}
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
              取消
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
              开始检查
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
