'use client';

import { useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { PanelLeft, X } from 'lucide-react';
import { LeftSidebar } from './LeftSidebar';
import { Button } from '../ui/button';
import { cn } from '@/lib/utils';

export function AppShellLayout({ children }: { children: React.ReactNode }) {
  const [mobileLeftOpen, setMobileLeftOpen] = useState(false);
  const pathname = usePathname();

  const isCompact = useMemo(() => {
    // Keep Settings readable; chat/agent want edge-to-edge within the middle panel.
    return pathname === '/settings' || pathname?.startsWith('/settings/');
  }, [pathname]);

  return (
    <div className="flex h-dvh w-dvw overflow-hidden bg-gradient-to-br from-background via-background to-muted/20">
      {/* Mobile top controls */}
      <div className="sm:hidden fixed top-0 left-0 right-0 z-50 flex h-12 items-center justify-between px-2 border-b bg-background/80 backdrop-blur-sm">
        <Button
          variant="ghost"
          size="icon-sm"
          className="titlebar-no-drag"
          aria-label="Open left sidebar"
          onClick={() => setMobileLeftOpen(true)}
        >
          <PanelLeft size={18} />
        </Button>
        <div className="text-sm font-semibold">OpenHorn</div>
        <div className="w-8" />
      </div>

      {/* Desktop left sidebar */}
      <div className="hidden sm:block w-[320px] shrink-0 p-2">
        <div className="h-full rounded-2xl border border-border/50 bg-background/70 backdrop-blur-sm shadow-minimal overflow-hidden">
          <LeftSidebar />
        </div>
      </div>

      {/* Middle panel */}
      <div className={cn('flex-1 min-w-0 p-2', 'sm:pl-0')}>
        <div
          className={cn(
            'h-full min-h-0 rounded-2xl border border-border/50 bg-background/70 backdrop-blur-sm shadow-minimal overflow-hidden',
            isCompact ? 'p-4' : 'p-2'
          )}
          style={{ paddingTop: 'calc(0.5rem + env(safe-area-inset-top, 0px))' }}
        >
          <div className={cn('h-full min-h-0', isCompact ? 'overflow-auto' : 'overflow-hidden', 'sm:pt-0 pt-12')}>
            {children}
          </div>
        </div>
      </div>

      {/* Mobile drawers */}
      {mobileLeftOpen && (
        <div
          className="sm:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]"
          onClick={() => {
            setMobileLeftOpen(false);
          }}
        />
      )}

      {mobileLeftOpen && (
        <div className="sm:hidden fixed inset-y-12 left-0 z-50 w-[320px] p-2">
          <div className="h-full rounded-2xl border border-border/50 bg-background/90 backdrop-blur-sm shadow-minimal overflow-hidden">
            <div className="flex items-center justify-end p-2 border-b">
              <Button variant="ghost" size="icon-sm" onClick={() => setMobileLeftOpen(false)} aria-label="Close">
                <X size={18} />
              </Button>
            </div>
            <LeftSidebar />
          </div>
        </div>
      )}
    </div>
  );
}
