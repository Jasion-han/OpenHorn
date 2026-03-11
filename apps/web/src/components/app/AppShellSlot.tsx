'use client';

import { useEffect } from 'react';
import { useAppShell } from './AppShellContext';

export function AppShellSlot({
  title,
  aside,
}: {
  title: string;
  aside?: React.ReactNode;
}) {
  const shell = useAppShell();

  useEffect(() => {
    shell.setTitle(title);
    shell.setAside(aside ?? null);
    return () => {
      shell.resetSlots();
    };
  }, [aside, shell, title]);

  return null;
}

