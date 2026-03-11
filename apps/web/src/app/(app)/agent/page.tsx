'use client';

import { useState, useEffect } from 'react';
import { Paper, TextInput, Button, Stack, Text, Group, ScrollArea, Badge, Loader, FileButton, Select, ActionIcon, Menu } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconCheck, IconDots, IconPencil, IconSend, IconPlus, IconRobot, IconTrash } from '@tabler/icons-react';
import { useAgentStore, type AgentEvent } from '@/stores/agentStore';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/lib/api';
import { readSseStream } from '@/lib/sse';
import { uploadAttachments } from '@/lib/attachments';
import { AppShellSlot } from '@/components/app/AppShellSlot';
import { notifyError, notifySuccess } from '@/lib/notify';
import { DEFAULT_WORKSPACE_SETTING_KEY, pickDefaultWorkspaceId } from '@/lib/agent-default-workspace';
import { AgentEventCard } from '@/components/agent/AgentEventCard';

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

      const picked = pickDefaultWorkspaceId(workspacesResp as any[], settings?.[DEFAULT_WORKSPACE_SETTING_KEY] || null);
      if (picked) {
        setSelectedWorkspaceId(picked);
        if (picked !== (settings?.[DEFAULT_WORKSPACE_SETTING_KEY] || null)) {
          try {
            await api.settings.set(DEFAULT_WORKSPACE_SETTING_KEY, picked);
          } catch {
            // Ignore; user can still switch manually.
          }
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

  const handleRenameSession = (session: any) => {
    let value = session.title || '';
    modals.openConfirmModal({
      title: '重命名会话',
      children: (
        <TextInput
          label="标题"
          defaultValue={session.title || ''}
          onChange={(e) => {
            value = e.target.value;
          }}
        />
      ),
      labels: { confirm: '保存', cancel: '取消' },
      onConfirm: () => {
        const nextTitle = value.trim();
        if (!nextTitle) return;
        void (async () => {
          try {
            await api.agent.renameSession(session.id, nextTitle);
            setSessions(sessions.map((s) => (s.id === session.id ? { ...s, title: nextTitle } : s)) as never[]);
            if (currentSession?.id === session.id) {
              setCurrentSession({ ...(currentSession as any), title: nextTitle } as never);
            }
            notifySuccess('已保存', '会话已重命名');
          } catch (error) {
            notifyError('保存失败', error instanceof Error ? error.message : '无法重命名会话');
            await loadSessions();
          }
        })();
      },
    });
  };

  const handleToggleCompleted = async (session: any) => {
    const next = session.status === 'completed' ? 'active' : 'completed';
    try {
      await api.agent.updateStatus(session.id, next);
      setSessions(sessions.map((s) => (s.id === session.id ? { ...s, status: next } : s)) as never[]);
      if (currentSession?.id === session.id) {
        setCurrentSession({ ...(currentSession as any), status: next } as never);
      }
      notifySuccess('已更新', next === 'completed' ? '已标记完成' : '已恢复为进行中');
    } catch (error) {
      notifyError('更新失败', error instanceof Error ? error.message : '无法更新状态');
      await loadSessions();
    }
  };

  const handleDeleteSession = (session: any) => {
    modals.openConfirmModal({
      title: '删除会话',
      children: <Text size="sm">确定删除该会话？此操作不可恢复。</Text>,
      labels: { confirm: '删除', cancel: '取消' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void (async () => {
          try {
            await api.agent.deleteSession(session.id);
            setSessions(sessions.filter((s) => s.id !== session.id) as never[]);
            if (currentSession?.id === session.id) {
              setCurrentSession(null);
            }
            notifySuccess('已删除', '会话已删除');
          } catch (error) {
            notifyError('删除失败', error instanceof Error ? error.message : '无法删除会话');
            await loadSessions();
          }
        })();
      },
    });
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
      <AppShellSlot
        title="Agent"
        aside={
          <Stack h="100%" gap="sm">
            <Group justify="space-between" wrap="nowrap">
              <Text fw={600}>会话</Text>
              {(bootstrapping || isRunning) && <Loader size="xs" />}
            </Group>

            <TextInput
              placeholder="新建会话标题..."
              value={newSessionTitle}
              onChange={(e) => setNewSessionTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleNewSession()}
              rightSection={
                <Button size="xs" variant="light" onClick={handleNewSession}>
                  <IconPlus size={16} />
                </Button>
              }
            />

            <ScrollArea style={{ flex: 1 }}>
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
                    <Group justify="space-between" wrap="nowrap" style={{ alignItems: 'center' }}>
                      <IconRobot size={16} />
                      <Text
                        size="sm"
                        truncate
                        style={{ flex: 1, minWidth: 0 }}
                      >
                        {session.title}
                      </Text>
                      <Group gap="xs" wrap="nowrap" style={{ minWidth: 'fit-content' }}>
                        <Badge size="xs" variant="light">
                          {session.status === 'active' ? '进行中' : session.status === 'completed' ? '已完成' : '已取消'}
                        </Badge>
                        <Menu withinPortal position="bottom-end" shadow="md">
                          <Menu.Target>
                            <ActionIcon
                              variant="subtle"
                              aria-label="会话操作"
                              onClick={(e) => {
                                e.stopPropagation();
                              }}
                            >
                              <IconDots size={16} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item
                              leftSection={<IconPencil size={14} />}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRenameSession(session);
                              }}
                            >
                              重命名
                            </Menu.Item>
                            <Menu.Item
                              leftSection={<IconCheck size={14} />}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleToggleCompleted(session);
                              }}
                            >
                              {session.status === 'completed' ? '恢复进行中' : '标记完成'}
                            </Menu.Item>
                            <Menu.Divider />
                            <Menu.Item
                              color="red"
                              leftSection={<IconTrash size={14} />}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteSession(session);
                              }}
                            >
                              删除
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Group>
                    </Group>
                  </Paper>
                ))}

                {sessions.length === 0 && (
                  <Text size="sm" c="dimmed" ta="center" py="xl">
                    还没有会话
                  </Text>
                )}
              </Stack>
            </ScrollArea>
          </Stack>
        }
      />

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Paper style={{ flex: 1, minHeight: 0 }} p="md" radius="md" withBorder>
          <Stack h="100%" gap="sm">
            <Group justify="space-between" wrap="nowrap">
              <Text fw={600} truncate style={{ minWidth: 0, flex: 1 }}>
                {currentSession ? currentSession.title : '请选择一个会话'}
              </Text>
              <Group gap="xs" wrap="nowrap">
                {(isRunning || bootstrapping) && <Loader size="sm" />}
                <Button size="xs" variant="light" onClick={() => void loadSessions()}>
                  刷新
                </Button>
              </Group>
            </Group>

            <Group justify="space-between" wrap="nowrap">
              <Select
                data={workspaceOptions}
                value={selectedWorkspaceId}
                onChange={(value) => void handleWorkspaceChange(value || null)}
                placeholder={workspaces.length === 0 ? '没有 Workspace' : '选择默认 Workspace'}
                disabled={workspaces.length === 0}
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button component="a" href="/settings" variant="light">
                管理
              </Button>
            </Group>

            {workspaces.length === 0 && (
              <Text size="sm" c="dimmed">
                需要先创建 Workspace 才能运行 Agent。
              </Text>
            )}

            {!currentSession && (
              <Text c="dimmed" ta="center" py="xl">
                在左侧选择或创建会话，然后在底部输入任务开始运行。
              </Text>
            )}

            {currentSession && (
              <>
                <ScrollArea style={{ flex: 1 }}>
                  <Stack gap="sm">
                    {events.map((event, index) => (
                      <AgentEventCard key={index} event={event} />
                    ))}

                    {events.length === 0 && (
                      <Text c="dimmed" ta="center" py="xl">
                        在底部输入任务并运行
                      </Text>
                    )}
                  </Stack>
                </ScrollArea>

                <Paper withBorder p="sm" radius="md">
                  <Stack gap="xs">
                    {files.length > 0 && (
                      <Stack gap={4}>
                        {files.map((file) => (
                          <Group key={`${file.name}-${file.size}`} gap="xs" wrap="nowrap">
                            <Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
                              {file.name}
                            </Text>
                            <Button
                              size="xs"
                              variant="subtle"
                              color="red"
                              onClick={() => setFiles((prev) => prev.filter((f) => f !== file))}
                            >
                              移除
                            </Button>
                          </Group>
                        ))}
                      </Stack>
                    )}
                    <Group wrap="nowrap">
                      <TextInput
                        placeholder="描述你希望 Agent 做什么..."
                        value={taskInput}
                        onChange={(e) => setTaskInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleRun();
                          }
                        }}
                        style={{ flex: 1, minWidth: 0 }}
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
                            附件
                          </Button>
                        )}
                      </FileButton>
                      <Button
                        onClick={handleRun}
                        loading={isRunning}
                        disabled={!currentSession || (!taskInput.trim() && files.length === 0) || workspaces.length === 0}
                        aria-label="运行"
                      >
                        <IconSend size={18} />
                      </Button>
                    </Group>
                  </Stack>
                </Paper>
              </>
            )}
          </Stack>
        </Paper>
      </div>
    </>
  );
}
