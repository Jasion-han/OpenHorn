'use client';

import { createContext, useContext } from 'react';

export type AppShellSlots = {
  title: string;
  aside: React.ReactNode | null;
};

export type AppShellContextValue = {
  setTitle: (title: string) => void;
  setAside: (aside: React.ReactNode | null) => void;
  resetSlots: () => void;
};

const AppShellContext = createContext<AppShellContextValue | null>(null);

export function AppShellProvider({
  value,
  children,
}: {
  value: AppShellContextValue;
  children: React.ReactNode;
}) {
  return (
    <AppShellContext.Provider value={value}>
      {children}
    </AppShellContext.Provider>
  );
}

export function useAppShell() {
  const ctx = useContext(AppShellContext);
  if (!ctx) {
    throw new Error('useAppShell must be used within AppShellProvider');
  }
  return ctx;
}

