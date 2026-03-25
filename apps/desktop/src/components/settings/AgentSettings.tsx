import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  SettingsCard,
  SettingsSection,
  Switch,
  Textarea,
} from "ui";
import { getGlobalDefaultChannel } from "../../lib/defaultChannel";
import { notifyError, notifySuccess } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import type { ApiChannel, Channel } from "../../types/chat";
import { DesktopProviderLogo } from "../chat/DesktopProviderLogo";

const api = createServerApi();

type MCPServer = {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
};

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
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(false);

  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [savedTavilyApiKey, setSavedTavilyApiKey] = useState("");
  const [savingTavilyApiKey, setSavingTavilyApiKey] = useState(false);
  const [tavilyEnabled, setTavilyEnabled] = useState(true);
  const [savingTavilyEnabled, setSavingTavilyEnabled] = useState(false);

  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpType, setMcpType] = useState("stdio");
  const [mcpConfig, setMcpConfig] = useState("{\n  \n}");
  const [mcpBusyId, setMcpBusyId] = useState<string | null>(null);

  const defaultChannel = useMemo(() => getGlobalDefaultChannel(channels), [channels]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [{ channels }, { servers }, { settings }] = await Promise.all([
        api.channels.list(),
        api.mcp.listServers(),
        api.settings.get([TAVILY_API_KEY_SETTING, TAVILY_ENABLED_SETTING]),
      ]);

      setChannels(channels.map(mapChannel));
      setMcpServers((servers || []) as MCPServer[]);

      const currentKey = settings[TAVILY_API_KEY_SETTING] || "";
      const enabledRaw = settings[TAVILY_ENABLED_SETTING];
      setTavilyApiKey(currentKey);
      setSavedTavilyApiKey(currentKey);
      setTavilyEnabled(
        enabledRaw == null ? true : String(enabledRaw).trim().toLowerCase() !== "false",
      );
    } catch (error) {
      notifyError("加载失败", error instanceof Error ? error.message : "无法加载 Agent 设置。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const handleSaveTavilyApiKey = async () => {
    setSavingTavilyApiKey(true);
    try {
      await api.settings.set(TAVILY_API_KEY_SETTING, tavilyApiKey.trim() || null);
      setSavedTavilyApiKey(tavilyApiKey.trim());
      notifySuccess(
        "已保存",
        tavilyApiKey.trim()
          ? "Tavily API Key 已更新，将优先覆盖服务端默认 Key。"
          : "已恢复使用服务端默认 Tavily Key。",
      );
    } catch (error) {
      notifyError("保存失败", error instanceof Error ? error.message : "无法保存 Tavily Key。");
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
      notifySuccess("已更新", next ? "Tavily 搜索已启用。" : "Tavily 搜索已关闭。");
    } catch (error) {
      setTavilyEnabled(!next);
      notifyError("更新失败", error instanceof Error ? error.message : "无法更新 Tavily 状态。");
    } finally {
      setSavingTavilyEnabled(false);
    }
  };

  const handleCreateMcp = async () => {
    if (!mcpName.trim()) {
      notifyError("配置错误", "请填写 MCP Server 名称。");
      return;
    }

    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(mcpConfig);
    } catch {
      notifyError("配置错误", "MCP config 必须是合法 JSON。");
      return;
    }

    setLoading(true);
    try {
      await api.mcp.createServer({
        name: mcpName.trim(),
        type: mcpType,
        config: parsedConfig,
      });
      setMcpModalOpen(false);
      setMcpName("");
      setMcpType("stdio");
      setMcpConfig("{\n  \n}");
      await loadAll();
      notifySuccess("已创建", "MCP Server 已添加。");
    } catch (error) {
      notifyError("创建失败", error instanceof Error ? error.message : "无法创建 MCP Server。");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteMcp = async (id: string) => {
    setMcpBusyId(id);
    try {
      await api.mcp.deleteServer(id);
      await loadAll();
      notifySuccess("已删除", "MCP Server 已删除。");
    } catch (error) {
      notifyError("删除失败", error instanceof Error ? error.message : "无法删除 MCP Server。");
    } finally {
      setMcpBusyId(null);
    }
  };

  const handleToggleMcp = async (server: MCPServer) => {
    setMcpBusyId(server.id);
    try {
      await api.mcp.updateServer(server.id, { isEnabled: !server.isEnabled });
      await loadAll();
      notifySuccess("已更新", "MCP Server 状态已更新。");
    } catch (error) {
      notifyError("更新失败", error instanceof Error ? error.message : "无法更新 MCP Server 状态。");
    } finally {
      setMcpBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="默认允许联网能力"
        description="普通聊天会在需要最新信息时使用产品内置的实时能力；Agent 在此基础上叠加更多工具。默认渠道决定模型供应商，但不是实时能力的开关。"
      >
        <SettingsCard divided={false} className="p-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">内置实时能力</p>
                <p className="text-xs text-muted-foreground">
                  支持本地时间解析、结构化天气查询，以及无 provider 时的离线降级提示。
                </p>
              </div>
              <Badge variant="secondary">Product-owned</Badge>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/60 p-3">
              <div>
                <p className="text-sm font-medium">默认模型渠道</p>
                <p className="text-xs text-muted-foreground">
                  用于 Chat/Agent 的基础模型调用；实时能力会在服务端先行路由，再进入模型。
                </p>
              </div>
              {defaultChannel ? (
                <Badge variant="secondary" className="gap-1" title={defaultChannel.provider}>
                  <DesktopProviderLogo provider={defaultChannel.provider} className="size-4" />
                  <span>{defaultChannel.modelId}</span>
                </Badge>
              ) : (
                <p className="text-sm text-muted-foreground">
                  未设置默认渠道，请在左侧切换到「渠道」进行配置。
                </p>
              )}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="默认允许联网搜索（Tavily）"
        description="用于 web_search / research 路由。只有在判断需要最新外部信息时才会触发。用户填写的 Tavily Key 优先级高于服务端全局 TAVILY_API_KEY。"
      >
        <SettingsCard divided={false} className="p-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">用户级 Tavily API Key</p>
                <p className="text-xs text-muted-foreground">
                  留空则回落到部署默认 Key；填写后仅当前账号生效。
                </p>
              </div>
              {!tavilyEnabled ? (
                <Badge variant="outline">已关闭</Badge>
              ) : savedTavilyApiKey ? (
                <Badge variant="secondary">用户覆盖中</Badge>
              ) : (
                <Badge variant="outline">使用服务端默认</Badge>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/60 p-3">
              <div>
                <p className="text-sm font-medium">启用 Tavily 搜索</p>
                <p className="text-xs text-muted-foreground">
                  关闭后将不会进行实时搜索，即使存在 API Key；开启后也只会在需要最新信息时联网。
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
                取消
              </Button>
              <Button
                onClick={() => void handleSaveTavilyApiKey()}
                disabled={savingTavilyApiKey || tavilyApiKey === savedTavilyApiKey}
              >
                {savingTavilyApiKey ? "保存中..." : "保存"}
              </Button>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="高级工具（MCP）"
        description="MCP 是 Agent 的附加工具层，用于私有数据源、执行器和自定义工作流，不是默认联网能力的前提。"
        action={
          <Button size="sm" onClick={() => setMcpModalOpen(true)}>
            <Plus size={16} /> 添加 MCP
          </Button>
        }
      >
        <SettingsCard divided={false} className="p-4">
          {mcpServers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {loading ? "正在加载..." : "暂无 MCP Server 配置。"}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {mcpServers.map((server) => (
                <div
                  key={server.id}
                  className="flex items-center justify-between rounded-xl border border-border/50 bg-background/60 p-3"
                >
                  <div>
                    <p className="text-sm font-medium">{server.name}</p>
                    <p className="text-xs text-muted-foreground">{server.type}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={server.isEnabled}
                      onCheckedChange={() => void handleToggleMcp(server)}
                      disabled={mcpBusyId === server.id}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => void handleDeleteMcp(server.id)}
                      disabled={mcpBusyId === server.id}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <Dialog open={mcpModalOpen} onOpenChange={setMcpModalOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>添加 MCP Server</DialogTitle>
            <DialogDescription className="sr-only">
              填写名称、类型和 JSON 配置，创建一个新的 MCP Server。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>名称</Label>
              <Input value={mcpName} onChange={(event) => setMcpName(event.target.value)} />
            </div>

            <div className="grid gap-1.5">
              <Label>类型</Label>
              <Input value={mcpType} onChange={(event) => setMcpType(event.target.value)} />
            </div>

            <div className="grid gap-1.5">
              <Label>配置 JSON</Label>
              <Textarea
                rows={12}
                className="font-mono text-sm"
                value={mcpConfig}
                onChange={(event) => setMcpConfig(event.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setMcpModalOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleCreateMcp()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
