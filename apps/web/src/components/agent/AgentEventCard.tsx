'use client';

import { useState } from 'react';
import { Badge, Button, Collapse, Group, Paper, Text } from '@mantine/core';
import { IconCopy, IconCheck, IconTrash, IconRefresh } from '@tabler/icons-react';
import type { AgentEvent } from '@/stores/agentStore';
import { WRAP_TEXT } from '@/components/ui/wrapText';
import { MarkdownMessage } from '@/components/ui/MarkdownMessage';

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      title={copied ? '已复制' : '复制'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        padding: '3px 6px',
        border: '1px solid var(--mantine-color-gray-3)',
        borderRadius: 'var(--mantine-radius-sm)',
        background: 'transparent',
        color: 'var(--mantine-color-gray-5)',
        cursor: 'pointer', fontSize: 11, fontFamily: 'inherit',
        transition: 'background 0.12s, color 0.12s',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--mantine-color-gray-1)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--mantine-color-gray-8)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--mantine-color-gray-5)'; }}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      <span>{copied ? '已复制' : '复制'}</span>
    </button>
  );
}

export function AgentEventCard({ event, isNewTurn = false, onDelete, onRetry }: { event: AgentEvent; isNewTurn?: boolean; onDelete?: () => void; onRetry?: () => void }) {
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
          <CopyAction text={event.content || ''} />
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
            <button
              onClick={onRetry}
              title="重新生成"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                padding: '3px 6px',
                border: '1px solid var(--mantine-color-gray-3)',
                borderRadius: 'var(--mantine-radius-sm)',
                background: 'transparent',
                color: 'var(--mantine-color-gray-5)',
                cursor: 'pointer', fontSize: 11, fontFamily: 'inherit',
                transition: 'background 0.12s, color 0.12s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--mantine-color-gray-1)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--mantine-color-gray-8)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--mantine-color-gray-5)'; }}
            >
              <IconRefresh size={13} />
              <span>重试</span>
            </button>
          )}
          {onDelete && event.id && (
            <button
              onClick={onDelete}
              title="删除"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                padding: '3px 6px',
                border: '1px solid var(--mantine-color-gray-3)',
                borderRadius: 'var(--mantine-radius-sm)',
                background: 'transparent',
                color: 'var(--mantine-color-red-5)',
                cursor: 'pointer', fontSize: 11, fontFamily: 'inherit',
                transition: 'background 0.12s, color 0.12s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--mantine-color-red-0)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--mantine-color-red-7)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--mantine-color-red-5)'; }}
            >
              <IconTrash size={13} />
              <span>删除</span>
            </button>
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
