import Editor from "@monaco-editor/react";
import { Save, X } from "lucide-react";
import { Button, cn, ScrollArea } from "ui";
import { useIsDarkTheme } from "../hooks/useIsDarkTheme";
import { baseName, languageFromPath, useIdeStore } from "../stores/ideStore";

function TabButton({
  active,
  label,
  dirty,
  onClick,
  onClose,
}: {
  active: boolean;
  label: string;
  dirty: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex items-center gap-2 rounded-[10px] px-3 py-1.5 text-[13px] leading-5 transition-colors whitespace-nowrap titlebar-no-drag",
        active
          ? "bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]"
          : "text-foreground/70 hover:bg-foreground/[0.04]",
      )}
    >
      <span className="max-w-[180px] truncate">
        {label}
        {dirty ? " *" : ""}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="h-6 w-6 opacity-0 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close tab"
      >
        <X size={12} />
      </Button>
    </button>
  );
}

export function EditorPane() {
  const tabs = useIdeStore((s) => s.tabs);
  const activePath = useIdeStore((s) => s.activePath);
  const setActivePath = useIdeStore((s) => s.setActivePath);
  const updateActiveContent = useIdeStore((s) => s.updateActiveContent);
  const saveActiveFile = useIdeStore((s) => s.saveActiveFile);
  const closeTab = useIdeStore((s) => s.closeTab);
  const isDark = useIsDarkTheme();

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="px-3 pt-3 pb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">Editor</div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void saveActiveFile()}
          disabled={!activeTab || !activeTab.dirty}
          aria-label="Save"
        >
          <Save size={16} />
        </Button>
      </div>

      {tabs.length === 0 ? (
        <div className="px-3 pb-3 text-sm text-muted-foreground">Open a file from the tree.</div>
      ) : (
        <div className="px-2 pb-2">
          <ScrollArea className="w-full">
            <div className="flex items-center gap-1 pr-3">
              {tabs.map((tab) => (
                <TabButton
                  key={tab.path}
                  active={tab.path === activePath}
                  label={baseName(tab.path)}
                  dirty={Boolean(tab.dirty)}
                  onClick={() => setActivePath(tab.path)}
                  onClose={() => closeTab(tab.path)}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
      )}

      <div className="flex-1 min-h-0 px-2 pb-2">
        <div className="h-full w-full rounded-2xl border border-border/50 bg-background/70 backdrop-blur-sm overflow-hidden">
          {activeTab ? (
            <Editor
              height="100%"
              language={languageFromPath(activeTab.path)}
              value={activeTab.content}
              onChange={(v) => updateActiveContent(v ?? "")}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                tabSize: 2,
                scrollBeyondLastLine: false,
              }}
              theme={isDark ? "vs-dark" : "vs"}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
