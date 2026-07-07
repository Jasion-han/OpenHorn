import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Input, Label, SettingsCard, SettingsSection, Switch } from "ui";
import { getGlobalDefaultChannel } from "../../lib/defaultChannel";
import { getAgentSettingsLabel } from "../../lib/i18n/agent";
import { notifyError, notifySuccess } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import { BACKEND_UP_EVENT } from "../../stores/backendStatusStore";
import type { ApiChannel, Channel } from "../../types/chat";
import { DesktopProviderLogo } from "../chat/DesktopProviderLogo";

const api = createServerApi();

const TAVILY_API_KEY_SETTING = "liveSearch.tavilyApiKey";
const TAVILY_ENABLED_SETTING = "liveSearch.tavilyEnabled";

function mapChannel(channel: ApiChannel): Channel {
  return {
    id: channel.id,
    userId: channel.userId,
    name: channel.name,
    provider: channel.provider,
    protocol: channel.protocol,
    baseUrl: channel.baseUrl || undefined,
    enabled: channel.enabled,
    isDefault: channel.isDefault,
    createdAt: new Date(channel.createdAt),
    updatedAt: new Date(channel.updatedAt),
    models: channel.models.map((model) => ({
      id: model.id,
      channelId: model.channelId,
      modelId: model.modelId,
      displayName: model.displayName,
      enabled: model.enabled,
      isDefault: model.isDefault,
      createdAt: new Date(model.createdAt),
      updatedAt: new Date(model.updatedAt),
    })),
    defaultModelId: channel.defaultModelId || undefined,
    legacyModel: channel.legacyModel || undefined,
    hasApiKey: channel.hasApiKey,
  };
}

export function AgentSettings() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [, setLoading] = useState(false);

  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [savedTavilyApiKey, setSavedTavilyApiKey] = useState("");
  const [savingTavilyApiKey, setSavingTavilyApiKey] = useState(false);
  const [tavilyEnabled, setTavilyEnabled] = useState(true);
  const [savingTavilyEnabled, setSavingTavilyEnabled] = useState(false);

  const defaultChannel = useMemo(() => getGlobalDefaultChannel(channels), [channels]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [{ channels }, { settings }] = await Promise.all([
        api.channels.list(),
        api.settings.get([TAVILY_API_KEY_SETTING, TAVILY_ENABLED_SETTING]),
      ]);

      setChannels(channels.map(mapChannel));

      const currentKey = settings[TAVILY_API_KEY_SETTING] || "";
      const enabledRaw = settings[TAVILY_ENABLED_SETTING];
      setTavilyApiKey(currentKey);
      setSavedTavilyApiKey(currentKey);
      setTavilyEnabled(
        enabledRaw == null ? true : String(enabledRaw).trim().toLowerCase() !== "false",
      );
    } catch (error) {
      notifyError(
        getAgentSettingsLabel("settings.agent.notify.loadFailedTitle"),
        error instanceof Error
          ? error.message
          : getAgentSettingsLabel("settings.agent.notify.loadFailedBody"),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const onUp = () => {
      void loadAll();
    };

    window.addEventListener(BACKEND_UP_EVENT, onUp);
    return () => {
      window.removeEventListener(BACKEND_UP_EVENT, onUp);
    };
  }, [loadAll]);

  const handleSaveTavilyApiKey = async () => {
    setSavingTavilyApiKey(true);
    try {
      await api.settings.set(TAVILY_API_KEY_SETTING, tavilyApiKey.trim() || null);
      setSavedTavilyApiKey(tavilyApiKey.trim());
      notifySuccess(
        getAgentSettingsLabel("settings.agent.notify.savedTitle"),
        tavilyApiKey.trim()
          ? getAgentSettingsLabel("settings.agent.notify.tavilyKeyUpdatedBody")
          : getAgentSettingsLabel("settings.agent.notify.tavilyKeyClearedBody"),
      );
    } catch (error) {
      notifyError(
        getAgentSettingsLabel("settings.agent.notify.saveFailedTitle"),
        error instanceof Error
          ? error.message
          : getAgentSettingsLabel("settings.agent.notify.saveTavilyKeyFailedBody"),
      );
    } finally {
      setSavingTavilyApiKey(false);
    }
  };

  const handleToggleTavilyEnabled = async () => {
    const next = !tavilyEnabled;
    setTavilyEnabled(next);
    setSavingTavilyEnabled(true);
    try {
      await api.settings.set(TAVILY_ENABLED_SETTING, next ? "true" : "false");
      notifySuccess(
        getAgentSettingsLabel("settings.agent.notify.updatedTitle"),
        next
          ? getAgentSettingsLabel("settings.agent.notify.tavilyEnabledBody")
          : getAgentSettingsLabel("settings.agent.notify.tavilyDisabledBody"),
      );
    } catch (error) {
      setTavilyEnabled(!next);
      notifyError(
        getAgentSettingsLabel("settings.agent.notify.updateFailedTitle"),
        error instanceof Error
          ? error.message
          : getAgentSettingsLabel("settings.agent.notify.updateTavilyFailedBody"),
      );
    } finally {
      setSavingTavilyEnabled(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title={getAgentSettingsLabel("settings.agent.networking.title")}
        description={getAgentSettingsLabel("settings.agent.networking.description")}
      >
        <SettingsCard divided={false} className="p-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {getAgentSettingsLabel("settings.agent.builtinRealtime.title")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {getAgentSettingsLabel("settings.agent.builtinRealtime.description")}
                </p>
              </div>
              <Badge variant="secondary">Product-owned</Badge>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/60 p-3">
              <div>
                <p className="text-sm font-medium">
                  {getAgentSettingsLabel("settings.agent.defaultChannel.title")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {getAgentSettingsLabel("settings.agent.defaultChannel.description")}
                </p>
              </div>
              {defaultChannel ? (
                <Badge
                  variant="secondary"
                  className="gap-1 whitespace-nowrap"
                  title={defaultChannel.provider}
                >
                  <DesktopProviderLogo provider={defaultChannel.provider} className="size-4" />
                  <span className="sr-only">{defaultChannel.provider}</span>
                  <span>{defaultChannel.modelId}</span>
                </Badge>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {getAgentSettingsLabel("settings.agent.defaultChannel.unset")}
                </p>
              )}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={getAgentSettingsLabel("settings.agent.tavily.title")}
        description={getAgentSettingsLabel("settings.agent.tavily.description")}
      >
        <SettingsCard divided={false} className="p-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {getAgentSettingsLabel("settings.agent.tavily.userKeyTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {getAgentSettingsLabel("settings.agent.tavily.userKeyDescription")}
                </p>
              </div>
              {!tavilyEnabled ? (
                <Badge variant="outline">
                  {getAgentSettingsLabel("settings.agent.tavily.badge.disabled")}
                </Badge>
              ) : savedTavilyApiKey ? (
                <Badge variant="secondary">
                  {getAgentSettingsLabel("settings.agent.tavily.badge.userOverride")}
                </Badge>
              ) : (
                <Badge variant="outline">
                  {getAgentSettingsLabel("settings.agent.tavily.badge.serverDefault")}
                </Badge>
              )}
            </div>

            <div className="flex items-center justify-between rounded-xl border border-border/50 bg-background/60 p-3">
              <div>
                <p className="text-sm font-medium">
                  {getAgentSettingsLabel("settings.agent.tavily.enableTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {getAgentSettingsLabel("settings.agent.tavily.enableDescription")}
                </p>
              </div>
              <Switch
                checked={tavilyEnabled}
                onCheckedChange={() => void handleToggleTavilyEnabled()}
                disabled={savingTavilyEnabled}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Tavily API Key</Label>
              <Input
                type="password"
                value={tavilyApiKey}
                onChange={(event) => setTavilyApiKey(event.target.value)}
                placeholder="tvly-..."
                autoComplete="off"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setTavilyApiKey(savedTavilyApiKey)}
                disabled={savingTavilyApiKey}
              >
                {getAgentSettingsLabel("settings.agent.cancel")}
              </Button>
              <Button
                onClick={() => void handleSaveTavilyApiKey()}
                disabled={savingTavilyApiKey || tavilyApiKey === savedTavilyApiKey}
              >
                {savingTavilyApiKey
                  ? getAgentSettingsLabel("settings.agent.saving")
                  : getAgentSettingsLabel("settings.agent.save")}
              </Button>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
