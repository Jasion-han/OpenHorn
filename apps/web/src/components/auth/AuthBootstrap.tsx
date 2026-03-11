'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Center, Loader, Stack, Text } from '@mantine/core';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';

export function AuthBootstrap({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { setUser, logout } = useAuthStore();
  const { setChannels } = useChatStore();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const { user } = await api.auth.me();
        if (!user) {
          logout();
          if (!cancelled && pathname !== '/login') {
            router.replace('/login');
          }
          return;
        }

        setUser(user);

        try {
          const { channels } = await api.channels.list();
          setChannels(channels);
        } catch {
          // Best-effort; header can still render without channel info.
        }
      } finally {
        if (!cancelled) {
          setReady(true);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [logout, pathname, router, setChannels, setUser]);

  if (!ready) {
    return (
      <Center h="100vh">
        <Stack align="center" gap="sm">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">Loading...</Text>
        </Stack>
      </Center>
    );
  }

  return children;
}
