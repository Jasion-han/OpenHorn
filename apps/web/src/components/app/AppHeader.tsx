'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Group,
  Text,
  Badge,
  Menu,
  ActionIcon,
  Button,
  Avatar,
} from '@mantine/core';
import { IconChevronDown, IconLogout, IconSettings } from '@tabler/icons-react';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { getGlobalDefaultChannel } from '../../lib/default-channel';
import { api } from '../../lib/api';
import { useBackendStatusStore } from '../../stores/backendStatusStore';
import { notifyErrorOnce, notifySuccess } from '../../lib/notify';

export function AppHeader({ title }: { title: string }) {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const { channels, setChannels } = useChatStore();
  const backend = useBackendStatusStore();
  const [retrying, setRetrying] = useState(false);

  const defaultChannel = getGlobalDefaultChannel(channels);

  const handleLogout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // Best-effort
    } finally {
      logout();
      setChannels([]);
      router.replace('/login');
    }
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const ok = await backend.retry();
      if (ok) {
        notifySuccess('连接已恢复', '已重新连接后端');
      } else {
        notifyErrorOnce('backend_down', '后端不可用', '仍然无法连接到后端服务（http://localhost:3000）。');
      }
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Group justify="space-between" h="100%" px="md">
      <Group gap="sm">
        <Text fw={600}>{title}</Text>
        {backend.status === 'down' && (
          <Group gap="xs" wrap="nowrap">
            <Badge color="red" variant="filled">后端离线</Badge>
            <Button size="xs" variant="light" color="red" onClick={() => void handleRetry()} loading={retrying}>
              Retry
            </Button>
          </Group>
        )}
        {defaultChannel ? (
          <Badge variant="light" color="gray">{defaultChannel.label}</Badge>
        ) : (
          <Button
            component={Link}
            href="/settings"
            size="xs"
            variant="light"
            leftSection={<IconSettings size={14} />}
          >
            Set default model
          </Button>
        )}
      </Group>

      <Menu position="bottom-end" width={180}>
        <Menu.Target>
          <ActionIcon variant="subtle" size="lg">
            <Group gap={8} wrap="nowrap">
              <Avatar size={26} radius="xl">
                {user?.username?.slice(0, 1)?.toUpperCase() || 'U'}
              </Avatar>
              <IconChevronDown size={16} />
            </Group>
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{user?.username || 'User'}</Menu.Label>
          <Menu.Item
            leftSection={<IconLogout size={16} />}
            color="red"
            onClick={() => void handleLogout()}
          >
            Logout
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}
