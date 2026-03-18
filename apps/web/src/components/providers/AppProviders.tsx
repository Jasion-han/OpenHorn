"use client";

import type * as React from "react";
import { ConfirmDialogProvider } from "@/components/dialogs/ConfirmDialogProvider";
import { TooltipProvider } from "@/components/ui/tooltip";

export function AppProviders(props: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <ConfirmDialogProvider>{props.children}</ConfirmDialogProvider>
    </TooltipProvider>
  );
}
