'use client';

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

export function AppHeader({ title }: { title: string }) {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const { channels, setChannels } = useChatStore();

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

  return (
    <Group justify="space-between" h="100%" px="md">
      <Group gap="sm">
        <Text fw={600}>{title}</Text>
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

