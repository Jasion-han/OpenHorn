'use client';

import type React from 'react';
import { Button } from './button';
import { cn } from '@/lib/utils';

export function IconActionButton({
  children,
  onClick,
  title,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      variant="ghost"
      size="icon-sm"
      className={cn(
        'h-6 w-6 rounded-md border border-border/60 bg-transparent',
        danger
          ? 'text-destructive hover:bg-destructive/10 hover:text-destructive'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      {children}
    </Button>
  );
}
