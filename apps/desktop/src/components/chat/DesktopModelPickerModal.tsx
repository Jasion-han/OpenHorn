import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
  cn,
} from "ui";
import type { Channel } from "../../types/chat";
import { useChatStore } from "../../stores/chatStore";
import { DesktopProviderLogo } from "./DesktopProviderLogo";

type ModelGroup = {
  channel: Channel;
  models: Channel["models"];
  isChannelDisabled: boolean;
  needsDefaultModel: boolean;
};

function sortChannels(a: Channel, b: Channel) {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function sortModels(a: Channel["models"][number], b: Channel["models"][number]) {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return (a.displayName || a.modelId).localeCompare(b.displayName || b.modelId);
}

function buildOptions(channels: Channel[]): ModelGroup[] {
  const enabled = channels.filter((item) => item.enabled).sort(sortChannels);
  const disabled = channels.filter((item) => !item.enabled).sort(sortChannels);

  return [...enabled, ...disabled].map((item) => ({
    channel: item,
    models: [...item.models].sort(sortModels),
    isChannelDisabled: !item.enabled,
    needsDefaultModel: Boolean(item.isDefault && item.enabled && !item.defaultModelId),
  }));
}

export function DesktopModelPickerModal(props: {
  opened: boolean;
  onClose: () => void;
  conversationId: string;
  current?: { channelId: string; modelId: string } | null;
  conversationFixReason?: string | null;
}) {
  const { opened, onClose, conversationId, current, conversationFixReason } = props;
  const channels = useChatStore((state) => state.channels);
  const loadChannels = useChatStore((state) => state.loadChannels);
  const updateConversation = useChatStore((state) => state.updateConversation);

  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(current?.channelId ? [current.channelId] : []),
  );

  useEffect(() => {
    if (!opened) return;
    setQuery("");
    setExpanded(new Set(current?.channelId ? [current.channelId] : []));
    void loadChannels();
  }, [opened, current?.channelId, loadChannels]);

  const groups = useMemo(() => buildOptions(channels), [channels]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;

    return groups
      .map((group) => ({
        channel: group.channel,
        isChannelDisabled: group.isChannelDisabled,
        needsDefaultModel: group.needsDefaultModel,
        models: (() => {
          const channelMatch =
            group.channel.name.toLowerCase().includes(q) ||
            group.channel.provider.toLowerCase().includes(q) ||
            group.channel.baseUrl?.toLowerCase().includes(q);
          if (channelMatch) return group.models;
          return group.models.filter(
            (model) =>
              model.modelId.toLowerCase().includes(q) ||
              model.displayName.toLowerCase().includes(q),
          );
        })(),
      }))
      .filter(
        (group) =>
          group.models.length > 0 ||
          group.channel.name.toLowerCase().includes(q) ||
          group.channel.provider.toLowerCase().includes(q),
      );
  }, [groups, query]);

  const toggleExpanded = (channelId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  const handleSelect = async (channelId: string, modelId: string) => {
    setBusy(true);
    try {
      await updateConversation(conversationId, { channelId, modelId });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={opened} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>选择模型</DialogTitle>
          <DialogDescription className="sr-only">
            为当前会话选择可用渠道和模型。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {conversationFixReason && (
            <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 shadow-minimal">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-orange-800">当前会话模型不可用</p>
                  <p className="break-words text-sm text-orange-700">{conversationFixReason}</p>
                </div>
                <p className="shrink-0 text-xs text-muted-foreground">请在这里重新选择</p>
              </div>
            </div>
          )}

          <div className="relative flex-1">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              placeholder="搜索渠道或模型..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-9"
            />
          </div>

          <ScrollArea className="h-[420px]">
            <div className="flex flex-col gap-3 pr-3">
              {filtered.map(({ channel, models, isChannelDisabled, needsDefaultModel }) => {
                const isExpanded = query.trim() ? true : expanded.has(channel.id);
                const hasSelected = models.some(
                  (model) =>
                    current?.channelId === channel.id && current?.modelId === model.modelId,
                );

                return (
                  <div key={channel.id}>
                    <button
                      type="button"
                      className="flex w-full select-none items-center justify-between rounded-md border px-3 py-2 transition-colors hover:bg-accent"
                      onClick={() => toggleExpanded(channel.id)}
                    >
                      <div className="flex items-center gap-2">
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span className="text-sm font-semibold">{channel.name}</span>
                        <Badge variant="secondary" className="gap-1" title={channel.provider}>
                          <DesktopProviderLogo provider={channel.provider} className="size-4" />
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
                        <span className="text-xs text-muted-foreground">{models.length} 个模型</span>
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="mt-1.5 flex flex-col gap-1.5 pl-4">
                        {models.length === 0 && (
                          <p className="px-1 text-sm text-muted-foreground">当前渠道还没有可用模型。</p>
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
                                selected && "border-primary bg-accent",
                              )}
                              disabled={disabled}
                              onClick={() => {
                                if (disabled) return;
                                void handleSelect(channel.id, model.modelId);
                              }}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium">
                                    {model.displayName || model.modelId}
                                  </p>
                                  <p className="truncate text-xs text-muted-foreground">
                                    {model.modelId}
                                  </p>
                                </div>

                                <div className="flex shrink-0 items-center gap-1.5">
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
