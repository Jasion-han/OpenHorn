'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type ConfirmOptions = {
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmDialogContext = React.createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmDialogContext);
  if (!ctx) {
    throw new Error('useConfirm must be used within ConfirmDialogProvider');
  }
  return ctx;
}

export function ConfirmDialogProvider(props: { children: React.ReactNode }) {
  const resolveRef = React.useRef<((value: boolean) => void) | null>(null);
  const [open, setOpen] = React.useState(false);
  const [options, setOptions] = React.useState<ConfirmOptions | null>(null);

  React.useEffect(() => {
    if (open) return;
    const t = window.setTimeout(() => {
      if (!resolveRef.current) setOptions(null);
    }, 250);
    return () => window.clearTimeout(t);
  }, [open]);

  const confirm = React.useCallback<ConfirmFn>((opts) => {
    setOptions(opts);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const finish = React.useCallback((value: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setOpen(false);
    resolve?.(value);
  }, []);

  return (
    <ConfirmDialogContext.Provider value={confirm}>
      {props.children}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            // Closed via overlay click / ESC / top-right close.
            // If the caller is still awaiting a result, treat it as cancel.
            const resolve = resolveRef.current;
            if (resolve) {
              resolveRef.current = null;
              resolve(false);
            }
            setOpen(false);
            return;
          }
          setOpen(true);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{options?.title || '确认操作'}</DialogTitle>
            {options?.description ? (
              <DialogDescription className="whitespace-pre-line">
                {options.description}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => finish(false)}
            >
              {options?.cancelText || '取消'}
            </Button>
            <Button
              type="button"
              variant={options?.destructive ? 'destructive' : 'default'}
              onClick={() => finish(true)}
            >
              {options?.confirmText || '确定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmDialogContext.Provider>
  );
}
