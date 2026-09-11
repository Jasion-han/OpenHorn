import {
  Bot,
  Download,
  HardDrive,
  KeyRound,
  Palette,
  Plug,
  Radio,
  Settings,
  Sparkles,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { cn, ScrollArea } from "ui";
import {
  getCredentialLabel,
  getDataTransferLabel,
  getSettingsViewLabel,
} from "../../lib/i18n/agent";
import {
  type DesktopSettingsTab as SettingsTab,
  useDesktopShellStore,
} from "../../stores/desktopShellStore";
import { AgentSettings } from "./AgentSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { ChannelSettings } from "./ChannelSettings";
import { DataTransferSettings } from "./DataTransferSettings";
import { DesktopCredentialSourcesPanel } from "./DesktopCredentialSourcesPanel";
import { GeneralSettings } from "./GeneralSettings";
import { ImportSettings } from "./ImportSettings";
import { McpSettings } from "./McpSettings";
import { SkillSettings } from "./SkillSettings";

const TABS: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
  {
    id: "general",
    label: getSettingsViewLabel("settings.view.tab.general"),
    icon: <Settings size={16} />,
  },
  {
    id: "import",
    label: getSettingsViewLabel("settings.view.tab.import"),
    icon: <Download size={16} />,
  },
  {
    id: "channels",
    label: getSettingsViewLabel("settings.view.tab.channels"),
    icon: <Radio size={16} />,
  },
  {
    id: "credentials",
    label: getCredentialLabel("settings.credentialSources"),
    icon: <KeyRound size={16} />,
  },
  { id: "agent", label: "Agent", icon: <Bot size={16} /> },
  { id: "mcp", label: "MCP", icon: <Plug size={16} /> },
  { id: "skill", label: "Skill", icon: <Sparkles size={16} /> },
  {
    id: "data",
    label: getDataTransferLabel("settings.view.tab.data"),
    icon: <HardDrive size={16} />,
  },
  {
    id: "appearance",
    label: getSettingsViewLabel("settings.view.tab.appearance"),
    icon: <Palette size={16} />,
  },
];

function TabContent({ id }: { id: SettingsTab }) {
  switch (id) {
    case "general":
      return <GeneralSettings />;
    case "import":
      return <ImportSettings />;
    case "channels":
      return <ChannelSettings />;
    case "credentials":
      return <DesktopCredentialSourcesPanel />;
    case "agent":
      return <AgentSettings />;
    case "mcp":
      return <McpSettings />;
    case "skill":
      return <SkillSettings />;
    case "data":
      return <DataTransferSettings />;
    case "appearance":
      return <AppearanceSettings />;
  }
}

export function SettingsView({ initialTab = "channels" }: { initialTab?: SettingsTab }) {
  const activeTab = useDesktopShellStore((state) => state.settingsTab);
  const setActiveTab = useDesktopShellStore((state) => state.setSettingsTab);
  const resolvedTab = TABS.some((tab) => tab.id === activeTab) ? activeTab : initialTab;
  const [visited, setVisited] = useState<Set<SettingsTab>>(new Set([resolvedTab]));

  // Tabs can also be switched from outside the nav (e.g. the import history's
  // "open in MCP" action writes the store directly); keep those alive too.
  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(resolvedTab)) return prev;
      const next = new Set(prev);
      next.add(resolvedTab);
      return next;
    });
  }, [resolvedTab]);

  const handleTabClick = (tabId: SettingsTab) => {
    setActiveTab(tabId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div data-tauri-drag-region className="shrink-0" style={{ height: "24px" }} />
      <div className="flex flex-1 min-h-0 w-full">
        <div className="w-[180px] shrink-0 border-r border-border/50 px-2">
          <h2 className="text-xs font-medium text-muted-foreground px-3 mb-2 uppercase tracking-wider">
            {getSettingsViewLabel("settings.view.title")}
          </h2>
          <nav className="flex flex-col gap-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleTabClick(tab.id)}
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

        <div className="flex-1 min-h-0 relative">
          {TABS.map((tab) => {
            if (!visited.has(tab.id) && tab.id !== resolvedTab) return null;
            return (
              <div
                key={tab.id}
                className="absolute inset-0"
                style={{ display: resolvedTab === tab.id ? "block" : "none" }}
              >
                <ScrollArea className="h-full">
                  <div className="mx-auto max-w-3xl px-6 pb-8">
                    <TabContent id={tab.id} />
                  </div>
                </ScrollArea>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
