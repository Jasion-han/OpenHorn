import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, ScrollArea, Textarea, cn } from 'ui';
import { Code } from 'lucide-react';
import { useIdeStore } from '../stores/ideStore';

type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; toolName?: string; toolInput?: unknown }
  | { type: 'tool_result'; content?: string }
  | { type: 'user_message'; userMessageId: string }
  | { type: 'done' }
  | { type: 'error'; content: string };

type ApprovalRequest = {
  runId: string;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  decisionReason?: string;
  blockedPath?: string;
};

export function AgentPane() {
  const client = useIdeStore((s) => s.client);

  const [prompt, setPrompt] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-3-5-sonnet-latest');
  const [baseUrl, setBaseUrl] = useState('');

  const [runningRunId, setRunningRunId] = useState<string | null>(null);
  const [output, setOutput] = useState('');
  const [checkpoints, setCheckpoints] = useState<string[]>([]);

  const [approval, setApproval] = useState<ApprovalRequest | null>(null);

  const startRun = async () => {
    if (!client) return;
    setOutput('');
    setCheckpoints([]);
    const res = await client.request<{ runId: string }>('agent.run', {
      prompt,
      apiKey,
      model,
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    });
    setRunningRunId(res.runId);
  };

  const rollback = async (runId: string) => {
    if (!client) return;
    await client.request('checkpoint.rollback', { runId });
    setOutput((v) => `${v}\n\n[checkpoint.rollback] ${runId}\n`);
  };

  const cancel = async () => {
    if (!client || !runningRunId) return;
    await client.request('agent.cancel', { runId: runningRunId });
  };

  const subscribeKey = useMemo(() => client, [client]);

  useEffect(() => {
    if (!subscribeKey) return;

    const offAgent = subscribeKey.on('agent.event', (data) => {
      const payload = data as { runId: string; event: AgentEvent };
      if (!payload?.event) return;

      if (payload.event.type === 'text') {
        const ev = payload.event as Extract<AgentEvent, { type: 'text' }>;
        setOutput((v) => v + ev.content);
      } else if (payload.event.type === 'tool_start') {
        const toolName = payload.event.toolName ?? '';
        setOutput((v) => `${v}\n\n[tool_start] ${toolName}\n`);
      } else if (payload.event.type === 'tool_result') {
        const ev = payload.event as Extract<AgentEvent, { type: 'tool_result' }>;
        const content = ev.content ?? '';
        setOutput((v) => `${v}\n\n[tool_result] ${content}\n`);
      } else if (payload.event.type === 'error') {
        const ev = payload.event as Extract<AgentEvent, { type: 'error' }>;
        setOutput((v) => `${v}\n\n[error] ${ev.content}\n`);
      } else if (payload.event.type === 'done') {
        setOutput((v) => `${v}\n\n[done]\n`);
        setRunningRunId(null);
      }
    });

    const offCheckpoint = subscribeKey.on('checkpoint.ready', (data) => {
      const payload = data as { runId: string };
      if (!payload?.runId) return;
      setCheckpoints((v) => (v.includes(payload.runId) ? v : [payload.runId, ...v]));
    });

    const offApproval = subscribeKey.on('approval.request', (data) => {
      const payload = data as ApprovalRequest;
      if (!payload?.toolUseId) return;
      setApproval(payload);
    });

    return () => {
      offAgent();
      offCheckpoint();
      offApproval();
    };
  }, [subscribeKey]);

  const sendApproval = async (allow: boolean) => {
    if (!client || !approval) return;
    await client.request('approvals.respond', { toolUseId: approval.toolUseId, allow });
    setApproval(null);
  };

  const canRun = Boolean(client && prompt.trim() && apiKey.trim() && !runningRunId);

  return (
    <div className="h-full min-h-0 flex flex-col p-3 gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">Agent (Claude only)</div>
        {runningRunId ? <span className="text-xs text-muted-foreground truncate">{runningRunId}</span> : null}
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-muted-foreground">Anthropic API Key</label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-ant-..."
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-2">
          <label className="text-xs text-muted-foreground">Model</label>
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-xs text-muted-foreground">Base URL (optional)</label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.anthropic.com"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-muted-foreground">Task</label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          className="resize-none"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => void startRun()} disabled={!canRun}>
          Run
        </Button>
        <Button variant="outline" onClick={() => void cancel()} disabled={!client || !runningRunId}>
          Cancel
        </Button>
      </div>

      {checkpoints.length > 0 && (
        <div className="rounded-xl border border-border/50 bg-background/50 p-2">
          <div className="text-xs text-muted-foreground mb-2">Checkpoints</div>
          <div className="flex flex-col gap-1">
            {checkpoints.map((id) => (
              <div key={id} className="flex items-center justify-between gap-2">
                <code className="text-xs text-foreground/80 truncate">{id}</code>
                <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => void rollback(id)}>
                  Rollback
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <pre className={cn(
            'rounded-2xl border border-border/50 bg-background/60 backdrop-blur-sm p-3',
            'text-xs font-mono whitespace-pre-wrap'
          )}>
            {output || 'No output yet.'}
          </pre>
        </ScrollArea>
      </div>

      <Dialog open={Boolean(approval)} onOpenChange={(o) => !o && setApproval(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve tool?</DialogTitle>
            <DialogDescription>
              {approval ? (
                <span className="inline-flex items-center gap-2">
                  <Code size={14} />
                  <span className="font-mono text-sm">{approval.toolName}</span>
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          {approval?.decisionReason ? (
            <p className="text-sm text-muted-foreground">{approval.decisionReason}</p>
          ) : null}
          {approval ? (
            <pre className="rounded-md border bg-background p-2 text-xs font-mono whitespace-pre-wrap">
              {JSON.stringify(approval.toolInput, null, 2)}
            </pre>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => void sendApproval(false)}>Deny</Button>
            <Button onClick={() => void sendApproval(true)}>Allow</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
