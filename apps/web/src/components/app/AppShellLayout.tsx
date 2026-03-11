'use client';

import { useCallback, useMemo, useState } from 'react';
import { AppShell, Burger } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { AppNav } from './AppNav';
import { AppHeader } from './AppHeader';
import { AppShellProvider } from './AppShellContext';

const DEFAULT_TITLE = 'OpenHorn';

export function AppShellLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpened, { toggle: toggleMobile }] = useDisclosure(false);
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [aside, setAside] = useState<React.ReactNode | null>(null);

  const resetSlots = useCallback(() => {
    setTitle(DEFAULT_TITLE);
    setAside(null);
  }, []);

  const ctx = useMemo(() => ({
    setTitle,
    setAside,
    resetSlots,
  }), [resetSlots]);

  return (
    <AppShellProvider value={ctx}>
      <AppShell
        header={{ height: 56 }}
        navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !mobileOpened } }}
        aside={aside ? { width: 360, breakpoint: 'md', collapsed: { mobile: true } } : undefined}
        padding="md"
        styles={{
          main: {
            background: 'var(--mantine-color-gray-0)',
            minHeight: 'calc(100dvh - var(--app-shell-header-height, 56px))',
            display: 'flex',
            flexDirection: 'column',
          },
        }}
      >
        <AppShell.Header>
          <AppShell.Section>
            <div style={{ display: 'flex', height: '100%', alignItems: 'center' }}>
              <div style={{ paddingLeft: 12, paddingRight: 8 }}>
                <Burger
                  opened={mobileOpened}
                  onClick={toggleMobile}
                  hiddenFrom="sm"
                  size="sm"
                />
              </div>
              <div style={{ flex: 1 }}>
                <AppHeader title={title} />
              </div>
            </div>
          </AppShell.Section>
        </AppShell.Header>

        <AppShell.Navbar p="md">
          <AppNav />
        </AppShell.Navbar>

        {aside && (
          <AppShell.Aside p="md">
            {aside}
          </AppShell.Aside>
        )}

        <AppShell.Main>
          {children}
        </AppShell.Main>
      </AppShell>
    </AppShellProvider>
  );
}
