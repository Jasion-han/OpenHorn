'use client';

import { useState } from 'react';
import { Badge, Button, Collapse, Group, Paper, Text } from '@mantine/core';
import type { AgentEvent } from '@/stores/agentStore';
import { WRAP_TEXT } from '@/components/ui/wrapText';
import { MarkdownMessage } from '@/components/ui/MarkdownMessage';

export function AgentEventCard({ event }: { event: AgentEvent }) {
  const [open, setOpen] = useState(false);

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
      <Paper p="sm" radius="md" bg={background} style={{ maxWidth: '100%' }}>
        <div style={WRAP_TEXT}>
          <MarkdownMessage content={event.content || ''} />
        </div>
      </Paper>
    );
  }

  if (event.type === 'tool_start') {
    return (
      <Paper p="sm" radius="md" bg={background} style={{ maxWidth: '100%' }}>
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
      <Paper p="sm" radius="md" bg={background} style={{ maxWidth: '100%' }}>
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
      <Paper p="sm" radius="md" bg={background} style={{ maxWidth: '100%' }}>
        <Text size="sm" c="red" style={WRAP_TEXT}>
          {event.content}
        </Text>
      </Paper>
    );
  }

  return (
    <Paper p="sm" radius="md" bg={background} style={{ maxWidth: '100%' }}>
      <Badge color="green">完成</Badge>
    </Paper>
  );
}
