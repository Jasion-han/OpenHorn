"use client";

import { Bot, Check, ChevronDown, ChevronUp, PenSquare, Pin, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SettingsSection } from "ui";
import { ProviderLogo } from "@/components/providers/ProviderLogo";
import { cn } from "@/lib/utils";
import { type ApiChannel, type ApiChannelModel, api } from "../../lib/api";
import { notifyError, notifySuccess } from "../../lib/notify";
import { BACKEND_UP_EVENT } from "../../stores/backendStatusStore";
import { useChatStore } from "../../stores/chatStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { ChannelEditorModal } from "./ChannelEditorModal";

function getPreferredChannelToFix(channels: ApiChannel[]): ApiChannel | null {
  const enabled = channels.filter((c) => c.enabled);
  const def = enabled.find((c) => c.isDefault);
  if (def) return def;
  if (enabled.length === 0) return null;
  return (
    enabled
      .slice()
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] || null
  );
}

export function ChannelSettings() {
  const { channels, setChannels } = useChatStore();
  const router = useRouter();
  const search = useSearchParams();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorChannelId, setEditorChannelId] = useState<string | null>(null);
  const [agentCheckOpen, setAgentCheckOpen] = useState(false);
  const [agentCheckChannelId, setAgentCheckChannelId] = useState<string | null>(null);
  const [agentCheckModelId, setAgentCheckModelId] = useState("");
  const [expandedChannelId, setExpandedChannelId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const didApplyFocusRef = useRef(false);
  const [channelNotice, setChannelNotice] = useState<
    Record<
      string,
      { kind: "error" | "warn"; title?: string; message: string; action?: "switch_openai" }
    >
  >({});

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
      console.error("Failed to load channels:", error);
    }
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditorChannelId(null);
  };

  const openEditor = (channelId?: string | null) => {
    setEditorChannelId(channelId || null);
    setEditorOpen(true);
  };

  const closeAgentCheck = () => {
    setAgentCheckOpen(false);
    setAgentCheckChannelId(null);
    setAgentCheckModelId("");
  };

  const openAgentCheck = (channel: ApiChannel) => {
    setAgentCheckChannelId(channel.id);
    setAgentCheckModelId(
      channel.defaultModelId || channel.models.find((m) => m.isDefault)?.modelId || "",
    );
    setAgentCheckOpen(true);
  };

  const runChannelAction = async (key: string, action: () => Promise<void>) => {
    setBusyKey(key);
    try {
      await action();
    } catch (error) {
      console.error("Channel action failed:", error);
      notifyError("操作失败", error instanceof Error ? error.message : "Operation failed");
    } finally {
      setBusyKey(null);
    }
  };

  const applyFetchModelsOutcome = (
    channelId: string,
    result: { success: boolean; error?: string },
  ) => {
    if (!result.success) {
      const msg = result.error || "无法获取模型列表";
      setChannelNotice((prev) => {
        const action =
          msg.includes("Provider") || msg.includes("OpenAI 兼容") ? "switch_openai" : undefined;
        return { ...prev, [channelId]: { kind: "error", title: "同步失败", message: msg, action } };
      });
      return { ok: false as const };
    }

    if (result.error) {
      setChannelNotice((prev) => ({
        ...prev,
        [channelId]: { kind: "warn", title: "需要处理", message: result.error || "" },
      }));
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
        notifySuccess("连接成功", "该渠道可用");
      } else {
        notifyError("连接失败", result.error || "无法连接该渠道");
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
        notifySuccess("同步完成", "已更新模型列表");
      }
    });
  };

  const handleAgentCheck = async (channelId: string, modelId: string) => {
    const trimmed = modelId.trim();
    if (!trimmed) {
      notifyError("缺少模型", "请选择或输入一个 modelId");
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
        notifySuccess("Agent 兼容", "该渠道可用于 Agent");
        closeAgentCheck();
        return;
      }

      const msg = result.error || "Agent 检查失败";
      setChannelNotice((prev) => ({
        ...prev,
        [channelId]: { kind: "error", title: "Agent 检查失败", message: msg },
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
        model.modelId === modelId ? { ...model, enabled: !model.enabled } : model,
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
    setExpandedChannelId((current) => (current === channelId ? null : channelId));
  };

  useEffect(() => {
    if (didApplyFocusRef.current) return;
    if (!search) return;
    const focus = search.get("focus");
    if (!focus) return;
    if (focus !== "default" && focus.trim().length === 0) return;

    // If we haven't loaded channels yet, wait.
    // Channels live in a global store; "channels.length===0" could mean "not loaded" or "none".
    // We'll apply focus as soon as the store updates at least once after mount.
    didApplyFocusRef.current = true;

    const apply = () => {
      let target: ApiChannel | null = null;
      if (focus !== "default") {
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
          el?.scrollIntoView({ block: "start", behavior: "smooth" });
        });
      }

      // Clear focus params so refresh doesn't re-run the guide.
      const params = new URLSearchParams(search.toString());
      params.delete("focus");
      params.delete("action");
      const next = params.toString();
      router.replace(next ? `/settings?${next}` : "/settings?tab=channels");
    };

    // If channels are empty, still apply (might open modal).
    // Defer to ensure the UI is mounted.
    queueMicrotask(apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, router, search]);

  return (
    <SettingsSection
      title="渠道配置"
      description="全局用户级配置，对话与 Agent 共用。"
      action={
        <Button onClick={() => openEditor()}>
          <Plus size={16} /> 渠道管理
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {channels.map((channel) => {
          const isExpanded = expandedChannelId === channel.id;
          const needsDefaultModel = Boolean(
            channel.isDefault && channel.enabled && !channel.defaultModelId,
          );
          const notice = channelNotice[channel.id] || null;
          const agentCheckKey = `agent-check:${channel.id}`;
          return (
            <div
              key={channel.id}
              className="rounded-xl border border-border/50 bg-card shadow-minimal p-4"
              id={`channel-${channel.id}`}
            >
              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <p className="font-semibold">{channel.name}</p>
                      {channel.isDefault && <Badge>默认</Badge>}
                      {needsDefaultModel && (
                        <Badge variant="outline" className="border-orange-400 text-orange-600">
                          缺少默认模型
                        </Badge>
                      )}
                      {!channel.enabled && <Badge variant="secondary">已禁用</Badge>}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="secondary" className="gap-1" title={channel.provider}>
                        <ProviderLogo provider={channel.provider} className="size-4" />
                        <span className="sr-only">{channel.provider}</span>
                      </Badge>
                      {channel.defaultModelId && (
                        <Badge variant="outline">{channel.defaultModelId}</Badge>
                      )}
                      <span className="text-sm text-muted-foreground">
                        {channel.baseUrl || "未设置 Base URL"}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
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
                          disabled={busyKey === agentCheckKey}
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
                          disabled={!!busyKey}
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
                </div>

                {notice && (
                  <div
                    className={cn(
                      "rounded-xl border p-3 shadow-minimal",
                      notice.kind === "error"
                        ? "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950"
                        : "border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-950",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">
                          {notice.title || (notice.kind === "error" ? "同步失败" : "需要处理")}
                        </p>
                        <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                          {notice.message}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {notice.action === "switch_openai" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              void runChannelAction(`fix-provider:${channel.id}`, async () => {
                                await api.channels.update(channel.id, { provider: "openai" });
                                await loadChannels();
                                setChannelNotice((prev) => {
                                  const { [channel.id]: _, ...rest } = prev;
                                  return rest;
                                });
                                notifySuccess(
                                  "已更新",
                                  "已切换为 OpenAI 兼容 Provider，请重新同步模型。",
                                );
                              });
                            }}
                          >
                            切换为 OpenAI 兼容
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setChannelNotice((prev) => {
                              const { [channel.id]: _, ...rest } = prev;
                              return rest;
                            })
                          }
                        >
                          关闭
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {isExpanded && (
                  <div className="flex flex-col gap-2 mt-1">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">模型</p>
                      <p className="text-xs text-muted-foreground">
                        已同步 {channel.models.length} 个
                      </p>
                    </div>

                    {channel.models.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        暂无模型。点击上方同步按钮拉取模型列表。
                      </p>
                    ) : (
                      channel.models.map((model) => (
                        <div
                          key={model.id}
                          className="flex items-center justify-between rounded-md border px-3 py-2"
                        >
                          <div className="flex items-center gap-3">
                            <Checkbox
                              checked={model.enabled}
                              onCheckedChange={() =>
                                void handleToggleModelEnabled(channel, model.modelId)
                              }
                              disabled={busyKey === `toggle-model:${channel.id}:${model.modelId}`}
                            />
                            <div>
                              <p className="text-sm font-medium">{model.displayName}</p>
                              <p className="text-xs text-muted-foreground">{model.modelId}</p>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant={model.isDefault ? "default" : "outline"}
                            onClick={() => void handleSetDefaultModel(channel, model.modelId)}
                            disabled={busyKey === `default-model:${channel.id}:${model.modelId}`}
                          >
                            {model.isDefault ? "默认" : "设为默认"}
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {channels.length === 0 && (
          <div className="rounded-xl border border-border/50 bg-card shadow-minimal p-8 text-center">
            <p className="text-sm text-muted-foreground">
              还没有渠道。添加一个渠道来连接你的模型。
            </p>
          </div>
        )}

        <ChannelEditorModal
          opened={editorOpen}
          channels={channels}
          initialChannelId={editorChannelId}
          onClose={closeEditor}
          onSaved={async (channelId) => {
            await loadChannels();
            setExpandedChannelId(channelId);
          }}
          applyFetchModelsOutcome={applyFetchModelsOutcome}
        />

        <Dialog open={agentCheckOpen} onOpenChange={(o) => !o && closeAgentCheck()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Agent 兼容性检查</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {(() => {
                const channel = channels.find((c) => c.id === agentCheckChannelId) || null;
                const items = (channel?.models || []).map((m) => ({
                  value: m.modelId,
                  label: m.enabled ? m.displayName : `${m.displayName}（已禁用）`,
                }));

                if (!channel)
                  return <p className="text-sm text-muted-foreground">请选择一个渠道。</p>;

                if (items.length === 0)
                  return (
                    <div className="flex flex-col gap-1.5">
                      <p className="text-sm font-medium">modelId</p>
                      <Input
                        placeholder="例如：claude-4.5-sonnet"
                        value={agentCheckModelId}
                        onChange={(e) => setAgentCheckModelId(e.target.value)}
                      />
                    </div>
                  );

                return (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-sm font-medium">选择 modelId</p>
                    <Select
                      value={agentCheckModelId}
                      onValueChange={(v) => setAgentCheckModelId(v)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {items.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
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

        {busyKey && (
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">正在应用配置...</p>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
