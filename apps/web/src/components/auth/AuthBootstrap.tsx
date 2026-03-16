'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { BACKEND_UP_EVENT } from '../../stores/backendStatusStore';

const UNAUTHORIZED_EVENT = 'openhorn:unauthorized';

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
          if (!cancelled && pathname !== '/login') router.replace('/login');
          return;
        }
        setUser(user);
        try {
          const { channels } = await api.channels.list();
          setChannels(channels);
        } catch {
          // Best-effort
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    void run();
    const onBackendUp = () => void run();
    const onUnauthorized = () => {
      logout();
      setChannels([]);
      if (!cancelled && pathname !== '/login') router.replace('/login');
    };
    window.addEventListener(BACKEND_UP_EVENT, onBackendUp);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener(BACKEND_UP_EVENT, onBackendUp);
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, [logout, pathname, router, setChannels, setUser]);

  if (!ready) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-2">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return children;
}
