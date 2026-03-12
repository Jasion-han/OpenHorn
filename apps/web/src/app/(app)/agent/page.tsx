'use client';

import { useCallback, useState, useEffect, useRef, useMemo } from 'react';
import { Paper, TextInput, Button, Stack, Text, Group, ScrollArea, Badge, FileButton, ActionIcon, Menu, Alert, Textarea } from '@mantine/core';
import { modals } from '@mantine/modals';
import Link from 'next/link';
import { IconCheck, IconDots, IconPencil, IconSend, IconPlus, IconRobot, IconTrash, IconSettings, IconBriefcase, IconPlayerStop } from '@tabler/icons-react';
import { useAgentStore, type AgentEvent } from '@/stores/agentStore';
import { useAuthStore } from '@/stores/authStore';
import { api, type ApiChannel } from '@/lib/api';
import { readSseStream } from '@/lib/sse';
import { uploadAttachments } from '@/lib/attachments';
import { AppShellSlot } from '@/components/app/AppShellSlot';
import { notifyError, notifySuccess } from '@/lib/notify';
import { DEFAULT_WORKSPACE_SETTING_KEY, pickDefaultWorkspaceId } from '@/lib/agent-default-workspace';
import { AgentEventCard } from '@/components/agent/AgentEventCard';
import { BACKEND_UP_EVENT } from '@/stores/backendStatusStore';
import { getGlobalDefaultChannel } from '@/lib/default-channel';
import { buildSettingsLink } from '@/lib/settings-link';

const PAGE_PAD = 'var(--mantine-spacing-md)';
const COMPOSER_PAD_BOTTOM = 'env(safe-area-inset-bottom, 0px)';

function formatNewAgentSessionTitle() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `任务 ${mm}-${dd} ${hh}:${min}`;
}

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
  
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [taskInput, setTaskInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [channels, setChannels] = useState<ApiChannel[]>([]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const runAbortRef = useRef<AbortController | null>(null);
  const didCancelRef = useRef(false);

  const bootstrap = useCallback(async () => {
    setBootstrapping(true);
    try {
      const [{ sessions }, { workspaces: workspacesResp }, { settings }, { channels: channelsResp }] = await Promise.all([
        api.agent.listSessions(),
        api.workspaces.list(),
        api.settings.get([DEFAULT_WORKSPACE_SETTING_KEY]),
        api.channels.list(),
      ]);

      setSessions(sessions as never[]);
      setWorkspaces(workspacesResp as never[]);
      setChannels(channelsResp);

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
  }, [setSelectedWorkspaceId, setSessions, setWorkspaces]);

  useEffect(() => {
    if (user) {
      void bootstrap();
    }
  }, [bootstrap, user]);

  useEffect(() => {
    if (!user) return;
    const onUp = () => {
      void bootstrap();
    };
    window.addEventListener(BACKEND_UP_EVENT, onUp);
    return () => {
      window.removeEventListener(BACKEND_UP_EVENT, onUp);
    };
  }, [bootstrap, user]);

  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTo({ top: viewportRef.current.scrollHeight });
    }
  }, [events]);

  const loadSessions = async () => {
    try {
      const { sessions } = await api.agent.listSessions();
      setSessions(sessions as never[]);
    } catch (error) {
      notifyError('刷新失败', error instanceof Error ? error.message : '无法刷新会话列表');
    }
  };

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
    setCreating(true);
    try {
      const { session } = await api.agent.createSession({
        title: formatNewAgentSessionTitle(),
      });
      addSession(session as never);
      setCurrentSession(session as never);
      await loadSessions();
      notifySuccess('已创建', '新会话已创建');
    } catch (error) {
      notifyError('创建失败', error instanceof Error ? error.message : '无法创建会话');
    } finally {
      setCreating(false);
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

    if (!defaultChannel) {
      notifyError('无法运行', '未配置可用的默认渠道/默认模型，请先在设置中完成配置。');
      return;
    }

    const hasWorkspace = Boolean(selectedWorkspaceId || currentSession.workspaceId);
    if (!hasWorkspace) {
      notifyError('无法运行', '请先选择默认 Workspace');
      return;
    }

    // Abort any previous run request (best-effort).
    try {
      runAbortRef.current?.abort();
    } catch {
      // ignore
    }
    const abortController = new AbortController();
    runAbortRef.current = abortController;
    didCancelRef.current = false;
    
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
    queueMicrotask(() => inputRef.current?.focus());
      const response = await api.agent.runSession(currentSession.id, prompt, attachmentIds, { signal: abortController.signal });
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(errorText || 'Failed to run agent');
      }
      
      // Best-effort: mark as active when starting a new run.
      setSessions(sessions.map((s: any) => (s.id === currentSession.id ? { ...s, status: 'active' } : s)) as never[]);

      let sawError = false;
      await readSseStream(response, (event) => {
        if ((event as any)?.type === 'error') {
          sawError = true;
        }
        addEvent(event as AgentEvent);
      });

      // Mark completed when the stream ends without an error event.
      if (!sawError) {
        try {
          await api.agent.updateStatus(currentSession.id, 'completed');
          await loadSessions();
        } catch {
          // ignore
        }
      }
    } catch (error) {
      // User-initiated cancel: do not show as error.
      if (abortController.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return;
      }
      addEvent({ 
        type: 'error', 
        content: error instanceof Error ? error.message : 'Error running agent' 
      });
    } finally {
      setIsRunning(false);
      if (runAbortRef.current === abortController) {
        runAbortRef.current = null;
      }
      queueMicrotask(() => inputRef.current?.focus());
    }
  };

  const handleCancel = () => {
    didCancelRef.current = true;
    try {
      // Provide a reason for server-side abort handling where supported.
      (runAbortRef.current as any)?.abort?.('user');
    } catch {
      // ignore
    }
    runAbortRef.current = null;
    setIsRunning(false);
    if (currentSession) {
      void (async () => {
        try {
          await api.agent.updateStatus(currentSession.id, 'cancelled');
          await loadSessions();
        } catch {
          // ignore
        }
      })();
    }
    queueMicrotask(() => inputRef.current?.focus());
  };

  const selectedWorkspace = selectedWorkspaceId
    ? workspaces.find((ws) => ws.id === selectedWorkspaceId) ?? null
    : null;
  const hasEffectiveWorkspace = Boolean(selectedWorkspaceId || currentSession?.workspaceId);
  const defaultChannel = useMemo(() => getGlobalDefaultChannel(channels), [channels]);

  const filteredSessions = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s: any) => (s.title || '').toLowerCase().includes(q));
  })();

  return (
    <>
      <AppShellSlot
        title="Agent"
        aside={
          <Paper
            style={{
              height: '100%',
              border: '1px solid var(--mantine-color-gray-3)',
              borderRadius: 'var(--mantine-radius-md)',
            }}
            p="sm"
          >
            <Stack h="100%" gap="sm">
              <Button
                leftSection={<IconPlus size={16} />}
                onClick={() => void handleNewSession()}
                loading={creating}
              >
                新会话
              </Button>

              <TextInput
                placeholder="搜索会话..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />

              <ScrollArea flex={1} scrollbarSize={8}>
                <Stack gap="xs">
                  {filteredSessions.map((session: any) => (
                    <Paper
                      key={session.id}
                      p="sm"
                      radius="md"
                      withBorder
                      style={{
                        cursor: 'pointer',
                        backgroundColor: currentSession?.id === session.id
                          ? 'var(--mantine-color-blue-0)'
                          : undefined,
                      }}
                      onClick={() => setCurrentSession(session as never)}
                    >
                      <Group justify="space-between" wrap="nowrap">
                        <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                          <IconRobot size={16} />
                          <Text size="sm" truncate style={{ flex: 1 }}>
                            {session.title}
                          </Text>
                        </Group>
                        <Menu shadow="md" width={160} position="bottom-end">
                          <Menu.Target>
                            <ActionIcon
                              variant="subtle"
                              size="sm"
                              aria-label="会话操作"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <IconDots size={14} />
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
                              leftSection={<IconTrash size={14} />}
                              color="red"
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

                      <Group gap={6} mt={6}>
                        {isRunning && currentSession?.id === session.id ? (
                          <Badge size="xs" variant="light" color="blue">
                            运行中
                          </Badge>
                        ) : (
                          <Badge size="xs" variant="light" color={session.status === 'completed' ? 'green' : session.status === 'cancelled' ? 'red' : 'gray'}>
                            {session.status === 'active' ? '进行中' : session.status === 'completed' ? '已完成' : '已取消'}
                          </Badge>
                        )}
                      </Group>
                    </Paper>
                  ))}

                  {filteredSessions.length === 0 && (
                    <Text size="sm" c="dimmed" ta="center" py="xl">
                      没有匹配的会话
                    </Text>
                  )}
                </Stack>
              </ScrollArea>
            </Stack>
          </Paper>
        }
      />

      <Paper
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
        p={0}
      >
        <div style={{ padding: PAGE_PAD, paddingBottom: 'var(--mantine-spacing-xs)' }}>
          <Group justify="space-between" mb="md" wrap="nowrap">
            <div style={{ minWidth: 0 }}>
              <Text fw={600} truncate>
                {currentSession ? currentSession.title : 'Agent'}
              </Text>
              {(bootstrapping || isRunning) && <Text size="xs" c="blue">运行中...</Text>}
            </div>

            <Group gap="xs" wrap="nowrap">
              {defaultChannel ? (
                <>
                  <Badge variant="light" color="gray">继承默认</Badge>
                  <Button
                    component={Link}
                    href={buildSettingsLink({ tab: 'channels', focus: 'default' })}
                    size="xs"
                    variant="light"
                    styles={{ label: { fontWeight: 600 } }}
                  >
                    <span
                      style={{
                        maxWidth: 240,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        display: 'block',
                      }}
                    >
                      {defaultChannel.label}
                    </span>
                  </Button>
                </>
              ) : (
                <Button
                  component={Link}
                  href={buildSettingsLink({ tab: 'channels', focus: 'default' })}
                  size="xs"
                  variant="light"
                  leftSection={<IconSettings size={14} />}
                >
                  去设置默认模型
                </Button>
              )}

              <Menu shadow="md" width={260} position="bottom-end" withinPortal>
                <Menu.Target>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconBriefcase size={14} />}
                    disabled={workspaces.length === 0}
                    styles={{ label: { fontWeight: 600 } }}
                  >
                    {selectedWorkspace ? selectedWorkspace.name : workspaces.length ? '选择默认 Workspace' : '未创建 Workspace'}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>默认 Workspace（账号级）</Menu.Label>
                  {workspaces.map((ws) => (
                    <Menu.Item
                      key={ws.id}
                      leftSection={ws.id === selectedWorkspaceId ? <IconCheck size={14} /> : undefined}
                      onClick={() => void handleWorkspaceChange(ws.id)}
                    >
                      {ws.name}
                    </Menu.Item>
                  ))}
                  <Menu.Divider />
                  <Menu.Item component={Link} href="/settings" leftSection={<IconSettings size={14} />}>
                    管理 Workspace
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>

              <Button size="xs" variant="light" onClick={() => void loadSessions()}>
                刷新
              </Button>
            </Group>
          </Group>

          {!currentSession && (
            <Text c="dimmed">在右侧栏选择或创建会话，然后在底部输入任务运行。</Text>
          )}
        </div>

        {/* Custom scroll container so we can keep short timelines pinned to bottom. */}
        <div
          ref={viewportRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            paddingLeft: PAGE_PAD,
            paddingRight: PAGE_PAD,
          }}
        >
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
            <Stack gap="xs" pb="sm" style={{ marginTop: 'auto' }}>
            {currentSession && events.map((event, index) => (
              <AgentEventCard key={index} event={event} />
            ))}

            {currentSession && events.length === 0 && (
              <Text c="dimmed" ta="center" py="xl">
                开始输入任务并运行...
              </Text>
            )}
            </Stack>
          </div>
        </div>

        {workspaces.length === 0 && (
          <div style={{ paddingLeft: PAGE_PAD, paddingRight: PAGE_PAD }}>
            <Alert color="orange" mb="sm" title="需要先创建 Workspace">
              未创建 Workspace，Agent 无法运行。请先去设置页面创建 Workspace。
              <Button component={Link} href="/settings" size="xs" variant="light" ml="sm">
                去设置
              </Button>
            </Alert>
          </div>
        )}

        <div style={{ paddingLeft: PAGE_PAD, paddingRight: PAGE_PAD, paddingBottom: COMPOSER_PAD_BOTTOM }}>
          <Paper
            p="sm"
            radius="lg"
            withBorder
            style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}
          >
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

              <Group gap="sm" wrap="nowrap" align="flex-end">
                <Textarea
                  placeholder={currentSession ? '输入任务...' : '请先选择一个会话'}
                  value={taskInput}
                  onChange={(e) => setTaskInput(e.target.value)}
	                  onKeyDown={(e) => {
	                    if (e.key === 'Enter' && !e.shiftKey) {
	                      const ne = e.nativeEvent as any;
	                      if (ne?.isComposing || ne?.keyCode === 229) {
	                        return;
	                      }
	                      e.preventDefault();
	                      handleRun();
	                    }
	                  }}
                  style={{ flex: 1, minWidth: 0 }}
                  autosize
                  minRows={1}
                  maxRows={6}
                  // Allow drafting next task while agent is running; only "Run" is locked.
                  disabled={!currentSession || workspaces.length === 0 || !hasEffectiveWorkspace}
                  ref={inputRef}
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
                    <Button variant="light" {...props} disabled={!currentSession || isRunning || workspaces.length === 0 || !hasEffectiveWorkspace}>
                      附件
                    </Button>
                  )}
                </FileButton>
                {isRunning ? (
                  <Button
                    onClick={handleCancel}
                    color="red"
                    variant="light"
                    aria-label="停止"
                    leftSection={<IconPlayerStop size={16} />}
                  >
                    停止
                  </Button>
                ) : (
                  <Button
                    onClick={handleRun}
                    disabled={!currentSession || (!taskInput.trim() && files.length === 0) || workspaces.length === 0 || !hasEffectiveWorkspace}
                    aria-label="运行"
                  >
                    <IconSend size={18} />
                  </Button>
                )}
              </Group>
            </Stack>
          </Paper>
        </div>
      </Paper>
    </>
  );
}
