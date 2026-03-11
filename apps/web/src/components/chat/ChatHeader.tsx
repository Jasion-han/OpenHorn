'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Group, Text, Button, Badge } from '@mantine/core';
import { IconSettings } from '@tabler/icons-react';
import { useChatStore } from '@/stores/chatStore';
import { getEffectiveModelForConversation } from '@/lib/effective-model';
import { ModelPickerModal } from './ModelPickerModal';

export function ChatHeader() {
  const { currentConversation, channels, isStreaming } = useChatStore();
  const [opened, setOpened] = useState(false);

  const effective = useMemo(
    () => getEffectiveModelForConversation(channels, currentConversation),
    [channels, currentConversation]
  );

  if (!currentConversation) {
    return (
      <Group justify="space-between" mb="md">
        <Text fw={600}>Chat</Text>
      </Group>
    );
  }

  return (
    <>
      <Group justify="space-between" mb="md" wrap="nowrap">
        <div style={{ minWidth: 0 }}>
          <Text fw={600} truncate>{currentConversation.title}</Text>
          {isStreaming && <Text size="xs" c="blue">Thinking...</Text>}
        </div>

        {effective ? (
          <Group gap="xs" wrap="nowrap">
            {effective.source === 'global' && (
              <Badge variant="light" color="gray">继承默认</Badge>
            )}
            <Button
              size="xs"
              variant="light"
              onClick={() => setOpened(true)}
              styles={{ label: { fontWeight: 600 } }}
            >
              {effective.label}
            </Button>
          </Group>
        ) : (
          <Button
            component={Link}
            href="/settings"
            size="xs"
            variant="light"
            leftSection={<IconSettings size={14} />}
          >
            去设置默认模型
          </Button>
        )}
      </Group>

      {effective && (
        <ModelPickerModal
          opened={opened}
          onClose={() => setOpened(false)}
          conversationId={currentConversation.id}
          current={{ channelId: effective.channelId, modelId: effective.modelId }}
        />
      )}
    </>
  );
}

