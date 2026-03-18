"use client";

import { Bot, Palette, Radio, Settings } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AgentSettings } from "@/components/settings/AgentSettings";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";
import { ChannelSettings } from "@/components/settings/ChannelSettings";
import { GeneralSettings } from "@/components/settings/GeneralSettings";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const TABS = [
  { value: "general", label: "通用", icon: <Settings size={16} /> },
  { value: "channels", label: "渠道", icon: <Radio size={16} /> },
  { value: "agent", label: "Agent", icon: <Bot size={16} /> },
  { value: "appearance", label: "外观", icon: <Palette size={16} /> },
] as const;

type TabValue = (typeof TABS)[number]["value"];

export default function SettingsPage() {
  const router = useRouter();
  const search = useSearchParams();
  const [tab, setTab] = useState<TabValue>("channels");

  useEffect(() => {
    if (!search) return;
    const raw = search.get("tab");
    if (raw === "general" || raw === "channels" || raw === "agent" || raw === "appearance") {
      setTab(raw as TabValue);
      return;
    }
    if (raw) setTab("channels");
  }, [search]);

  const selectTab = (value: TabValue) => {
    setTab(value);
    router.replace(`/settings?tab=${value}`);
  };

  return (
    <div className="h-full min-h-0">
      <div className="flex h-full min-h-0 w-full">
        <div className="w-[180px] shrink-0 border-r border-border/50 pt-8 px-2">
          <h2 className="text-xs font-medium text-muted-foreground px-3 mb-2 uppercase tracking-wider">
            设置
          </h2>
          <nav className="flex flex-col gap-1">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => selectTab(t.value)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors",
                  tab === t.value
                    ? "bg-muted text-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <ScrollArea className="flex-1 min-h-0 pt-8">
          <div className="px-6 pb-8">
            {tab === "general" && <GeneralSettings />}
            {tab === "channels" && <ChannelSettings />}
            {tab === "agent" && <AgentSettings />}
            {tab === "appearance" && <AppearanceSettings />}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
