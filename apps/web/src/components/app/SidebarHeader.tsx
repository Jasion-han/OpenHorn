"use client";

import { ChevronDown, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { hideNotification, notifyErrorOnce, notifySuccess } from "@/lib/notify";
import { useAuthStore } from "@/stores/authStore";
import { useBackendStatusStore } from "@/stores/backendStatusStore";
import { useChatStore } from "@/stores/chatStore";

export function SidebarHeader() {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const { setChannels } = useChatStore();
  const backend = useBackendStatusStore();
  const [retrying, setRetrying] = useState(false);

  const handleLogout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // Best-effort
    } finally {
      logout();
      setChannels([]);
      router.replace("/login");
    }
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const ok = await backend.retry();
      if (ok) {
        hideNotification("backend_down");
        notifySuccess("连接已恢复", "已重新连接后端");
      } else {
        const hint =
          backend.lastError === "Blocked by browser (CORS?)"
            ? "仍然无法访问后端（可能被浏览器跨域/CORS 拦截）。请检查后端 CORS 是否允许当前页面 Origin，并查看 DevTools Console/Network。"
            : backend.lastError === "Blocked by browser (mixed content)"
              ? "仍然无法访问后端（可能被浏览器 Mixed Content 拦截：HTTPS 页面访问 HTTP 后端）。"
              : `仍然无法连接到后端服务（http://localhost:3000）。`;
        notifyErrorOnce("backend_down", "后端不可用", hint);
      }
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
      <div className="min-w-0">
        <div className="font-semibold text-sm leading-5 truncate">OpenHorn</div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Local</span>
          {backend.status === "down" && <Badge variant="destructive">offline</Badge>}
          {backend.status === "down" && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              onClick={() => void handleRetry()}
              disabled={retrying}
            >
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          )}
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="flex items-center gap-1 w-auto px-2 titlebar-no-drag"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-semibold">
              {user?.username?.slice(0, 1)?.toUpperCase() || "U"}
            </div>
            <ChevronDown size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel>{user?.username || "User"}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onClick={() => void handleLogout()}>
            <LogOut size={16} />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
