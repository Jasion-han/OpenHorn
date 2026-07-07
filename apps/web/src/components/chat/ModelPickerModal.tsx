"use client";

import { ChevronDown, ChevronRight, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ProviderLogo } from "@/components/providers/ProviderLogo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type ApiChannel, api } from "@/lib/api";
import { notifyError, notifySuccess, notifyWarning } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";

type ModelGroup = {
  channel: ApiChannel;
  models: ApiChannel["models"];
  isChannelDisabled: boolean;
  needsDefaultModel: boolean;
};

function sortChannels(a: ApiChannel, b: ApiChannel) {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function sortModels(a: ApiChannel["models"][number], b: ApiChannel["models"][number]) {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return (a.displayName || a.modelId).localeCompare(b.displayName || b.modelId);
}

function buildOptions(channels: ApiChannel[]): ModelGroup[] {
  const enabled = channels.filter((c) => c.enabled).sort(sortChannels);
  const disabled = channels.filter((c) => !c.enabled).sort(sortChannels);

  return [...enabled, ...disabled].map((c) => ({
    channel: c,
    models: [...c.models].sort(sortModels),
    isChannelDisabled: !c.enabled,
    needsDefaultModel: Boolean(c.isDefault && c.enabled && !c.defaultModelId),
  }));
}

export function ModelPickerModal(props: {
  opened: boolean;
  onClose: () => void;
  conversationId: string;
  current?: { channelId: string; modelId: string } | null;
  conversationFixReason?: string | null;
  beforeSelect?: (channelId: string, modelId: string) => Promise<void>;
  onSelect?: (channelId: string, modelId: string) => Promise<void>;
}) {
  const {
    opened,
    onClose,
    conversationId,
    current,
    conversationFixReason,
    beforeSelect,
    onSelect,
  } = props;
  const channels = useChatStore((state) => state.channels);
  const setChannels = useChatStore((state) => state.setChannels);
  const setConversationModel = useChatStore((state) => state.setConversationModel);

  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    current?.channelId ? new Set([current.channelId]) : new Set(),
  );

  const toggleExpanded = (channelId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });

  useEffect(() => {
    if (!opened) return;
    setQuery("");
    setExpanded(current?.channelId ? new Set([current.channelId]) : new Set());
    void (async () => {
      try {
        const { channels } = await api.channels.list();
        setChannels(channels);
      } catch {
        // Best-effort; can still render from cached store.
      }
    })();
  }, [opened, setChannels]);

  const groups = useMemo(() => buildOptions(channels), [channels]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;

    return groups
      .map((g) => ({
        channel: g.channel,
        isChannelDisabled: g.isChannelDisabled,
        needsDefaultModel: g.needsDefaultModel,
        models: (() => {
          const channelMatch =
            g.channel.name.toLowerCase().includes(q) ||
            g.channel.provider.toLowerCase().includes(q) ||
            g.channel.baseUrl?.toLowerCase().includes(q);
          if (channelMatch) return g.models;
          return g.models.filter(
            (m) => m.modelId.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q),
          );
        })(),
      }))
      .filter(
        (g) =>
          g.models.length > 0 ||
          g.channel.name.toLowerCase().includes(q) ||
          g.channel.provider.toLowerCase().includes(q),
      );
  }, [groups, query]);

  const handleSyncModels = async () => {
    setBusy(true);
    try {
      const { channels: currentChannels } = await api.channels.list();
      const enabled = currentChannels.filter((c) => c.enabled);

      const results = await Promise.allSettled(
        enabled.map(async (c) => ({ channel: c, result: await api.channels.fetchModels(c.id) })),
      );

      const failed: Array<{ name: string; error: string }> = [];
      const warned: Array<{ name: string; warning: string }> = [];
      let successCount = 0;
      for (const r of results) {
        if (r.status === "rejected") {
          failed.push({
            name: "未知渠道",
            error: r.reason instanceof Error ? r.reason.message : "同步失败",
          });
          continue;
        }
        if (!r.value.result.success) {
          failed.push({ name: r.value.channel.name, error: r.value.result.error || "同步失败" });
          continue;
        }
        successCount += 1;
        if (r.value.result.error) {
          warned.push({ name: r.value.channel.name, warning: r.value.result.error });
        }
      }

      const { channels: next } = await api.channels.list();
      setChannels(next);

      const total = enabled.length;
      const failCount = failed.length;
      const warnCount = warned.length;

      const normalizeMsg = (msg: string) => msg.replace(/\s+/g, " ").trim();

      const clipText = (text: string, maxLen: number) => {
        if (text.length <= maxLen) return text;
        return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
      };

      const summarizeChannelName = (name: string) => {
        const normalized = normalizeMsg(name);
        if (!normalized) return "未知渠道";
        try {
          const url = new URL(normalized);
          return clipText(url.hostname.replace(/^www\./, "") || normalized, 22);
        } catch {
          return clipText(normalized, 16);
        }
      };

      const summarizeForDisplay = (msg: string) => {
        const normalized = normalizeMsg(msg);
        if (!normalized) return normalized;
        const lower = normalized.toLowerCase();

        // Cloudflare / HTML error pages can be extremely long and unreadable.
        // Prefer extracting the most meaningful hint while preserving the original in the copy details action.
        const titleMatch = normalized.match(/<title>\s*([^<]+)\s*<\/title>/i);
        if (titleMatch?.[1]) {
          const title = titleMatch[1].trim();
          // Often: "domain | 525: SSL handshake failed"
          const cfTitle = title.match(/\b(\d{3})\s*:\s*([^|]+)\s*$/);
          if (cfTitle?.[1] && cfTitle?.[2]) return `${cfTitle[1]}: ${cfTitle[2].trim()}`;
          return title;
        }

        if (lower.includes("error code 525") || lower.includes("ssl handshake failed")) {
          return "525: SSL handshake failed";
        }

        return normalized;
      };

      const clip = (msg: string, maxLen = 32) => {
        const normalized = summarizeForDisplay(msg);
        return clipText(normalized, maxLen);
      };

      const formatSummary = (items: Array<{ name: string; msg: string }>, limit = 1) => {
        const shown = items.slice(0, limit);
        const rest = items.length - shown.length;
        const head = shown
          .map((item) => `${summarizeChannelName(item.name)}: ${clip(item.msg)}`)
          .join("；");
        return rest > 0 ? `${head}，另 ${rest} 个` : head;
      };

      if (total === 0) {
        notifyWarning("无需同步", "当前没有启用的渠道。", {
          action: {
            label: "去渠道设置",
            onClick: () => window.location.assign("/settings?tab=channels"),
          },
        });
        return;
      }

      const failedSummary =
        failCount > 0
          ? formatSummary(failed.map((f) => ({ name: f.name, msg: f.error || "同步失败" })))
          : "";
      const warnedSummary =
        warnCount > 0
          ? formatSummary(warned.map((w) => ({ name: w.name, msg: w.warning || "需要处理" })))
          : "";

      if (failCount === 0 && warnCount === 0) {
        notifySuccess(`同步完成（${successCount}/${total}）`, "已更新模型列表");
        return;
      }

      const actionGoSettings = {
        label: "去渠道设置",
        onClick: () => {
          try {
            onClose();
          } catch {
            // ignore
          }
          window.location.assign("/settings?tab=channels");
        },
      } as const;

      if (failCount === 0 && warnCount > 0) {
        notifyWarning(
          `同步完成（${successCount}/${total}）`,
          `提示 ${warnCount} 个${warnedSummary ? `（${warnedSummary}）` : ""}`,
          { action: actionGoSettings, duration: 12_000 },
        );
        return;
      }

      if (successCount > 0) {
        notifyWarning(
          `同步部分完成（${successCount}/${total}）`,
          [
            `失败 ${failCount} 个${failedSummary ? `（${failedSummary}）` : ""}`,
            warnCount > 0 ? `提示 ${warnCount} 个` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          { action: actionGoSettings, duration: 12_000 },
        );
        return;
      }

      notifyError(
        `同步失败（0/${total}）`,
        `失败 ${failCount} 个${failedSummary ? `（${failedSummary}）` : ""}`,
        { action: actionGoSettings, duration: 12_000 },
      );
    } catch (error) {
      notifyError("同步失败", error instanceof Error ? error.message : "无法同步模型列表");
    } finally {
      setBusy(false);
    }
  };

  const handleSelect = async (channelId: string, modelId: string) => {
    setBusy(true);
    try {
      if (beforeSelect) {
        await beforeSelect(channelId, modelId);
      }
      if (onSelect) {
        await onSelect(channelId, modelId);
      } else {
        await setConversationModel(conversationId, channelId, modelId);
      }
      notifySuccess("模型已更新", "已保存到当前对话");
      onClose();
    } catch (error) {
      notifyError("更新失败", error instanceof Error ? error.message : "无法更新模型选择");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={opened} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>选择模型</DialogTitle>
          <DialogDescription className="sr-only">
            为当前会话选择可用渠道和模型，也可以在这里同步模型列表。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {conversationFixReason && (
            <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 shadow-minimal dark:border-orange-800 dark:bg-orange-950">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-orange-800 dark:text-orange-200">
                    当前对话模型不可用
                  </p>
                  <p className="text-sm text-orange-700 dark:text-orange-300 break-words">
                    {conversationFixReason}
                  </p>
                </div>
                <p className="shrink-0 text-xs text-muted-foreground">
                  Set a default model in Settings (gear) → Channels
                </p>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                placeholder="搜索渠道或模型..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Button variant="outline" onClick={() => void handleSyncModels()} disabled={busy}>
              <RefreshCw size={16} className={busy ? "animate-spin" : ""} />
              同步
            </Button>
          </div>

          <ScrollArea className="h-[420px]">
            <div className="flex flex-col gap-3 pr-3">
              {filtered.map(({ channel, models, isChannelDisabled, needsDefaultModel }) => {
                const isExpanded = query.trim() ? true : expanded.has(channel.id);
                const hasSelected = models.some(
                  (m) => current?.channelId === channel.id && current?.modelId === m.modelId,
                );
                return (
                  <div key={channel.id}>
                    <button
                      type="button"
                      className="flex w-full select-none items-center justify-between rounded-md border px-3 py-2 hover:bg-accent transition-colors"
                      onClick={() => toggleExpanded(channel.id)}
                    >
                      <div className="flex items-center gap-2">
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span className="text-sm font-semibold">{channel.name}</span>
                        <Badge variant="secondary" className="gap-1" title={channel.provider}>
                          <ProviderLogo provider={channel.provider} className="size-4" />
                          <span className="sr-only">{channel.provider}</span>
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {hasSelected && <Badge>已选</Badge>}
                        {channel.isDefault && <Badge variant="outline">默认</Badge>}
                        {needsDefaultModel && (
                          <Badge variant="outline" className="border-orange-400 text-orange-600">
                            缺少默认模型
                          </Badge>
                        )}
                        {isChannelDisabled && <Badge variant="secondary">已禁用</Badge>}
                        <span className="text-xs text-muted-foreground">
                          {models.length} 个模型
                        </span>
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="mt-1.5 flex flex-col gap-1.5 pl-4">
                        {models.length === 0 && (
                          <p className="text-sm text-muted-foreground px-1">
                            暂无模型，请先点击上方「同步」获取模型列表。
                          </p>
                        )}
                        {models.map((model) => {
                          const selected =
                            current?.channelId === channel.id && current?.modelId === model.modelId;
                          const isModelDisabled = !model.enabled;
                          const disabled = busy || isChannelDisabled || isModelDisabled;
                          return (
                            <button
                              type="button"
                              key={`${channel.id}:${model.modelId}`}
                              className={cn(
                                "w-full rounded-md border px-3 py-2 text-left transition-colors",
                                disabled ? "cursor-not-allowed opacity-60" : "hover:bg-accent",
                                selected && "bg-accent border-primary",
                              )}
                              disabled={disabled}
                              onClick={() => {
                                if (disabled) return;
                                void handleSelect(channel.id, model.modelId);
                              }}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-sm font-medium truncate">
                                    {model.displayName || model.modelId}
                                  </p>
                                  <p className="text-xs text-muted-foreground truncate">
                                    {model.modelId}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {model.isDefault && <Badge variant="secondary">默认</Badge>}
                                  {isModelDisabled && <Badge variant="secondary">已禁用</Badge>}
                                  {selected && <Badge>已选</Badge>}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {filtered.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-8">
                  <p className="text-sm text-muted-foreground">没有匹配的模型</p>
                  <Button variant="outline" onClick={() => setQuery("")}>
                    清空搜索
                  </Button>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
