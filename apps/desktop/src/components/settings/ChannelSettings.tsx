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
  cn,
} from "ui";
import { createServerApi } from "../../lib/serverApi";
import { useChatStore } from "../../stores/chatStore";
import type { Channel, ChannelModel } from "../../types/chat";
import { DesktopProviderLogo } from "../chat/DesktopProviderLogo";
import { ChannelEditorModal, type SettingsNotice } from "./ChannelEditorModal";

const api = createServerApi();
const NEW_CHANNEL_KEY = "__new__";

function sortChannels(a: Channel, b: Channel) {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function getPreferredChannel(channels: Channel[]) {
  const sorted = channels.slice().sort(sortChannels);
  return sorted[0] || null;
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
  const [pageNotice, setPageNotice] = useState<SettingsNotice | null>(null);
  const [channelNotice, setChannelNotice] = useState<
    Record<string, { kind: "error" | "warn"; title?: string; message: string }>
  >({});

  const sortedChannels = useMemo(() => channels.slice().sort(sortChannels), [channels]);

  const loadChannelList = async (options?: { preserveExpanded?: boolean }) => {
    setLoading(true);
    try {
      await loadChannels();
      if (!options?.preserveExpanded && !expandedChannelId) {
        setExpandedChannelId((current) => current || getPreferredChannel(channels)?.id || null);
      }
    } catch (error) {
      setPageNotice({
        kind: "error",
        title: "加载失败",
        message: error instanceof Error ? error.message : "无法加载渠道列表。",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadChannelList();
  }, []);

  useEffect(() => {
    if (expandedChannelId) return;
    const preferred = getPreferredChannel(sortedChannels);
    if (preferred) {
      setExpandedChannelId(preferred.id);
    }
  }, [expandedChannelId, sortedChannels]);

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
      setPageNotice({
        kind: "error",
        title: "操作失败",
        message: error instanceof Error ? error.message : "渠道操作失败。",
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleEditorSaved = async (channelId: string, notice: SettingsNotice) => {
    await loadChannelList({ preserveExpanded: true });
    setExpandedChannelId(channelId);
    setPageNotice(notice);
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
      setPageNotice({ kind: "success", title: "已删除", message: "渠道已删除。" });
    });
  };

  const handleTest = async (channelId: string) => {
    await runChannelAction(`test:${channelId}`, async () => {
      const result = await api.channels.test(channelId);
      setPageNotice(
        result.success
          ? { kind: "success", title: "连接成功", message: "该渠道可正常连接。" }
          : {
              kind: "error",
              title: "连接失败",
              message: result.error || "无法连接该渠道。",
            },
      );
    });
  };

  const handleFetchModels = async (channelId: string) => {
    await runChannelAction(`fetch:${channelId}`, async () => {
      const result = await api.channels.fetchModels(channelId);
      await loadChannelList({ preserveExpanded: true });
      setExpandedChannelId(channelId);
      const outcome = applyFetchModelsOutcome(channelId, result);
      setPageNotice(
        outcome.ok
          ? {
              kind: outcome.warn ? "warn" : "success",
              title: outcome.warn ? "同步已完成" : "同步成功",
              message: outcome.warn ? "模型列表已刷新，但该渠道还有待处理项。" : "模型列表已更新。",
            }
          : {
              kind: "error",
              title: "同步失败",
              message: result.error || "无法获取模型列表。",
            },
      );
    });
  };

  const handleAgentCheck = async (channelId: string, modelId: string) => {
    const trimmed = modelId.trim();
    if (!trimmed) {
      setPageNotice({ kind: "error", title: "缺少模型", message: "请选择或输入 modelId。" });
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
        setPageNotice({
          kind: "success",
          title: "Agent 可用",
          message: `模型 ${trimmed} 已通过 Agent 兼容性检查。`,
        });
      } else {
        setChannelNotice((prev) => ({
          ...prev,
          [channelId]: {
            kind: "error",
            title: "Agent 检查失败",
            message: result.error || "当前配置不能用于 Agent。",
          },
        }));
        setPageNotice({
          kind: "error",
          title: "Agent 检查失败",
          message: result.error || "当前配置不能用于 Agent。",
        });
      }
      closeAgentCheck();
    });
  };

  const handleSetDefaultChannel = async (channelId: string) => {
    await runChannelAction(`default:${channelId}`, async () => {
      await api.channels.setDefault(channelId);
      await loadChannelList({ preserveExpanded: true });
      setPageNotice({ kind: "success", title: "已更新", message: "默认渠道已更新。" });
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
      setPageNotice({ kind: "success", title: "已更新", message: "模型启用状态已保存。" });
    });
  };

  const handleSetDefaultModel = async (channel: Channel, modelId: string) => {
    await runChannelAction(`default-model:${channel.id}:${modelId}`, async () => {
      await api.channels.setDefaultModel(channel.id, modelId);
      await loadChannelList({ preserveExpanded: true });
      setExpandedChannelId(channel.id);
      setPageNotice({ kind: "success", title: "已更新", message: "默认模型已更新。" });
    });
  };

  return (
    <SettingsSection
      title="渠道配置"
      description="桌面端与 Web 端共用同一套用户级渠道设置。"
      action={
        <Button onClick={() => openEditor(NEW_CHANNEL_KEY)}>
          <Plus size={16} /> 新增渠道
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {pageNotice && (
          <div
            className={cn(
              "rounded-xl border px-4 py-3",
              pageNotice.kind === "error"
                ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200"
                : pageNotice.kind === "warn"
                  ? "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/70 dark:bg-orange-950/40 dark:text-orange-200"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-200",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{pageNotice.title}</p>
                <p className="mt-1 text-sm whitespace-pre-wrap">{pageNotice.message}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setPageNotice(null)}>
                关闭
              </Button>
            </div>
          </div>
        )}

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
                      <p className="text-base font-semibold">{channel.name}</p>
                      {channel.isDefault && <Badge>默认</Badge>}
                      {needsDefaultModel && (
                        <Badge variant="outline" className="border-orange-400 text-orange-600">
                          缺少默认模型
                        </Badge>
                      )}
                      {!channel.enabled && <Badge variant="secondary">已禁用</Badge>}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                      <Badge variant="secondary" className="gap-1">
                        <DesktopProviderLogo provider={channel.provider} />
                        <span>{channel.provider}</span>
                      </Badge>
                      {channel.defaultModelId && <Badge variant="outline">{channel.defaultModelId}</Badge>}
                      <span className="break-all">{channel.baseUrl || "未设置 Base URL"}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => openEditor(channel.id)}>
                      <PenSquare size={14} /> 编辑
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openAgentCheck(channel)}
                      disabled={busyKey === `agent-check:${channel.id}`}
                    >
                      <Bot size={14} /> Agent 检查
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleTest(channel.id)}
                      disabled={busyKey === `test:${channel.id}`}
                    >
                      <Check size={14} /> 连接测试
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleFetchModels(channel.id)}
                      disabled={busyKey === `fetch:${channel.id}`}
                    >
                      <RefreshCw
                        size={14}
                        className={busyKey === `fetch:${channel.id}` ? "animate-spin" : ""}
                      />
                      同步模型
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleSetDefaultChannel(channel.id)}
                      disabled={Boolean(busyKey) || channel.isDefault}
                    >
                      <Pin size={14} /> 设为默认
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => toggleExpanded(channel.id)}>
                      {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      {isExpanded ? "收起" : "展开"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive"
                      onClick={() => void handleDelete(channel.id)}
                      disabled={busyKey === `delete:${channel.id}`}
                    >
                      <Trash2 size={14} /> 删除
                    </Button>
                  </div>
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
                    <p className="text-sm font-semibold">{notice.title || "需要处理"}</p>
                    <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">
                      {notice.message}
                    </p>
                  </div>
                )}

                {isExpanded && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">模型</p>
                      <p className="text-xs text-muted-foreground">
                        已同步 {channel.models.length} 个
                      </p>
                    </div>

                    {channel.models.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-sm text-muted-foreground">
                        当前还没有模型。请先同步模型列表。
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
