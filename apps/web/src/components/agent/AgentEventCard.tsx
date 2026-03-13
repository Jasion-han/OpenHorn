'use client';

import { useState } from 'react';
import { Badge, Button, Collapse, Group, Paper, Text } from '@mantine/core';
import { IconCopy, IconCheck, IconTrash, IconRefresh, IconPencil } from '@tabler/icons-react';
import type { AgentEvent } from '@/stores/agentStore';
import { WRAP_TEXT } from '@/components/ui/wrapText';
import { MarkdownMessage } from '@/components/ui/MarkdownMessage';
import { IconActionButton } from '@/components/ui/IconActionButton';

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <IconActionButton onClick={handleCopy} title={copied ? '已复制' : '复制'}>
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </IconActionButton>
  );
}

export function AgentEventCard({
  event,
  isNewTurn = false,
  onDelete,
  onRetry,
  onEdit,
}: {
  event: AgentEvent;
  isNewTurn?: boolean;
  onDelete?: () => void;
  onRetry?: () => void;
  onEdit?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  if (event.type === 'meta') {
    return null;
  }

  if (event.type === 'user') {
    return (
      <div
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: '100%', marginTop: isNewTurn ? 'var(--mantine-spacing-xl)' : undefined }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <Paper px="md" py="sm" radius="md" bg="blue.0" withBorder style={{ maxWidth: '72%', display: 'inline-block' }}>
          <Text size="sm" style={WRAP_TEXT}>{event.content || ''}</Text>
        </Paper>
        <div style={{ marginTop: 2, opacity: hovered ? 1 : 0, transition: 'opacity 0.15s', pointerEvents: hovered ? 'auto' : 'none' }}>
          <Group gap={2}>
            {onEdit && (
              <IconActionButton onClick={onEdit} title="编辑">
                <IconPencil size={13} />
              </IconActionButton>
            )}
            <CopyAction text={event.content || ''} />
            {onDelete && (
              <IconActionButton onClick={onDelete} title="删除" danger disabled={!event.id}>
                <IconTrash size={13} />
              </IconActionButton>
            )}
          </Group>
        </div>
      </div>
    );
  }

  const background =
    event.type === 'error'
      ? 'red.0'
      : event.type === 'tool_start'
        ? 'blue.0'
        : event.type === 'tool_result'
          ? 'green.0'
          : 'gray.0';

  if (event.type === 'text') {
    return (
      <div
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', maxWidth: '92%' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <Paper px="md" py="sm" radius="md" bg={background} style={{ display: 'inline-block', maxWidth: '100%' }}>
          <div style={WRAP_TEXT}>
            <MarkdownMessage content={event.content || ''} />
          </div>
        </Paper>
        <div style={{ display: 'flex', gap: 2, marginTop: 2, opacity: hovered ? 1 : 0, transition: 'opacity 0.15s', pointerEvents: hovered ? 'auto' : 'none' }}>
          <CopyAction text={event.content || ''} />
          {onRetry && (
            <IconActionButton onClick={onRetry} title="重试">
              <IconRefresh size={13} />
            </IconActionButton>
          )}
          {onDelete && (
            <IconActionButton onClick={onDelete} title="删除" danger disabled={!event.id}>
              <IconTrash size={13} />
            </IconActionButton>
          )}
        </div>
      </div>
    );
  }

  if (event.type === 'tool_start') {
    return (
      <Paper p="sm" radius="md" bg={background} style={{ maxWidth: '100%', width: '100%' }}>
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <Badge size="sm" color="blue">
              工具
            </Badge>
            <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
              {event.toolName || '未知工具'}
            </Text>
          </Group>
          <Button size="xs" variant="subtle" onClick={() => setOpen((value) => !value)}>
            {open ? '收起' : '展开输入'}
          </Button>
        </Group>
        <Collapse in={open}>
          <Paper withBorder p="xs" mt="xs" style={{ maxWidth: '100%' }}>
            <Text size="xs" c="dimmed">
              输入
            </Text>
            <pre
              style={{
                margin: 0,
                fontSize: 'var(--mantine-font-size-xs)',
                fontFamily: 'var(--mantine-font-family-monospace)',
                ...WRAP_TEXT,
              }}
            >
              {JSON.stringify(event.toolInput ?? {}, null, 2)}
            </pre>
          </Paper>
        </Collapse>
      </Paper>
    );
  }

  if (event.type === 'tool_result') {
    return (
      <Paper p="sm" radius="md" bg={background} style={{ maxWidth: '100%', width: '100%' }}>
        <Group justify="space-between" align="center" wrap="nowrap">
          <Badge size="sm" color="green">
            结果
          </Badge>
          <Button size="xs" variant="subtle" onClick={() => setOpen((value) => !value)}>
            {open ? '收起' : '展开输出'}
          </Button>
        </Group>
        <Collapse in={open}>
          <Paper withBorder p="xs" mt="xs" style={{ maxWidth: '100%' }}>
            <Text size="xs" c="dimmed">
              输出
            </Text>
            <pre
              style={{
                margin: 0,
                fontSize: 'var(--mantine-font-size-xs)',
                fontFamily: 'var(--mantine-font-family-monospace)',
                ...WRAP_TEXT,
              }}
            >
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
      <Paper p="sm" radius="md" bg={background} style={{ maxWidth: '100%', width: '100%' }}>
        <Text size="sm" c="red" style={WRAP_TEXT}>
          {event.content}
        </Text>
      </Paper>
    );
  }

  return null;
}
