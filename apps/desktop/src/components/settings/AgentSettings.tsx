import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, SettingsCard, SettingsSection } from "ui";
import { getGlobalDefaultChannel } from "../../lib/defaultChannel";
import { getAgentSettingsLabel } from "../../lib/i18n/agent";
import { createServerApi } from "../../lib/serverApi";
import { BACKEND_UP_EVENT } from "../../stores/backendStatusStore";
import type { ApiChannel, Channel } from "../../types/chat";
import { DesktopProviderLogo } from "../chat/DesktopProviderLogo";
import { DeepSeekToolSettings } from "./DeepSeekToolSettings";
import { JevSettings } from "./JevSettings";

const api = createServerApi();

const SETTINGS_UPDATED_EVENT = "openhorn:agent-settings-updated";

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
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const lifecycle = useRef({ mounted: false, request: 0, loaded: false });
  const defaultChannel = useMemo(() => getGlobalDefaultChannel(channels), [channels]);

  const loadAll = useCallback(async () => {
    const request = ++lifecycle.current.request;
    const current = () => lifecycle.current.mounted && lifecycle.current.request === request;
    setLoading(true);
    setLoadError(false);
    try {
      const { channels } = await api.channels.list();
      if (!current()) return;
      setChannels(channels.map(mapChannel));
      lifecycle.current.loaded = true;
      setLoaded(true);
    } catch {
      if (current()) setLoadError(true);
    } finally {
      if (current()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    lifecycle.current.mounted = true;
    void loadAll();
    const onUp = () => void loadAll();
    window.addEventListener(BACKEND_UP_EVENT, onUp);
    window.addEventListener(SETTINGS_UPDATED_EVENT, onUp);
    return () => {
      lifecycle.current.mounted = false;
      lifecycle.current.request++;
      window.removeEventListener(BACKEND_UP_EVENT, onUp);
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onUp);
    };
  }, [loadAll]);

  return (
    <div className="flex flex-col gap-8">
      {loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 text-sm">
          <span>{getAgentSettingsLabel("settings.agent.notify.loadFailedBody")}</span>
          <Button variant="outline" size="sm" onClick={() => void loadAll()} disabled={loading}>
            {getAgentSettingsLabel("settings.agent.retry")}
          </Button>
        </div>
      ) : !loaded ? (
        <output className="text-sm text-muted-foreground">
          {getAgentSettingsLabel("settings.agent.loading")}
        </output>
      ) : null}
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
              ) : loaded ? (
                <p className="text-sm text-muted-foreground">
                  {getAgentSettingsLabel("settings.agent.defaultChannel.unset")}
                </p>
              ) : null}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <DeepSeekToolSettings />
      <JevSettings />
    </div>
  );
}
