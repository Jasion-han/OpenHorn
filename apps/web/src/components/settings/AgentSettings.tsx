'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, type ApiChannel } from '../../lib/api';
import { getGlobalDefaultChannel } from '../../lib/default-channel';
import { notifyError, notifySuccess } from '../../lib/notify';
import { BACKEND_UP_EVENT } from '../../stores/backendStatusStore';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Badge } from '../ui/badge';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { SettingsCard, SettingsSection } from 'ui';

type MCPServer = {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
};

export function AgentSettings() {
  const [channels, setChannels] = useState<ApiChannel[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(false);

  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpType, setMcpType] = useState('stdio');
  const [mcpConfig, setMcpConfig] = useState('{\n  \n}');
  const [mcpBusyId, setMcpBusyId] = useState<string | null>(null);

  const defaultChannel = useMemo(() => getGlobalDefaultChannel(channels), [channels]);

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    const onUp = () => {
      void loadAll();
    };
    window.addEventListener(BACKEND_UP_EVENT, onUp);
    return () => {
      window.removeEventListener(BACKEND_UP_EVENT, onUp);
    };
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [{ channels }, { servers }] = await Promise.all([
        api.channels.list(),
        api.mcp.listServers(),
      ]);
      setChannels(channels);
      setMcpServers(servers as MCPServer[]);
    } catch (error) {
      console.error('Failed to load agent settings:', error);
      notifyError('加载失败', error instanceof Error ? error.message : '无法加载 Agent 设置');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateMcp = async () => {
    if (!mcpName.trim()) return;
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(mcpConfig);
    } catch {
      notifyError('配置错误', 'MCP config 必须是合法 JSON');
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
      setMcpName('');
      setMcpType('stdio');
      setMcpConfig('{\n  \n}');
      await loadAll();
      notifySuccess('已创建', 'MCP Server 已添加');
    } catch (error) {
      notifyError('创建失败', error instanceof Error ? error.message : 'Failed to create MCP server');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteMcp = async (id: string) => {
    setMcpBusyId(id);
    try {
      await api.mcp.deleteServer(id);
      await loadAll();
      notifySuccess('已删除', 'MCP Server 已删除');
    } catch (error) {
      notifyError('删除失败', error instanceof Error ? error.message : 'Failed to delete MCP server');
    } finally {
      setMcpBusyId(null);
    }
  };

  const handleToggleMcp = async (server: MCPServer) => {
    setMcpBusyId(server.id);
    try {
      await api.mcp.updateServer(server.id, {
        isEnabled: !server.isEnabled,
      });
      await loadAll();
      notifySuccess('已更新', 'MCP Server 状态已更新');
    } catch (error) {
      notifyError('更新失败', error instanceof Error ? error.message : 'Failed to update MCP server');
    } finally {
      setMcpBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="默认渠道"
        description="Agent 使用「渠道」中配置的全局默认渠道与模型。"
      >
        <SettingsCard divided={false} className="p-4">
          <div className="flex items-center justify-between">
            {defaultChannel ? (
              <Badge variant="secondary">{defaultChannel.label}</Badge>
            ) : (
              <p className="text-sm text-muted-foreground">
                未设置默认渠道，请在左侧切换到「渠道」进行配置。
              </p>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="MCP 服务"
        description="Agent 工具使用的全局 MCP Server 配置。"
        action={(
          <Button size="sm" onClick={() => setMcpModalOpen(true)}>
            <Plus size={16} /> 添加 MCP
          </Button>
        )}
      >
        <SettingsCard divided={false} className="p-4">
          {mcpServers.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无 MCP Server 配置。</p>
          ) : (
            <div className="flex flex-col gap-2">
              {mcpServers.map((server) => (
                <div key={server.id} className="flex items-center justify-between rounded-xl border border-border/50 bg-background/60 p-3">
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
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      onClick={() => void handleDeleteMcp(server.id)}
                      disabled={mcpBusyId === server.id}
                    >
                      <Trash2 size={18} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <Dialog open={mcpModalOpen} onOpenChange={(open) => !open && setMcpModalOpen(false)}>
        <DialogContent>
          <DialogHeader><DialogTitle>添加 MCP Server</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>名称 *</Label>
              <Input value={mcpName} onChange={(e) => setMcpName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>类型</Label>
              <Input value={mcpType} onChange={(e) => setMcpType(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>配置（JSON）</Label>
              <Textarea value={mcpConfig} onChange={(e) => setMcpConfig(e.target.value)} rows={6} className="font-mono text-sm" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMcpModalOpen(false)}>取消</Button>
            <Button onClick={handleCreateMcp} disabled={loading}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
