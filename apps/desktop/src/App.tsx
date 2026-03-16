import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Input, Badge, cn } from 'ui';
import { AlertTriangle, ArrowLeft, Settings as SettingsIcon } from 'lucide-react';
import { SidecarClient } from './lib/sidecarClient';
import { FileTree } from './components/FileTree';
import { EditorPane } from './components/EditorPane';
import { AgentPane } from './components/AgentPane';
import { useIdeStore } from './stores/ideStore';
import { SettingsView } from './components/settings/SettingsView';
import { ThemeListener } from './components/theme/ThemeListener';
import { readSavedWorkspaceRoot } from './components/settings/DesktopGeneralSettings';

function Panel({
  children,
  className,
  width,
}: {
  children: ReactNode;
  className?: string;
  width?: number;
}) {
  return (
    <div
      className={cn(
        'h-full min-h-0 rounded-2xl border border-border/50 bg-background/70 backdrop-blur-sm shadow-minimal overflow-hidden',
        className
      )}
      style={width ? { width, flexShrink: 0 } : undefined}
    >
      {children}
    </div>
  );
}

export function App() {
  const [activeView, setActiveView] = useState<'main' | 'settings'>('main');
  const sidecarStatus = useIdeStore((s) => s.sidecarStatus);
  const sidecarError = useIdeStore((s) => s.sidecarError);
  const client = useIdeStore((s) => s.client);
  const workspaceRootInput = useIdeStore((s) => s.workspaceRootInput);
  const setWorkspaceRootInput = useIdeStore((s) => s.setWorkspaceRootInput);
  const setSidecarStatus = useIdeStore((s) => s.setSidecarStatus);
  const setSidecarError = useIdeStore((s) => s.setSidecarError);
  const setClient = useIdeStore((s) => s.setClient);
  const loadDir = useIdeStore((s) => s.loadDir);

  const connect = useMemo(
    () => async () => {
      setSidecarStatus('loading');
      setSidecarError('');

      try {
        const info = await invoke<{ ws_url: string; token: string } | null>('get_sidecar_info');
        if (!info) throw new Error('Sidecar not ready');

        const nextClient = new SidecarClient({ wsUrl: info.ws_url, token: info.token });
        await nextClient.connect();
        setClient(nextClient);
        setSidecarStatus('connected');
      } catch (error) {
        setClient(null);
        setSidecarStatus('error');
        setSidecarError(error instanceof Error ? error.message : 'Failed to connect');
      }
    },
    [setClient, setSidecarError, setSidecarStatus]
  );

  useEffect(() => {
    void connect();
  }, [connect]);

  useEffect(() => {
    const saved = readSavedWorkspaceRoot();
    if (saved) setWorkspaceRootInput(saved);
  }, [setWorkspaceRootInput]);

  const openWorkspace = async () => {
    if (!client) return;
    await client.request('workspace.setCurrent', { root: workspaceRootInput });
    await loadDir('.');
  };

  const statusBadge = (() => {
    if (sidecarStatus === 'connected') return <Badge variant="secondary">connected</Badge>;
    if (sidecarStatus === 'loading') return <Badge variant="outline">loading</Badge>;
    if (sidecarStatus === 'error') return <Badge variant="destructive">error</Badge>;
    return <Badge variant="outline">{sidecarStatus}</Badge>;
  })();

  return (
    <div className="h-screen w-screen overflow-hidden bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:to-zinc-900">
      <ThemeListener />
      <header className="h-12 shrink-0 flex items-center justify-between px-4">
        <div className="flex items-center gap-3 min-w-0">
          {activeView === 'settings' && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="titlebar-no-drag"
              onClick={() => setActiveView('main')}
              aria-label="Back"
              title="Back"
            >
              <ArrowLeft size={16} />
            </Button>
          )}
          <div className="font-semibold">{activeView === 'settings' ? '设置' : 'OpenHorn'}</div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Sidecar</span>
            {statusBadge}
          </div>
          {sidecarStatus === 'error' && (
            <div className="hidden md:flex items-center gap-2 min-w-0">
              <AlertTriangle size={14} className="text-destructive shrink-0" />
              <span className="text-xs text-destructive truncate">{sidecarError}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {activeView === 'main' && (
            <>
              <Input
                placeholder="Workspace root (paste path)"
                value={workspaceRootInput}
                onChange={(e) => setWorkspaceRootInput(e.target.value)}
                className="w-[420px] h-8 text-xs"
              />
              <Button
                size="sm"
                onClick={() => void openWorkspace()}
                disabled={!client || !workspaceRootInput.trim()}
              >
                Load
              </Button>
              <Button size="sm" variant="outline" onClick={() => void connect()}>
                Reconnect
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="titlebar-no-drag"
            onClick={() => setActiveView((v) => (v === 'settings' ? 'main' : 'settings'))}
            aria-label="Settings"
            title="Settings"
          >
            <SettingsIcon size={16} />
          </Button>
        </div>
      </header>

      {activeView === 'settings' ? (
        <div className="h-[calc(100vh-48px)] p-2 min-h-0">
          <div className="h-full rounded-2xl border border-border/50 bg-background/70 backdrop-blur-sm shadow-minimal overflow-hidden">
            <SettingsView />
          </div>
        </div>
      ) : (
        <div className="h-[calc(100vh-48px)] p-2 flex gap-2 min-h-0">
          <Panel width={320}>
            <FileTree />
          </Panel>
          <Panel className="flex-1 min-w-0">
            <EditorPane />
          </Panel>
          <Panel width={420}>
            <AgentPane />
          </Panel>
        </div>
      )}
    </div>
  );
}
