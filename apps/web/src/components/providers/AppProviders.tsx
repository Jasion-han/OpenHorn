'use client';

import type * as React from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfirmDialogProvider } from '@/components/dialogs/ConfirmDialogProvider';

export function AppProviders(props: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <ConfirmDialogProvider>
        {props.children}
      </ConfirmDialogProvider>
    </TooltipProvider>
  );
}
