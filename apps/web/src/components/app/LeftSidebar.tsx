"use client";

import { Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChatAside } from "@/components/chat/ChatAside";
import { cn } from "@/lib/utils";
import { SidebarHeader } from "./SidebarHeader";

export function LeftSidebar() {
  const pathname = usePathname() ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeader />

      <div className="flex-1 min-h-0 overflow-hidden">
        <ChatAside />
      </div>

      <div className="px-2 pt-3 pb-5 border-t border-border/50">
        <div className="flex justify-center h-[56px] items-center">
          <Link
            href="/settings"
            title="Settings"
            aria-label="Settings"
            className={cn(
              "inline-flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
              pathname === "/settings" || pathname.startsWith("/settings/")
                ? "bg-foreground/[0.08] text-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
            )}
          >
            <Settings size={18} />
          </Link>
        </div>
      </div>
    </div>
  );
}
