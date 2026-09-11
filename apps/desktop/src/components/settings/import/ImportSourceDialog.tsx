import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LocalImportConversationSummary } from "shared/types";
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
} from "ui";
import {
  formatImportLabel,
  getImportLabel,
  getImportPartLabel,
  getImportSourceLabel,
} from "../../../lib/i18n/agent";
import { notifyError } from "../../../lib/notify";
import {
  type ImportRunOutcome,
  type ImportSelection,
  type ImportSourceSummary,
  isLocalImportServerSource,
  useImportStore,
} from "../../../stores/importStore";

type PartKey = "conversations" | "instructions" | "prompts" | "mcp" | "skills" | "credentials";

const PART_ORDER: PartKey[] = [
  "conversations",
  "instructions",
  "prompts",
  "mcp",
  "skills",
  "credentials",
];

type Phase = "select" | "running" | "done";

function toggleIn<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function formatDate(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString();
}

/** Group session rows by working directory, most recently updated first. */
function groupByCwd(
  rows: LocalImportConversationSummary[],
): Array<{ cwd: string | null; rows: LocalImportConversationSummary[] }> {
  const groups = new Map<string | null, LocalImportConversationSummary[]>();
  for (const row of rows) {
    const list = groups.get(row.cwd) ?? [];
    list.push(row);
    groups.set(row.cwd, list);
  }
  return [...groups.entries()]
    .map(([cwd, list]) => ({
      cwd,
      rows: [...list].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => (b.rows[0]?.updatedAt ?? 0) - (a.rows[0]?.updatedAt ?? 0));
}

/** One selectable row shared by the MCP / skill / credential entry lists. */
function EntryRow({
  id,
  label,
  meta,
  badge,
  checked,
  disabled,
  onToggle,
}: {
  id: string;
  label: string;
  meta?: string;
  badge?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-lg px-2 py-1.5",
        disabled ? "opacity-60" : "cursor-pointer hover:bg-muted/50",
      )}
    >
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onToggle}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm">{label}</span>
          {badge ? (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {badge}
            </span>
          ) : null}
        </div>
        {meta ? <p className="truncate text-xs text-muted-foreground">{meta}</p> : null}
      </div>
    </label>
  );
}

export function ImportSourceDialog({
  summary,
  open,
  onOpenChange,
  onDone,
}: {
  summary: ImportSourceSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the ids of the records the run produced (may be empty). */
  onDone: (recordIds: string[]) => void;
}) {
  const runImport = useImportStore((state) => state.runImport);
  const progress = useImportStore((state) => state.progress);
  const conversationLists = useImportStore((state) => state.conversationLists);
  const conversationListLoading = useImportStore((state) => state.conversationListLoading);
  const loadConversationList = useImportStore((state) => state.loadConversationList);

  const source = summary?.source ?? null;
  const serverSource = source && isLocalImportServerSource(source) ? source : null;
  const conversationRows = serverSource ? (conversationLists[serverSource] ?? null) : null;

  const [phase, setPhase] = useState<Phase>("select");
  const [outcome, setOutcome] = useState<ImportRunOutcome | null>(null);
  const [parts, setParts] = useState<Set<PartKey>>(new Set());
  const [expanded, setExpanded] = useState<PartKey | null>(null);
  const [sessions, setSessions] = useState<Set<string>>(new Set());
  const [sessionsSeeded, setSessionsSeeded] = useState(false);
  const [mcp, setMcp] = useState<Set<string>>(new Set());
  const [skills, setSkills] = useState<Set<string>>(new Set());
  const [credentials, setCredentials] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  // Reset selection whenever a (new) source is opened. Keyed on `source`, not
  // the summary object: runImport ends with a rescan that rebuilds `sources`,
  // and a reset on that identity change would wipe the "done" phase.
  // biome-ignore lint/correctness/useExhaustiveDependencies: open/source are the triggers; summary is read via closure on purpose
  useEffect(() => {
    if (!open || !summary) return;
    const initial = new Set<PartKey>();
    if (summary.conversations && summary.conversations.count > 0) initial.add("conversations");
    if (summary.instructions && summary.instructions.count > 0) initial.add("instructions");
    if (summary.prompts && summary.prompts.count > 0) initial.add("prompts");
    if (summary.mcp && summary.mcp.newCount > 0) initial.add("mcp");
    if (summary.skills && summary.skills.newCount > 0) initial.add("skills");
    if (summary.credentials && summary.credentials.newCount > 0) initial.add("credentials");
    setParts(initial);
    setMcp(new Set(summary.mcp?.entries.filter((e) => !e.exists).map((e) => e.signature) ?? []));
    setSkills(new Set(summary.skills?.entries.filter((e) => !e.enabled).map((e) => e.name) ?? []));
    setCredentials(
      new Set(
        summary.credentials?.entries.filter((e) => e.importable && !e.exists).map((e) => e.id) ??
          [],
      ),
    );
    setSessions(new Set());
    setSessionsSeeded(false);
    setExpanded(null);
    setQuery("");
    setPhase("select");
    setOutcome(null);
    if (serverSource && summary.conversations && summary.conversations.count > 0) {
      void loadConversationList(serverSource);
    }
  }, [open, source]);

  // Default-select every not-yet-imported session once the list arrives.
  useEffect(() => {
    if (sessionsSeeded || !conversationRows) return;
    setSessions(new Set(conversationRows.filter((row) => !row.alreadyImported).map((r) => r.id)));
    setSessionsSeeded(true);
  }, [conversationRows, sessionsSeeded]);

  const filteredGroups = useMemo(() => {
    if (!conversationRows) return [];
    const q = query.trim().toLowerCase();
    const rows = q
      ? conversationRows.filter(
          (row) => row.title.toLowerCase().includes(q) || (row.cwd ?? "").toLowerCase().includes(q),
        )
      : conversationRows;
    return groupByCwd(rows);
  }, [conversationRows, query]);

  const selectedCount = useMemo(() => {
    if (!summary) return 0;
    let count = 0;
    if (parts.has("conversations")) count += sessions.size;
    if (parts.has("instructions")) count += summary.instructions?.count ?? 0;
    if (parts.has("prompts")) count += summary.prompts?.count ?? 0;
    if (parts.has("mcp")) count += mcp.size;
    if (parts.has("skills")) count += skills.size;
    if (parts.has("credentials")) count += credentials.size;
    return count;
  }, [summary, parts, sessions, mcp, skills, credentials]);

  if (!summary || !source) return null;

  const partCount = (key: PartKey): number => {
    switch (key) {
      case "conversations":
        return summary.conversations?.count ?? 0;
      case "instructions":
        return summary.instructions?.count ?? 0;
      case "prompts":
        return summary.prompts?.count ?? 0;
      case "mcp":
        return summary.mcp?.entries.length ?? 0;
      case "skills":
        return summary.skills?.entries.length ?? 0;
      case "credentials":
        return summary.credentials?.entries.length ?? 0;
    }
  };
  const hasPart = (key: PartKey): boolean => {
    switch (key) {
      case "conversations":
        return Boolean(summary.conversations && summary.conversations.count > 0);
      case "instructions":
        return Boolean(summary.instructions && summary.instructions.count > 0);
      case "prompts":
        return Boolean(summary.prompts && summary.prompts.count > 0);
      case "mcp":
        return Boolean(summary.mcp && summary.mcp.entries.length > 0);
      case "skills":
        return Boolean(summary.skills && summary.skills.entries.length > 0);
      case "credentials":
        return Boolean(summary.credentials && summary.credentials.entries.length > 0);
    }
  };
  const expandable = (key: PartKey) =>
    key === "conversations" || key === "mcp" || key === "skills" || key === "credentials";

  const handleConfirm = async () => {
    if (selectedCount === 0) {
      notifyError(
        getImportLabel("import.dialog.failedTitle"),
        getImportLabel("import.dialog.nothingSelected"),
      );
      return;
    }
    const selection: ImportSelection = {};
    if (parts.has("conversations") && sessions.size > 0) selection.conversations = [...sessions];
    if (parts.has("instructions")) selection.instructions = true;
    if (parts.has("prompts")) selection.prompts = true;
    if (parts.has("mcp") && mcp.size > 0) selection.mcp = [...mcp];
    if (parts.has("skills") && skills.size > 0) selection.skills = [...skills];
    if (parts.has("credentials") && credentials.size > 0) selection.credentials = [...credentials];
    setPhase("running");
    try {
      const result = await runImport(source, selection);
      setOutcome(result);
      setPhase("done");
    } catch (error) {
      notifyError(
        getImportLabel("import.dialog.failedTitle"),
        error instanceof Error ? error.message : String(error),
      );
      setPhase("select");
    }
  };

  const totals = outcome
    ? outcome.parts.reduce(
        (acc, part) => ({
          imported: acc.imported + part.imported,
          skipped: acc.skipped + part.skipped,
          needsAction: acc.needsAction + part.needsAction,
        }),
        { imported: 0, skipped: 0, needsAction: 0 },
      )
    : null;

  const renderConversationList = () => {
    if (!conversationRows) {
      return (
        <p className="p-3 text-xs text-muted-foreground">
          {conversationListLoading === serverSource
            ? getImportLabel("import.dialog.conversationsLoading")
            : getImportLabel("import.detected.summaryEmpty")}
        </p>
      );
    }
    const all = conversationRows.map((row) => row.id);
    const fresh = conversationRows.filter((row) => !row.alreadyImported).map((row) => row.id);
    return (
      <div className="flex w-full min-w-0 flex-col gap-2 p-2">
        <div className="flex min-w-0 items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={getImportLabel("import.dialog.conversationsSearch")}
            className="h-8 min-w-0 flex-1 text-xs"
          />
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => setSessions(new Set(all))}
          >
            {getImportLabel("import.dialog.selectAll")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => setSessions(new Set(fresh))}
          >
            {getImportLabel("import.dialog.selectNew")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => setSessions(new Set())}
          >
            {getImportLabel("import.dialog.selectNone")}
          </Button>
        </div>
        <p className="truncate px-2 text-xs text-muted-foreground">
          {formatImportLabel("import.dialog.conversationsHint", {
            total: conversationRows.length,
            selected: sessions.size,
          })}
        </p>
        {/* max-h must sit on the viewport: on the Root it only clips (viewport is
            h-full of an auto-height parent) and nothing scrolls. */}
        <ScrollArea className="w-full min-w-0 [&>[data-radix-scroll-area-viewport]]:max-h-[260px]">
          <div className="flex min-w-0 flex-col gap-1">
            {filteredGroups.map((group) => (
              <div key={group.cwd ?? "__none"} className="flex min-w-0 flex-col">
                <p className="truncate px-2 pt-1 font-mono text-[11px] text-muted-foreground">
                  {group.cwd ?? getImportLabel("import.dialog.noCwd")}
                </p>
                {group.rows.map((row) => (
                  <EntryRow
                    key={row.id}
                    id={`import-session-${row.id}`}
                    label={row.title}
                    meta={formatDate(row.updatedAt)}
                    badge={
                      row.alreadyImported
                        ? getImportLabel("import.dialog.alreadyImported")
                        : undefined
                    }
                    checked={sessions.has(row.id)}
                    onToggle={() => setSessions((prev) => toggleIn(prev, row.id))}
                  />
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    );
  };

  const renderEntryList = (key: PartKey) => {
    if (key === "conversations") return renderConversationList();
    if (key === "mcp" && summary.mcp) {
      return (
        <ScrollArea className="w-full min-w-0 [&>[data-radix-scroll-area-viewport]]:max-h-[220px]">
          <div className="flex min-w-0 flex-col gap-1 p-2">
            {summary.mcp.entries.map((entry) => (
              <EntryRow
                key={entry.signature}
                id={`import-mcp-${entry.signature}`}
                label={entry.name}
                meta={formatImportLabel("import.detail.clients", {
                  clients: entry.clients.join(" · "),
                })}
                badge={entry.exists ? getImportLabel("import.dialog.alreadyExists") : undefined}
                checked={mcp.has(entry.signature)}
                onToggle={() => setMcp((prev) => toggleIn(prev, entry.signature))}
              />
            ))}
          </div>
        </ScrollArea>
      );
    }
    if (key === "skills" && summary.skills) {
      return (
        <ScrollArea className="w-full min-w-0 [&>[data-radix-scroll-area-viewport]]:max-h-[220px]">
          <div className="flex min-w-0 flex-col gap-1 p-2">
            {summary.skills.entries.map((entry) => (
              <EntryRow
                key={entry.path}
                id={`import-skill-${entry.name}`}
                label={entry.name}
                meta={entry.description}
                badge={entry.enabled ? getImportLabel("import.dialog.alreadyEnabled") : undefined}
                checked={skills.has(entry.name)}
                onToggle={() => setSkills((prev) => toggleIn(prev, entry.name))}
              />
            ))}
          </div>
        </ScrollArea>
      );
    }
    if (key === "credentials" && summary.credentials) {
      return (
        <div className="flex min-w-0 flex-col gap-1 p-2">
          <p className="px-2 text-xs text-muted-foreground">
            {getImportLabel("import.dialog.credentialsHint")}
          </p>
          {summary.credentials.entries.map((entry) => (
            <EntryRow
              key={entry.id}
              id={`import-credential-${entry.id}`}
              label={entry.sourceName}
              meta={entry.provider}
              badge={
                entry.exists
                  ? getImportLabel("import.dialog.alreadyExists")
                  : !entry.importable
                    ? getImportLabel("import.detail.credentialEnvOnly")
                    : undefined
              }
              checked={credentials.has(entry.id)}
              disabled={!entry.importable}
              onToggle={() => setCredentials((prev) => toggleIn(prev, entry.id))}
            />
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <Dialog open={open} onOpenChange={(next) => phase !== "running" && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {formatImportLabel("import.dialog.title", { source: getImportSourceLabel(source) })}
          </DialogTitle>
          <DialogDescription>{getImportLabel("import.dialog.description")}</DialogDescription>
        </DialogHeader>

        {/* DialogContent is a grid; without min-w-0 the 1fr track grows to the
            list's min-content width (nowrap paths / buttons) and overflows the
            dialog instead of truncating. */}
        {phase === "select" ? (
          <div className="flex w-full min-w-0 flex-col gap-1 rounded-xl border border-border/50">
            {PART_ORDER.filter(hasPart).map((key) => {
              const checkboxId = `import-part-${key}`;
              const isOpen = expanded === key;
              return (
                <div key={key} className="min-w-0 border-b border-border/40 last:border-b-0">
                  <div className="flex min-w-0 items-center gap-3 px-3 py-2">
                    <Checkbox
                      id={checkboxId}
                      checked={parts.has(key)}
                      onCheckedChange={() => setParts((prev) => toggleIn(prev, key))}
                    />
                    <label
                      htmlFor={checkboxId}
                      className="min-w-0 flex-1 cursor-pointer truncate text-sm"
                    >
                      {formatImportLabel("import.dialog.partRow", {
                        part: getImportPartLabel(key),
                        count: partCount(key),
                      })}
                      {key === "instructions" && summary.instructions?.path ? (
                        <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                          {formatImportLabel("import.dialog.instructionsPath", {
                            path: summary.instructions.path,
                          })}
                        </span>
                      ) : null}
                    </label>
                    {expandable(key) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        onClick={() => setExpanded(isOpen ? null : key)}
                      >
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {isOpen
                          ? getImportLabel("import.dialog.conversationsCollapse")
                          : key === "conversations"
                            ? getImportLabel("import.dialog.conversationsExpand")
                            : getImportLabel("import.dialog.entriesExpand")}
                      </Button>
                    ) : null}
                  </div>
                  {isOpen ? renderEntryList(key) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {phase === "running" ? (
          <div className="flex items-center gap-3 rounded-xl border border-border/50 p-4 text-sm">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
            <span>
              {progress?.desktop
                ? getImportLabel("import.dialog.progressDesktop")
                : formatImportLabel("import.dialog.progress", {
                    done: progress?.done ?? 0,
                    total: progress?.total ?? 0,
                  })}
            </span>
          </div>
        ) : null}

        {phase === "done" && outcome && totals ? (
          <div className="flex flex-col gap-2 rounded-xl border border-border/50 p-4 text-sm">
            <p className="font-medium">{getImportLabel("import.dialog.resultTitle")}</p>
            <p className="text-muted-foreground">
              {formatImportLabel("import.dialog.resultSummary", totals)}
            </p>
            {outcome.errors.length > 0 ? (
              <details className="text-xs text-destructive">
                <summary>
                  {formatImportLabel("import.dialog.resultErrors", {
                    count: outcome.errors.length,
                  })}
                </summary>
                <ul className="mt-1 list-disc pl-4">
                  {outcome.errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {phase === "done" ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {getImportLabel("import.dialog.close")}
              </Button>
              <Button onClick={() => onDone(outcome?.recordIds ?? [])}>
                {getImportLabel("import.dialog.viewRecord")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={phase === "running"}
              >
                {getImportLabel("import.dialog.cancel")}
              </Button>
              <Button
                onClick={() => void handleConfirm()}
                disabled={phase === "running" || selectedCount === 0}
              >
                {formatImportLabel("import.dialog.confirm", { count: selectedCount })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
