import { Info, Palette, PlugZap } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { cn, ScrollArea } from "ui";
import { AboutSettings } from "./AboutSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { ChannelSettings } from "./ChannelSettings";

type SettingsTab = "channels" | "appearance" | "about";

const TABS: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
  { id: "channels", label: "渠道", icon: <PlugZap size={16} /> },
  { id: "appearance", label: "外观", icon: <Palette size={16} /> },
  { id: "about", label: "关于", icon: <Info size={16} /> },
];

export function SettingsView({ initialTab = "channels" }: { initialTab?: SettingsTab }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  const content = useMemo(() => {
    switch (activeTab) {
      case "channels":
        return <ChannelSettings />;
      case "appearance":
        return <AppearanceSettings />;
      case "about":
        return <AboutSettings />;
    }
  }, [activeTab]);

  return (
    <div className="flex h-full">
      <div className="w-[180px] border-r border-border/50 pt-8 px-2">
        <h2 className="text-xs font-medium text-muted-foreground px-3 mb-2 uppercase tracking-wider">
          设置
        </h2>
        <nav className="flex flex-col gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors titlebar-no-drag",
                activeTab === tab.id
                  ? "bg-muted text-foreground font-medium"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
      </div>

      <ScrollArea className="flex-1 pt-8">
        <div className="px-6 pb-8">{content}</div>
      </ScrollArea>
    </div>
  );
}
