'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Button,
  Card,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Badge,
  Switch,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { api, type ApiChannel } from '../../lib/api';
import { useAgentStore } from '../../stores/agentStore';
import { getGlobalDefaultChannel } from '../../lib/default-channel';

type MCPServer = {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
};

type Workspace = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  cwd?: string;
};

export function AgentSettings() {
  const { selectedWorkspaceId, setSelectedWorkspaceId } = useAgentStore();
  const [channels, setChannels] = useState<ApiChannel[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(false);

  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceSlug, setWorkspaceSlug] = useState('');
  const [workspaceDesc, setWorkspaceDesc] = useState('');
  const [workspaceCwd, setWorkspaceCwd] = useState('');

  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpType, setMcpType] = useState('stdio');
  const [mcpConfig, setMcpConfig] = useState('{\n  \n}');
  const [mcpBusyId, setMcpBusyId] = useState<string | null>(null);

  const defaultChannel = useMemo(() => getGlobalDefaultChannel(channels), [channels]);

  useEffect(() => {
    void loadAll();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [{ channels }, { workspaces }, { servers }] = await Promise.all([
        api.channels.list(),
        api.workspaces.list(),
        api.mcp.listServers(),
      ]);
      setChannels(channels);
      setWorkspaces(workspaces as Workspace[]);
      setMcpServers(servers as MCPServer[]);

      const typedWorkspaces = workspaces as Workspace[];
      if (!selectedWorkspaceId && typedWorkspaces.length > 0) {
        setSelectedWorkspaceId(typedWorkspaces[0].id);
      }
    } catch (error) {
      console.error('Failed to load agent settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const workspaceOptions = useMemo(
    () => workspaces.map((ws) => ({ value: ws.id, label: ws.name })),
    [workspaces]
  );

  const selectedWorkspace = workspaces.find((ws) => ws.id === selectedWorkspaceId) || null;

  const handleCreateWorkspace = async () => {
    if (!workspaceName.trim()) return;
    setLoading(true);
    try {
      await api.workspaces.create({
        name: workspaceName.trim(),
        slug: workspaceSlug.trim() || undefined,
        description: workspaceDesc.trim() || undefined,
        cwd: workspaceCwd.trim() || undefined,
      });
      setWorkspaceModalOpen(false);
      setWorkspaceName('');
      setWorkspaceSlug('');
      setWorkspaceDesc('');
      setWorkspaceCwd('');
      await loadAll();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to create workspace');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteWorkspace = async (id: string) => {
    setLoading(true);
    try {
      await api.workspaces.delete(id);
      if (selectedWorkspaceId === id) {
        setSelectedWorkspaceId(null);
      }
      await loadAll();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to delete workspace');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateWorkspace = async () => {
    if (!selectedWorkspace) return;
    setLoading(true);
    try {
      await api.workspaces.update(selectedWorkspace.id, {
        name: selectedWorkspace.name,
        description: selectedWorkspace.description,
        cwd: selectedWorkspace.cwd,
      });
      await loadAll();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to update workspace');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateMcp = async () => {
    if (!mcpName.trim()) return;
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(mcpConfig);
    } catch (error) {
      alert('MCP config must be valid JSON');
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
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to create MCP server');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteMcp = async (id: string) => {
    setMcpBusyId(id);
    try {
      await api.mcp.deleteServer(id);
      await loadAll();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to delete MCP server');
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
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to update MCP server');
    } finally {
      setMcpBusyId(null);
    }
  };

  return (
    <Stack gap="md">
      <Card withBorder>
        <Group justify="space-between">
          <div>
            <Text fw={600}>Default Agent Channel</Text>
            <Text size="sm" c="dimmed">
              Agent uses the global default channel and model configured in Channels.
            </Text>
          </div>
          {defaultChannel ? (
            <Badge variant="light">{defaultChannel.label}</Badge>
          ) : (
            <Button component="a" href="/settings" variant="light" size="xs">
              Go to Channels
            </Button>
          )}
        </Group>
      </Card>

      <Card withBorder>
        <Group justify="space-between" mb="sm">
          <div>
            <Text fw={600}>Workspaces</Text>
            <Text size="sm" c="dimmed">Select a workspace to provide Agent cwd.</Text>
          </div>
          <Button leftSection={<IconPlus size={16} />} onClick={() => setWorkspaceModalOpen(true)}>
            New Workspace
          </Button>
        </Group>

        {workspaces.length === 0 ? (
          <Text c="dimmed">No workspaces yet. Create one to run Agent tasks.</Text>
        ) : (
          <Stack gap="sm">
            <Select
              data={workspaceOptions}
              value={selectedWorkspaceId}
              onChange={(value) => setSelectedWorkspaceId(value || null)}
              placeholder="Select workspace"
            />

            {selectedWorkspace && (
              <Card withBorder>
                <Stack gap="sm">
                  <TextInput
                    label="Name"
                    value={selectedWorkspace.name}
                    onChange={(event) => {
                      const value = event.target.value;
                      setWorkspaces((prev) =>
                        prev.map((ws) => (ws.id === selectedWorkspace.id ? { ...ws, name: value } : ws))
                      );
                    }}
                  />
                  <TextInput
                    label="CWD"
                    placeholder="/Users/han/Project/OpenHorn"
                    value={selectedWorkspace.cwd || ''}
                    onChange={(event) => {
                      const value = event.target.value;
                      setWorkspaces((prev) =>
                        prev.map((ws) => (ws.id === selectedWorkspace.id ? { ...ws, cwd: value } : ws))
                      );
                    }}
                  />
                  <TextInput
                    label="Description"
                    value={selectedWorkspace.description || ''}
                    onChange={(event) => {
                      const value = event.target.value;
                      setWorkspaces((prev) =>
                        prev.map((ws) => (ws.id === selectedWorkspace.id ? { ...ws, description: value } : ws))
                      );
                    }}
                  />
                  <Group justify="space-between">
                    <Button variant="light" onClick={handleUpdateWorkspace} loading={loading}>
                      Save Workspace
                    </Button>
                    <ActionIcon color="red" onClick={() => handleDeleteWorkspace(selectedWorkspace.id)}>
                      <IconTrash size={18} />
                    </ActionIcon>
                  </Group>
                </Stack>
              </Card>
            )}
          </Stack>
        )}
      </Card>

      <Card withBorder>
        <Group justify="space-between" mb="sm">
          <div>
            <Text fw={600}>MCP Servers</Text>
            <Text size="sm" c="dimmed">Global MCP server configuration for Agent tools.</Text>
          </div>
          <Button leftSection={<IconPlus size={16} />} onClick={() => setMcpModalOpen(true)}>
            Add MCP Server
          </Button>
        </Group>

        {mcpServers.length === 0 ? (
          <Text c="dimmed">No MCP servers configured.</Text>
        ) : (
          <Stack gap="sm">
            {mcpServers.map((server) => (
              <Card key={server.id} withBorder>
                <Group justify="space-between">
                  <div>
                    <Text fw={500}>{server.name}</Text>
                    <Text size="sm" c="dimmed">{server.type}</Text>
                  </div>
                  <Group gap="xs">
                    <Switch
                      checked={server.isEnabled}
                      onChange={() => handleToggleMcp(server)}
                      disabled={mcpBusyId === server.id}
                    />
                    <ActionIcon
                      color="red"
                      onClick={() => handleDeleteMcp(server.id)}
                      loading={mcpBusyId === server.id}
                    >
                      <IconTrash size={18} />
                    </ActionIcon>
                  </Group>
                </Group>
              </Card>
            ))}
          </Stack>
        )}
      </Card>

      <Modal opened={workspaceModalOpen} onClose={() => setWorkspaceModalOpen(false)} title="New Workspace">
        <Stack gap="md">
          <TextInput
            label="Name"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            required
          />
          <TextInput
            label="Slug (optional)"
            value={workspaceSlug}
            onChange={(event) => setWorkspaceSlug(event.target.value)}
          />
          <TextInput
            label="CWD"
            value={workspaceCwd}
            onChange={(event) => setWorkspaceCwd(event.target.value)}
          />
          <Textarea
            label="Description"
            value={workspaceDesc}
            onChange={(event) => setWorkspaceDesc(event.target.value)}
          />
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setWorkspaceModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateWorkspace} loading={loading}>
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={mcpModalOpen} onClose={() => setMcpModalOpen(false)} title="Add MCP Server">
        <Stack gap="md">
          <TextInput
            label="Name"
            value={mcpName}
            onChange={(event) => setMcpName(event.target.value)}
            required
          />
          <TextInput
            label="Type"
            value={mcpType}
            onChange={(event) => setMcpType(event.target.value)}
          />
          <Textarea
            label="Config (JSON)"
            value={mcpConfig}
            onChange={(event) => setMcpConfig(event.target.value)}
            minRows={6}
          />
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setMcpModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateMcp} loading={loading}>
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
