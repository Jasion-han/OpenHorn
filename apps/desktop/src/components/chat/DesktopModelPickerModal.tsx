import { RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
} from "ui";
import { formatChannelLabel, getChannelLabel } from "../../lib/i18n/agent";
import { notifyError, notifySuccess, notifyWarning } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import type { Channel } from "../../types/chat";
import { DesktopProviderLogo } from "./DesktopProviderLogo";

const api = createServerApi();

/**
 * Selection colour for this dialog.
 *
 * The palette in tokens.css is entirely achromatic, so "selected" used to be
 * drawn as a grey fill — the same visual language as "disabled". The selected
 * channel read as the one you *couldn't* pick. Blue is the accent this app
 * already uses for informational state (orange warns, green confirms), so
 * selection borrows it rather than introducing a fourth hue.
 *
 * Stated per-theme rather than via `bg-primary`, which resolves to near-white
 * in dark mode and would put the least important label on the brightest chip.
 */
const SELECTED_SURFACE =
  "border-blue-500 bg-blue-50 dark:border-blue-400/70 dark:bg-blue-400/[0.14]";

/** The one state worth reading at a glance: solid, not an outline. */
const BADGE_SELECTED = "border-transparent bg-blue-600 text-white dark:bg-blue-500";
/** Secondary state, still coloured — an outline in the same hue. */
const BADGE_DEFAULT =
  "border-blue-500/45 bg-transparent text-blue-700 dark:border-blue-400/45 dark:text-blue-300";
/**
 * Grey survives here on purpose: this badge means the row genuinely is
 * unavailable, which is the one thing grey should say. Kept a step darker than
 * `muted-foreground` so it stays readable rather than fading out.
 */
const BADGE_DISABLED = "border-foreground/25 bg-transparent text-foreground/70";

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
  /**
   * Where the pick goes. The picker itself is conversation-agnostic: the chat
   * area writes it to the open conversation, the welcome screen holds it until
   * the conversation is created.
   */
  onSelect: (selection: { channelId: string; modelId: string }) => void | Promise<void>;
  /** Only changes the confirmation wording — a draft has no conversation to save to. */
  appliesTo?: "conversation" | "draft";
  current?: { channelId: string; modelId: string } | null;
  conversationFixReason?: string | null;
  /**
   * Dynamic models from an ACP agent session. When provided, ACP channels show
   * these instead of the static `channel.models` list. The user's selection gets
   * forwarded to the agent via `session/set_config_option` on the next turn.
   */
  acpModels?: Array<{ id: string; name: string }>;
  /**
   * Called when the user selects an ACP channel in the left pane so the caller
   * can pre-connect to the agent and populate its dynamic model list.
   */
  onAcpChannelSelect?: (channelId: string) => void;
}) {
  const {
    opened,
    onClose,
    onSelect,
    appliesTo = "conversation",
    current,
    conversationFixReason,
    acpModels,
    onAcpChannelSelect,
  } = props;
  const channels = useChatStore((state) => state.channels);
  const loadChannels = useChatStore((state) => state.loadChannels);
  const openSettings = useDesktopShellStore((state) => state.openSettings);

  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    current?.channelId ?? null,
  );

  useEffect(() => {
    if (!opened) return;
    setQuery("");
    setSelectedChannelId(current?.channelId ?? null);
    void loadChannels();
  }, [opened, current?.channelId, loadChannels]);

  const groups = useMemo(() => {
    const base = buildOptions(channels);
    if (!acpModels || acpModels.length === 0) return base;
    // For ACP channels, replace static models with the dynamic list from the
    // agent session's config options, so the user sees exactly what the agent
    // supports and can switch at runtime.
    return base.map((group) => {
      if (group.channel.protocol !== "acp") return group;
      const dynamicModels: Channel["models"] = acpModels.map((m) => ({
        id: m.id,
        channelId: group.channel.id,
        modelId: m.id,
        displayName: m.name,
        enabled: true,
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      return { ...group, models: dynamicModels };
    });
  }, [channels, acpModels]);

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

  // Master-detail: the right pane always shows one channel's models. Prefer the
  // left-selected channel, but when searching fall back to the first channel that
  // actually has matching models so search hits are never hidden behind an empty pane.
  const activeGroup = useMemo(() => {
    if (filtered.length === 0) return null;
    const preferred = filtered.find((group) => group.channel.id === selectedChannelId);
    if (preferred && (!query.trim() || preferred.models.length > 0)) return preferred;
    return filtered.find((group) => group.models.length > 0) ?? filtered[0];
  }, [filtered, selectedChannelId, query]);

  const handleSyncModels = async () => {
    setBusy(true);
    try {
      const enabled = channels.filter((channel) => channel.enabled);
      const total = enabled.length;
      const goChannels = () => {
        onClose();
        openSettings("channels");
      };

      if (total === 0) {
        notifyWarning(
          getChannelLabel("settings.channel.picker.nothingToSyncTitle"),
          getChannelLabel("settings.channel.picker.nothingToSyncBody"),
          {
            action: {
              label: getChannelLabel("settings.channel.picker.goChannelSettings"),
              onClick: goChannels,
            },
          },
        );
        return;
      }

      const results = await Promise.allSettled(
        enabled.map(async (channel) => ({
          channel,
          result: await api.channels.fetchModels(channel.id),
        })),
      );

      const failed: Array<{ name: string; error: string }> = [];
      const warned: Array<{ name: string; warning: string }> = [];
      let successCount = 0;

      for (const item of results) {
        if (item.status === "rejected") {
          failed.push({
            name: getChannelLabel("settings.channel.picker.unknownChannel"),
            error:
              item.reason instanceof Error
                ? item.reason.message
                : getChannelLabel("settings.channel.notice.syncFailedTitle"),
          });
          continue;
        }
        if (!item.value.result.success) {
          const err =
            item.value.result.error || getChannelLabel("settings.channel.notice.syncFailedTitle");
          if (err.includes("CLI OAuth") || err.includes("cli_oauth")) {
            successCount += 1;
            continue;
          }
          failed.push({ name: item.value.channel.name, error: err });
          continue;
        }
        successCount += 1;
        if (item.value.result.error) {
          warned.push({
            name: item.value.channel.name,
            warning: item.value.result.error,
          });
        }
      }

      await loadChannels();

      const failCount = failed.length;
      const warnCount = warned.length;
      const normalizeMsg = (message: string) => message.replace(/\s+/g, " ").trim();
      const clipText = (text: string, maxLen: number) =>
        text.length <= maxLen ? text : `${text.slice(0, Math.max(0, maxLen - 1))}…`;
      const summarizeChannelName = (name: string) => {
        const normalized = normalizeMsg(name);
        if (!normalized) return getChannelLabel("settings.channel.picker.unknownChannel");
        try {
          const url = new URL(normalized);
          return clipText(url.hostname.replace(/^www\./, "") || normalized, 22);
        } catch {
          return clipText(normalized, 16);
        }
      };
      const summarizeForDisplay = (message: string) => {
        const normalized = normalizeMsg(message);
        if (!normalized) return normalized;
        const lower = normalized.toLowerCase();
        const titleMatch = normalized.match(/<title>\s*([^<]+)\s*<\/title>/i);
        if (titleMatch?.[1]) {
          const title = titleMatch[1].trim();
          const cfTitle = title.match(/\b(\d{3})\s*:\s*([^|]+)\s*$/);
          if (cfTitle?.[1] && cfTitle?.[2]) {
            return `${cfTitle[1]}: ${cfTitle[2].trim()}`;
          }
          return title;
        }
        if (lower.includes("error code 525") || lower.includes("ssl handshake failed")) {
          return "525: SSL handshake failed";
        }
        return normalized;
      };
      const clip = (message: string, maxLen = 32) => clipText(summarizeForDisplay(message), maxLen);
      const formatSummary = (items: Array<{ name: string; msg: string }>, limit = 1) => {
        const shown = items.slice(0, limit);
        const rest = items.length - shown.length;
        const head = shown
          .map((item) => `${summarizeChannelName(item.name)}: ${clip(item.msg)}`)
          .join("；");
        return rest > 0
          ? `${head}${formatChannelLabel("settings.channel.picker.moreCount", { count: rest })}`
          : head;
      };
      const failedSummary =
        failCount > 0
          ? formatSummary(
              failed.map((item) => ({
                name: item.name,
                msg: item.error || getChannelLabel("settings.channel.notice.syncFailedTitle"),
              })),
            )
          : "";
      const warnedSummary =
        warnCount > 0
          ? formatSummary(
              warned.map((item) => ({
                name: item.name,
                msg: item.warning || getChannelLabel("settings.channel.notice.needsAttentionTitle"),
              })),
            )
          : "";

      const warnBody = warnedSummary
        ? formatChannelLabel("settings.channel.picker.warnSummaryDetail", {
            count: warnCount,
            detail: warnedSummary,
          })
        : formatChannelLabel("settings.channel.picker.warnSummary", { count: warnCount });
      const failBody = failedSummary
        ? formatChannelLabel("settings.channel.picker.failSummaryDetail", {
            count: failCount,
            detail: failedSummary,
          })
        : formatChannelLabel("settings.channel.picker.failSummary", { count: failCount });

      if (failCount === 0 && warnCount === 0) {
        notifySuccess(
          formatChannelLabel("settings.channel.picker.syncDoneTitle", {
            done: successCount,
            total,
          }),
          getChannelLabel("settings.channel.picker.syncDoneBody"),
        );
        return;
      }

      const actionGoSettings = {
        label: getChannelLabel("settings.channel.picker.goChannelSettings"),
        onClick: goChannels,
      } as const;

      if (failCount === 0 && warnCount > 0) {
        notifyWarning(
          formatChannelLabel("settings.channel.picker.syncDoneTitle", {
            done: successCount,
            total,
          }),
          warnBody,
          { action: actionGoSettings, duration: 12_000 },
        );
        return;
      }

      if (successCount > 0) {
        notifyWarning(
          formatChannelLabel("settings.channel.picker.syncPartialTitle", {
            done: successCount,
            total,
          }),
          [
            failBody,
            warnCount > 0
              ? formatChannelLabel("settings.channel.picker.warnSummary", { count: warnCount })
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
          { action: actionGoSettings, duration: 12_000 },
        );
        return;
      }

      notifyError(
        formatChannelLabel("settings.channel.picker.syncAllFailedTitle", { total }),
        failBody,
        {
          action: actionGoSettings,
          duration: 12_000,
        },
      );
    } catch (error) {
      notifyError(
        getChannelLabel("settings.channel.notice.syncFailedTitle"),
        error instanceof Error
          ? error.message
          : getChannelLabel("settings.channel.picker.syncFailedGenericBody"),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSelect = async (channelId: string, modelId: string) => {
    setBusy(true);
    try {
      await onSelect({ channelId, modelId });
      notifySuccess(
        getChannelLabel("settings.channel.picker.modelUpdatedTitle"),
        getChannelLabel(
          appliesTo === "draft"
            ? "settings.channel.picker.modelUpdatedDraftBody"
            : "settings.channel.picker.modelUpdatedBody",
        ),
      );
      onClose();
    } catch (error) {
      notifyError(
        getChannelLabel("settings.channel.picker.updateFailedTitle"),
        error instanceof Error
          ? error.message
          : getChannelLabel("settings.channel.picker.updateFailedBody"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={opened} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{getChannelLabel("settings.channel.picker.title")}</DialogTitle>
          <DialogDescription className="sr-only">
            {getChannelLabel("settings.channel.picker.dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {conversationFixReason && (
            <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 shadow-minimal dark:border-orange-400/25 dark:bg-orange-400/10">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-orange-800 dark:text-orange-200">
                    {getChannelLabel("settings.channel.picker.fixNoticeTitle")}
                  </p>
                  <p className="break-words text-sm text-orange-700 dark:text-orange-300/90">
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
                placeholder={getChannelLabel("settings.channel.picker.searchPlaceholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
              />
            </div>
            <Button variant="outline" onClick={() => void handleSyncModels()} disabled={busy}>
              <RefreshCw size={16} className={busy ? "animate-spin" : ""} />
              {getChannelLabel("settings.channel.picker.syncButton")}
            </Button>
          </div>

          <div className="flex h-[440px] gap-3">
            {/* Left pane: channel list (single-select). Its own recessed surface
                rather than a bare divider — the two panes are a "pick a channel,
                then pick its model" sequence, and a panel edge says that where a
                hairline between two identical backgrounds did not. */}
            <div className="w-[260px] shrink-0 overflow-hidden rounded-lg border border-foreground/[0.08] bg-foreground/[0.02]">
              <ScrollArea className="h-full">
                <div className="flex flex-col gap-1.5 p-2">
                  {filtered.map(({ channel, models, isChannelDisabled, needsDefaultModel }) => {
                    const isActive = activeGroup?.channel.id === channel.id;
                    const hasSelected =
                      current?.channelId === channel.id &&
                      models.some((model) => current?.modelId === model.modelId);

                    return (
                      <button
                        type="button"
                        key={channel.id}
                        className={cn(
                          "flex w-full select-none flex-col gap-1.5 rounded-md border px-3 py-2 text-left transition-colors",
                          isActive
                            ? SELECTED_SURFACE
                            : "border-foreground/[0.07] hover:bg-foreground/[0.05]",
                        )}
                        onClick={() => {
                          setSelectedChannelId(channel.id);
                          if (channel.protocol === "acp" && onAcpChannelSelect) {
                            onAcpChannelSelect(channel.id);
                          }
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="secondary"
                            className="shrink-0 gap-1"
                            title={channel.provider}
                          >
                            <DesktopProviderLogo provider={channel.provider} className="size-4" />
                            <span className="sr-only">{channel.provider}</span>
                          </Badge>
                          {/* Wraps instead of truncating: several channels are
                              named by their base URL, and an ellipsis fell
                              exactly on the port — `192.168.0.113:80…` hid the
                              one character that told two of them apart. Two
                              lines is enough for any of them and keeps the rows
                              a predictable height. */}
                          <span className="line-clamp-2 break-all text-sm font-semibold">
                            {channel.name}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          {hasSelected && (
                            <Badge className={BADGE_SELECTED}>
                              {getChannelLabel("settings.channel.picker.badge.selected")}
                            </Badge>
                          )}
                          {channel.isDefault && (
                            <Badge variant="outline" className={BADGE_DEFAULT}>
                              {getChannelLabel("settings.channel.badge.default")}
                            </Badge>
                          )}
                          {needsDefaultModel && (
                            <Badge
                              variant="outline"
                              className="border-orange-400 text-orange-600 dark:border-orange-400/40 dark:text-orange-300"
                            >
                              {getChannelLabel("settings.channel.badge.missingDefaultModel")}
                            </Badge>
                          )}
                          {isChannelDisabled && (
                            <Badge variant="outline" className={BADGE_DISABLED}>
                              {getChannelLabel("settings.channel.badge.disabled")}
                            </Badge>
                          )}
                          <span className="text-xs text-foreground/60">
                            {formatChannelLabel("settings.channel.picker.modelCount", {
                              count: models.length,
                            })}
                          </span>
                        </div>
                      </button>
                    );
                  })}

                  {filtered.length === 0 && (
                    <div className="flex flex-col items-center gap-2 py-8">
                      <p className="text-sm text-muted-foreground">
                        {getChannelLabel("settings.channel.picker.noMatch")}
                      </p>
                      <Button variant="outline" onClick={() => setQuery("")}>
                        {getChannelLabel("settings.channel.picker.clearSearch")}
                      </Button>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Right pane: models of the active channel. Same frame as the left
                one — a bordered column next to an unbounded one left the models
                floating in the dialog with no edge of their own. */}
            <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-foreground/[0.08]">
              <ScrollArea className="h-full">
                <div className="flex flex-col gap-1.5 p-2">
                  {activeGroup && activeGroup.models.length === 0 && (
                    <p className="px-1 text-sm text-muted-foreground">
                      {getChannelLabel("settings.channel.picker.noModelsHint")}
                    </p>
                  )}

                  {activeGroup?.models.map((model) => {
                    const channel = activeGroup.channel;
                    const selected =
                      current?.channelId === channel.id && current?.modelId === model.modelId;
                    const isModelDisabled = !model.enabled;
                    const disabled = busy || activeGroup.isChannelDisabled || isModelDisabled;

                    return (
                      <button
                        type="button"
                        key={`${channel.id}:${model.modelId}`}
                        className={cn(
                          "w-full rounded-md border border-foreground/[0.07] px-3 py-2 text-left transition-colors",
                          disabled ? "cursor-not-allowed opacity-60" : "hover:bg-foreground/[0.05]",
                          selected && SELECTED_SURFACE,
                        )}
                        disabled={disabled}
                        onClick={() => {
                          if (disabled) return;
                          void handleSelect(channel.id, model.modelId);
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="break-all text-sm font-medium">
                              {model.displayName || model.modelId}
                            </p>
                            {/* Only when it adds something. Most channels report
                                no separate display name, so this line was
                                repeating the title verbatim — two identical
                                strings stacked, the second one greyed out. */}
                            {model.displayName && model.displayName !== model.modelId && (
                              <p className="break-all text-xs text-foreground/60">
                                {model.modelId}
                              </p>
                            )}
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            {model.isDefault && (
                              <Badge variant="outline" className={BADGE_DEFAULT}>
                                {getChannelLabel("settings.channel.badge.default")}
                              </Badge>
                            )}
                            {isModelDisabled && (
                              <Badge variant="outline" className={BADGE_DISABLED}>
                                {getChannelLabel("settings.channel.badge.disabled")}
                              </Badge>
                            )}
                            {selected && (
                              <Badge className={BADGE_SELECTED}>
                                {getChannelLabel("settings.channel.picker.badge.selected")}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
