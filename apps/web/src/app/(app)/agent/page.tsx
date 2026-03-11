'use client';

import { useState, useEffect } from 'react';
import { Container, Grid, Paper, TextInput, Button, Stack, Text, Group, ScrollArea, Badge, Loader, Collapse, FileButton } from '@mantine/core';
import { IconSend, IconPlus, IconRobot } from '@tabler/icons-react';
import { useAgentStore, type AgentEvent } from '@/stores/agentStore';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/lib/api';
import { readSseStream } from '@/lib/sse';
import { uploadAttachments } from '@/lib/attachments';
import { AppShellSlot } from '@/components/app/AppShellSlot';

export default function AgentPage() {
  const { user } = useAuthStore();
  const {
    sessions,
    currentSession,
    events,
    isRunning,
    addSession,
    setCurrentSession,
    addEvent,
    clearEvents,
    setIsRunning,
    selectedWorkspaceId,
  } = useAgentStore();
  
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sessionsList, setSessionsList] = useState<typeof sessions>([]);

  useEffect(() => {
    if (user) {
      loadSessions();
    }
  }, [user]);

  const loadSessions = async () => {
    try {
      const { sessions: s } = await api.agent.listSessions();
      setSessionsList(s as never[]);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  };

  const handleNewSession = async () => {
    if (!input.trim()) return;
    
    try {
      const { session } = await api.agent.createSession({
        title: input.trim(),
        workspaceId: selectedWorkspaceId || undefined,
      });
      addSession(session as never);
      setCurrentSession(session as never);
      setInput('');
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  const handleRun = async () => {
    const hasInput = input.trim().length > 0;
    const hasFiles = files.length > 0;
    if ((!hasInput && !hasFiles) || !currentSession || isRunning || !selectedWorkspaceId) return;
    
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

      const response = await api.agent.runSession(currentSession.id, input.trim(), attachmentIds);
      
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
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleNewSession()}
                rightSection={
                  <Button size="xs" variant="light" onClick={handleNewSession}>
                    <IconPlus size={16} />
                  </Button>
                }
              />
              
              <ScrollArea flex={1}>
                <Stack gap="xs">
                  {sessionsList.map((session) => (
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
                  
              {sessionsList.length === 0 && (
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
            {isRunning && <Loader size="sm" />}
          </Group>
          {!selectedWorkspaceId && (
            <Text size="sm" c="dimmed">
              Select a workspace in Settings &gt; Agent to run tasks.
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
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleRun();
                        }
                      }}
                      style={{ flex: 1 }}
                      disabled={!currentSession || isRunning || !selectedWorkspaceId}
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
                        <Button variant="light" {...props} disabled={!currentSession || isRunning || !selectedWorkspaceId}>
                          Attach
                        </Button>
                      )}
                    </FileButton>
                    <Button
                      onClick={handleRun}
                      loading={isRunning}
                      disabled={!currentSession || (!input.trim() && files.length === 0) || !selectedWorkspaceId}
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
