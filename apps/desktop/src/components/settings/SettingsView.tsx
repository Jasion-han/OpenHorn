import { Bot, Palette, Radio, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { cn, ScrollArea } from "ui";
import {
  useDesktopShellStore,
  type DesktopSettingsTab as SettingsTab,
} from "../../stores/desktopShellStore";
import { AgentSettings } from "./AgentSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { ChannelSettings } from "./ChannelSettings";
import { GeneralSettings } from "./GeneralSettings";

const TABS: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
  { id: "general", label: "通用", icon: <Settings size={16} /> },
  { id: "channels", label: "渠道", icon: <Radio size={16} /> },
  { id: "agent", label: "Agent", icon: <Bot size={16} /> },
  { id: "appearance", label: "外观", icon: <Palette size={16} /> },
];

export function SettingsView({ initialTab = "channels" }: { initialTab?: SettingsTab }) {
  const activeTab = useDesktopShellStore((state) => state.settingsTab);
  const setActiveTab = useDesktopShellStore((state) => state.setSettingsTab);

  const content = useMemo(() => {
    switch (activeTab) {
      case "general":
        return <GeneralSettings />;
      case "channels":
        return <ChannelSettings />;
      case "agent":
        return <AgentSettings />;
      case "appearance":
        return <AppearanceSettings />;
    }
  }, [activeTab]);

  const resolvedTab = TABS.some((tab) => tab.id === activeTab) ? activeTab : initialTab;

  return (
    <div className="h-full min-h-0">
      <div className="flex h-full min-h-0 w-full">
        <div className="w-[180px] shrink-0 border-r border-border/50 px-2 pt-8">
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
                  resolvedTab === tab.id
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

        <ScrollArea className="flex-1 min-h-0 pt-8">
          <div className="px-6 pb-8">{content}</div>
        </ScrollArea>
      </div>
    </div>
  );
}
