'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Group, Text, Button, Badge } from '@mantine/core';
import { IconSettings } from '@tabler/icons-react';
import { useChatStore } from '@/stores/chatStore';
import { getEffectiveModelForConversation } from '@/lib/effective-model';
import { ModelPickerModal } from './ModelPickerModal';
import { buildSettingsLink } from '@/lib/settings-link';

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

        {effective.ok ? (
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
        ) : effective.scope === 'conversation' ? (
          <Group gap="xs" wrap="nowrap">
            <Badge variant="light" color="orange">对话模型异常</Badge>
            <Button
              size="xs"
              variant="light"
              onClick={() => setOpened(true)}
              styles={{ label: { fontWeight: 600 } }}
            >
              修复模型
            </Button>
          </Group>
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
      </Group>

      {opened && (
        <ModelPickerModal
          opened={opened}
          onClose={() => setOpened(false)}
          conversationId={currentConversation.id}
          conversationFixReason={!effective.ok && effective.scope === 'conversation' ? effective.reason : null}
          current={
            currentConversation.channelId && currentConversation.modelId
              ? { channelId: currentConversation.channelId, modelId: currentConversation.modelId }
              : effective.ok
                ? { channelId: effective.channelId, modelId: effective.modelId }
                : null
          }
        />
      )}
    </>
  );
}
