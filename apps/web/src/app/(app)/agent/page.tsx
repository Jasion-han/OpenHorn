'use client';

import { useState, useEffect } from 'react';
import { Container, Grid, Paper, TextInput, Button, Stack, Text, Group, ScrollArea, Badge, Loader, Collapse, FileButton, Select } from '@mantine/core';
import { IconSend, IconPlus, IconRobot } from '@tabler/icons-react';
import { useAgentStore, type AgentEvent } from '@/stores/agentStore';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/lib/api';
import { readSseStream } from '@/lib/sse';
import { uploadAttachments } from '@/lib/attachments';
import { AppShellSlot } from '@/components/app/AppShellSlot';
import { notifyError, notifySuccess } from '@/lib/notify';

const DEFAULT_WORKSPACE_SETTING_KEY = 'agent.defaultWorkspaceId';

export default function AgentPage() {
  const { user } = useAuthStore();
  const {
    sessions,
    currentSession,
    events,
    isRunning,
    addSession,
    setSessions,
    setCurrentSession,
    addEvent,
    clearEvents,
    setIsRunning,
    workspaces,
    setWorkspaces,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
  } = useAgentStore();
  
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [taskInput, setTaskInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [bootstrapping, setBootstrapping] = useState(false);

  useEffect(() => {
    if (user) {
      void bootstrap();
    }
  }, [user]);

  const bootstrap = async () => {
    setBootstrapping(true);
    try {
      const [{ sessions }, { workspaces: workspacesResp }, { settings }] = await Promise.all([
        api.agent.listSessions(),
        api.workspaces.list(),
        api.settings.get([DEFAULT_WORKSPACE_SETTING_KEY]),
      ]);

      setSessions(sessions as never[]);
      setWorkspaces(workspacesResp as never[]);

      const defaultWorkspaceId = settings?.[DEFAULT_WORKSPACE_SETTING_KEY] || null;
      const exists = typeof defaultWorkspaceId === 'string'
        && (workspacesResp as any[]).some((ws: any) => ws?.id === defaultWorkspaceId);

      if (exists) {
        setSelectedWorkspaceId(defaultWorkspaceId);
        return;
      }

      const first = (workspacesResp as any[])[0]?.id as string | undefined;
      if (first) {
        setSelectedWorkspaceId(first);
        // Best-effort: keep server setting in sync.
        try {
          await api.settings.set(DEFAULT_WORKSPACE_SETTING_KEY, first);
        } catch {
          // Ignore; user can still switch manually.
        }
      }
    } catch (error) {
      notifyError('加载失败', error instanceof Error ? error.message : '无法加载 Agent 数据');
    } finally {
      setBootstrapping(false);
    }
  };

  const loadSessions = async () => {
    try {
      const { sessions } = await api.agent.listSessions();
      setSessions(sessions as never[]);
    } catch (error) {
      notifyError('刷新失败', error instanceof Error ? error.message : '无法刷新会话列表');
    }
  };

  const workspaceOptions = workspaces.map((ws) => ({ value: ws.id, label: ws.name }));
  const handleWorkspaceChange = async (nextId: string | null) => {
    const prev = selectedWorkspaceId;
    setSelectedWorkspaceId(nextId);
    try {
      await api.settings.set(DEFAULT_WORKSPACE_SETTING_KEY, nextId);
      notifySuccess('已保存', '默认 Workspace 已更新');
    } catch (error) {
      setSelectedWorkspaceId(prev);
      notifyError('保存失败', error instanceof Error ? error.message : '无法保存默认 Workspace');
    }
  };

  const handleNewSession = async () => {
    if (!newSessionTitle.trim()) return;
    
    try {
      const { session } = await api.agent.createSession({
        title: newSessionTitle.trim(),
        workspaceId: selectedWorkspaceId || undefined,
      });
      addSession(session as never);
      setCurrentSession(session as never);
      setNewSessionTitle('');
      await loadSessions();
    } catch (error) {
      notifyError('创建失败', error instanceof Error ? error.message : '无法创建会话');
    }
  };

  const handleRun = async () => {
    const hasInput = taskInput.trim().length > 0;
    const hasFiles = files.length > 0;
    if ((!hasInput && !hasFiles) || !currentSession || isRunning) return;

    const hasWorkspace = Boolean(selectedWorkspaceId || currentSession.workspaceId);
    if (!hasWorkspace) return;
    
    setIsRunning(true);
    clearEvents();
    
    try {
      let attachmentIds: string[] = [];
      if (files.length > 0) {
        const upload = await uploadAttachments({
          sessionId: currentSession.id,
          files,
        });
        attachmentIds = upload.attachments.map((attachment) => attachment.id);
        setFiles([]);
      }

      const prompt = taskInput.trim();
      setTaskInput('');
      const response = await api.agent.runSession(currentSession.id, prompt, attachmentIds);
      
      if (!response.ok) {
        throw new Error('Failed to run agent');
      }
      
      await readSseStream(response, (event) => {
        addEvent(event as AgentEvent);
      });
    } catch (error) {
      addEvent({ 
        type: 'error', 
        content: error instanceof Error ? error.message : 'Error running agent' 
      });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <>
      <AppShellSlot title="Agent" />
      <Container fluid p={0} style={{ flex: 1, minHeight: 0 }}>
      <Grid gutter={0} style={{ height: '100%' }}>
        <Grid.Col span={{ base: 12, md: 3 }} style={{ height: '100%' }}>
          <Paper
            style={{ height: '100%', borderRight: '1px solid var(--mantine-color-gray-3)' }}
            p="md"
          >
            <Stack h="100%">
              <Text fw={500}>Agent Sessions</Text>
              
              <TextInput
                placeholder="New task..."
                value={newSessionTitle}
                onChange={(e) => setNewSessionTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleNewSession()}
                rightSection={
                  <Button size="xs" variant="light" onClick={handleNewSession}>
                    <IconPlus size={16} />
                  </Button>
                }
              />
              
              <ScrollArea flex={1}>
                <Stack gap="xs">
                  {sessions.map((session) => (
                    <Paper
                      key={session.id}
                      p="sm"
                      radius="sm"
                      withBorder={currentSession?.id === session.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setCurrentSession(session as never)}
                    >
                      <Group>
                        <IconRobot size={16} />
                        <Text size="sm" truncate style={{ flex: 1 }}>
                          {session.title}
                        </Text>
                        <Badge size="xs" variant="light">
                          {session.status}
                        </Badge>
                      </Group>
                    </Paper>
                  ))}
                  
              {sessions.length === 0 && (
                <Text size="sm" c="dimmed" ta="center" py="xl">
                  No sessions yet
                </Text>
              )}
            </Stack>
          </ScrollArea>
        </Stack>
      </Paper>
    </Grid.Col>
    
    <Grid.Col span={{ base: 12, md: 9 }} style={{ height: '100%' }}>
      <Paper style={{ height: '100%' }} p="md">
        <Stack h="100%">
          <Group justify="space-between">
            <Text fw={500}>
              {currentSession ? currentSession.title : 'Select a session'}
            </Text>
            <Group gap="xs">
              {(isRunning || bootstrapping) && <Loader size="sm" />}
              <Button size="xs" variant="light" onClick={() => void loadSessions()}>
                Refresh
              </Button>
            </Group>
          </Group>

          <Group justify="space-between" wrap="nowrap">
            <Select
              data={workspaceOptions}
              value={selectedWorkspaceId}
              onChange={(value) => void handleWorkspaceChange(value || null)}
              placeholder={workspaces.length === 0 ? 'No workspaces' : 'Select workspace'}
              disabled={workspaces.length === 0}
              style={{ flex: 1 }}
            />
            <Button component="a" href="/settings" variant="light">
              Workspaces
            </Button>
          </Group>

          {workspaces.length === 0 && (
            <Text size="sm" c="dimmed">
              需要先创建 Workspace 才能运行 Agent。
            </Text>
          )}
              
              <ScrollArea flex={1}>
                <Stack gap="sm">
                  {events.map((event, index) => (
                    <AgentEventCard key={index} event={event} />
                  ))}
                  
                  {events.length === 0 && currentSession && (
                    <Text c="dimmed" ta="center" py="xl">
                      Enter a task to run the agent
                    </Text>
                  )}
                </Stack>
              </ScrollArea>
              
              <Paper withBorder p="sm" radius="md">
                <Stack gap="xs">
                  {files.length > 0 && (
                    <Stack gap={4}>
                      {files.map((file) => (
                        <Group key={`${file.name}-${file.size}`} gap="xs">
                          <Text size="xs" c="dimmed">{file.name}</Text>
                          <Button
                            size="xs"
                            variant="subtle"
                            color="red"
                            onClick={() => setFiles((prev) => prev.filter((f) => f !== file))}
                          >
                            Remove
                          </Button>
                        </Group>
                      ))}
                    </Stack>
                  )}
                  <Group>
                    <TextInput
                      placeholder="Describe what you want the agent to do..."
                      value={taskInput}
                      onChange={(e) => setTaskInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleRun();
                        }
                      }}
                      style={{ flex: 1 }}
                      disabled={!currentSession || isRunning || workspaces.length === 0}
                    />
                    <FileButton
                      onChange={(selected) => {
                        if (!selected) return;
                        const list = Array.isArray(selected) ? selected : [selected];
                        setFiles((prev) => [...prev, ...list]);
                      }}
                      accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown"
                      multiple
                    >
                      {(props) => (
                        <Button variant="light" {...props} disabled={!currentSession || isRunning || workspaces.length === 0}>
                          Attach
                        </Button>
                      )}
                    </FileButton>
                    <Button
                      onClick={handleRun}
                      loading={isRunning}
                      disabled={!currentSession || (!taskInput.trim() && files.length === 0) || workspaces.length === 0}
                    >
                      <IconSend size={18} />
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
      </Container>
    </>
  );
}

function AgentEventCard({ event }: { event: AgentEvent }) {
  const [open, setOpen] = useState(false);

  const background = event.type === 'error'
    ? 'red.0'
    : event.type === 'tool_start'
      ? 'blue.0'
      : event.type === 'tool_result'
        ? 'green.0'
        : 'gray.0';

  if (event.type === 'text') {
    return (
      <Paper p="sm" radius="md" bg={background}>
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {event.content}
        </Text>
      </Paper>
    );
  }

  if (event.type === 'tool_start') {
    return (
      <Paper p="sm" radius="md" bg={background}>
        <Group justify="space-between" align="center">
          <Group gap="xs">
            <Badge size="sm" color="blue">Tool</Badge>
            <Text size="sm">{event.toolName || 'Unknown tool'}</Text>
          </Group>
          <Button size="xs" variant="subtle" onClick={() => setOpen((value) => !value)}>
            {open ? 'Hide Input' : 'Show Input'}
          </Button>
        </Group>
        <Collapse in={open}>
          <Paper withBorder p="xs" mt="xs">
            <Text size="xs" c="dimmed">Input</Text>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(event.toolInput ?? {}, null, 2)}
            </pre>
          </Paper>
        </Collapse>
      </Paper>
    );
  }

  if (event.type === 'tool_result') {
    return (
      <Paper p="sm" radius="md" bg={background}>
        <Group justify="space-between" align="center">
          <Badge size="sm" color="green">Result</Badge>
          <Button size="xs" variant="subtle" onClick={() => setOpen((value) => !value)}>
            {open ? 'Hide Output' : 'Show Output'}
          </Button>
        </Group>
        <Collapse in={open}>
          <Paper withBorder p="xs" mt="xs">
            <Text size="xs" c="dimmed">Output</Text>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {typeof event.content === 'string'
                ? event.content
                : JSON.stringify(event.content ?? {}, null, 2)}
            </pre>
          </Paper>
        </Collapse>
      </Paper>
    );
  }

  if (event.type === 'error') {
    return (
      <Paper p="sm" radius="md" bg={background}>
        <Text size="sm" c="red">{event.content}</Text>
      </Paper>
    );
  }

  return (
    <Paper p="sm" radius="md" bg={background}>
      <Badge color="green">Done</Badge>
    </Paper>
  );
}
