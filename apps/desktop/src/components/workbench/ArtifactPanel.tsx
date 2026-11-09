import {
  Download,
  ExternalLink,
  FileText,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArtifactDetail, ArtifactVersion, SavedArtifact } from "shared/types";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Textarea,
} from "ui";
import { saveAttachment } from "../../lib/attachmentPreview";
import { formatWorkbenchLabel, getWorkbenchLabel } from "../../lib/i18n/agent";
import { workbenchApi, workbenchError } from "../../lib/workbenchApi";
import { useArtifactDraftStore } from "../../stores/artifactDraftStore";
import { DesktopMarkdownMessage } from "../chat/DesktopMarkdownMessage";
import { DiscardChangesDialog } from "./DiscardChangesDialog";

export interface ArtifactPanelProps {
  refreshToken?: number;
  onContinue: (artifact: SavedArtifact, version: ArtifactVersion) => void | Promise<void>;
  onOpenSource: (conversationId: string) => void | Promise<void>;
}
const selectClass =
  "h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";
const formats = { markdown: "Markdown", html: "HTML", openui: "OpenUI" } as const;

/** The ordinary message renderer owns all generated UI execution and sandboxing. */
export function artifactPreviewContent(
  version: Pick<ArtifactVersion, "format" | "content">,
): string {
  if (version.format === "markdown") return version.content;
  const tick = String.fromCharCode(96);
  const longest = (version.content.match(new RegExp(`${tick}+`, "g")) ?? []).reduce(
    (maximum, run) => Math.max(maximum, run.length),
    2,
  );
  const fence = tick.repeat(longest + 1);
  return `${fence + (version.format === "html" ? "html-ui" : "openui-lang")}\n${version.content}\n${fence}`;
}

export function ArtifactPanel({ refreshToken = 0, onContinue, onOpenSource }: ArtifactPanelProps) {
  const [artifacts, setArtifacts] = useState<SavedArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => useArtifactDraftStore.getState().selectedId,
  );
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(() => {
    const state = useArtifactDraftStore.getState();
    return state.selectedId ? state.drafts[state.selectedId]?.sourceVersion : undefined;
  });
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [raw, setRaw] = useState(false);
  const edits = useArtifactDraftStore((state) => state.drafts);
  const editDraft = selectedId ? edits[selectedId] : undefined;
  const editing = !!editDraft;
  const draft = editDraft?.content ?? "";
  const draftFormat = editDraft?.format ?? "markdown";
  const changed =
    !!editDraft &&
    (draft !== editDraft.originalContent || draftFormat !== editDraft.originalFormat);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const listRequest = useRef(0);
  const operation = useRef(false);
  const loadedRefresh = useRef(refreshToken);
  const detailIdentity = useRef("");
  const detailRequest = useRef("");
  const refreshDraftBaseline = useRef<{ id: string | null; revision: number } | null>(null);
  const updateDraft = (patch: Partial<Pick<ArtifactVersion, "content" | "format">>) => {
    if (selectedId && editDraft)
      useArtifactDraftStore.getState().put(selectedId, { ...editDraft, ...patch });
  };
  const discardDraft = () => {
    if (selectedId) useArtifactDraftStore.getState().discard(selectedId);
    setConfirmDiscard(false);
  };
  const loadList = useCallback(async () => {
    const request = ++listRequest.current;
    setLoading(true);
    setListError("");
    try {
      const response = await workbenchApi.artifacts.list();
      if (request !== listRequest.current) return;
      setArtifacts(response.artifacts);
      setSelectedId((current) =>
        response.artifacts.some((item) => item.id === current)
          ? current
          : (response.artifacts[0]?.id ?? null),
      );
    } catch (error) {
      if (request === listRequest.current) setListError(workbenchError(error));
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (loadedRefresh.current !== refreshToken) setDetailRefresh((value) => value + 1);
    loadedRefresh.current = refreshToken;
    void loadList();
    return () => {
      listRequest.current++;
    };
  }, [loadList, refreshToken]);
  useEffect(() => {
    useArtifactDraftStore.getState().select(selectedId);
  }, [selectedId]);
  useEffect(() => {
    const requestKey = JSON.stringify([selectedId, selectedVersion, detailRefresh]);
    detailRequest.current = requestKey;
    const identity = JSON.stringify([selectedId, selectedVersion]);
    if (detailIdentity.current !== identity) {
      setRenaming(false);
      setConfirmDelete(false);
      setConfirmDiscard(false);
      detailIdentity.current = identity;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError("");
    setActionError("");
    if (!selectedId) {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    void workbenchApi.artifacts
      .detail(selectedId, selectedVersion)
      .then((response) => {
        if (cancelled || detailRequest.current !== requestKey) return;
        setDetail(response);
        const refresh = refreshDraftBaseline.current;
        if (refresh?.id === selectedId && refresh?.revision === detailRefresh) {
          refreshDraftBaseline.current = null;
          const store = useArtifactDraftStore.getState();
          const current = store.drafts[selectedId];
          if (current)
            store.put(selectedId, {
              ...current,
              expectedVersion: response.artifact.currentVersion,
            });
        }
      })
      .catch((error) => {
        if (!cancelled) setDetailError(workbenchError(error));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedVersion, detailRefresh]);
  const act = async (name: string, work: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(name);
    setActionError("");
    try {
      await work();
    } catch (error) {
      setActionError(workbenchError(error));
    } finally {
      operation.current = false;
      setBusy(null);
    }
  };
  const saveVersion = () => {
    if (!detail || !draft.trim()) return;
    const owner = useArtifactDraftStore.getState().ownerId;
    void act("save", async () => {
      const result = await workbenchApi.artifacts.append(detail.artifact.id, {
        expectedVersion: editDraft?.expectedVersion ?? detail.artifact.currentVersion,
        content: draft,
        format: draftFormat,
      });
      if (owner !== useArtifactDraftStore.getState().ownerId) return;
      if (useArtifactDraftStore.getState().drafts[detail.artifact.id] === editDraft)
        useArtifactDraftStore.getState().discard(detail.artifact.id);
      setSelectedVersion(result.version.version);
      await loadList();
    });
  };
  const exportVersion = () => {
    if (!detail) return;
    void act("export", async () => {
      const extension = { markdown: "md", html: "html", openui: "openui" }[detail.version.format];
      const name = Array.from(detail.artifact.title.replace(/[<>:"/\\|?*]/g, "_"))
        .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
        .join("")
        .slice(0, 100);
      await saveAttachment(
        new Blob([detail.version.content], { type: "text/plain;charset=utf-8" }),
        `${name}-v${detail.version.version}.${extension}`,
      );
    });
  };
  const visible = artifacts.filter((artifact) =>
    artifact.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );
  return (
    <div
      className="grid min-h-0 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]"
      data-testid="artifact-panel"
    >
      <aside className="min-w-0 space-y-3 border-b border-border pb-5 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {formatWorkbenchLabel("workbench.artifacts.count", { count: artifacts.length })}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={loading || !!busy}
            aria-label={getWorkbenchLabel("workbench.artifacts.refresh")}
            onClick={() => {
              refreshDraftBaseline.current = { id: selectedId, revision: detailRefresh + 1 };
              setDetailRefresh((value) => value + 1);
              void loadList();
            }}
          >
            <RefreshCw />
          </Button>
        </div>
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={getWorkbenchLabel("workbench.artifacts.search")}
          aria-label={getWorkbenchLabel("workbench.artifacts.search")}
        />
        {loading && artifacts.length === 0 ? (
          <output className="text-sm text-muted-foreground">
            {getWorkbenchLabel("workbench.artifacts.loading")}
          </output>
        ) : null}
        {listError ? (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>{listError}</p>
            <Button variant="outline" size="sm" onClick={() => void loadList()}>
              {getWorkbenchLabel("workbench.artifacts.retry")}
            </Button>
          </div>
        ) : null}
        {!loading && !listError && artifacts.length === 0 ? (
          <div className="space-y-2 py-5 text-sm">
            <p>{getWorkbenchLabel("workbench.artifacts.empty")}</p>
            <p className="text-muted-foreground">
              {getWorkbenchLabel("workbench.artifacts.emptyHint")}
            </p>
          </div>
        ) : null}
        <div className="max-h-72 space-y-1 overflow-y-auto lg:max-h-[60vh]">
          {visible.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              disabled={!!busy}
              aria-current={selectedId === artifact.id ? "true" : undefined}
              className={`w-full rounded-lg px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 ${selectedId === artifact.id ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
              onClick={() => {
                setSelectedVersion(edits[artifact.id]?.sourceVersion);
                setSelectedId(artifact.id);
              }}
            >
              <span className="block break-words text-sm font-medium">{artifact.title}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {edits[artifact.id]
                  ? getWorkbenchLabel("workbench.artifacts.draft")
                  : formatWorkbenchLabel("workbench.artifacts.currentVersion", {
                      version: artifact.currentVersion,
                    })}
              </span>
            </button>
          ))}
        </div>
        {!loading && !listError && artifacts.length > 0 && visible.length === 0 ? (
          <div className="space-y-2 text-sm text-muted-foreground" aria-live="polite">
            <p>{getWorkbenchLabel("workbench.artifacts.noResults")}</p>
            <Button variant="ghost" size="sm" onClick={() => setFilter("")}>
              {getWorkbenchLabel("workbench.search.clear")}
            </Button>
          </div>
        ) : null}
      </aside>
      <section className="min-w-0 space-y-5">
        {detailLoading ? (
          <output className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {getWorkbenchLabel("workbench.artifacts.loading")}
          </output>
        ) : null}
        {detailError ? (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>{detailError}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDetailRefresh((value) => value + 1)}
            >
              {getWorkbenchLabel("workbench.artifacts.retry")}
            </Button>
          </div>
        ) : null}
        {!selectedId && !loading && artifacts.length > 0 ? (
          <p className="py-8 text-sm text-muted-foreground">
            {getWorkbenchLabel("workbench.artifacts.select")}
          </p>
        ) : null}
        {detail ? (
          <>
            <header className="space-y-4">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  {renaming ? (
                    <form
                      className="flex flex-wrap gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!title.trim()) return;
                        void act("rename", async () => {
                          const response = await workbenchApi.artifacts.update(detail.artifact.id, {
                            title: title.trim(),
                          });
                          setDetail((current) =>
                            current ? { ...current, artifact: response.artifact } : current,
                          );
                          setRenaming(false);
                          await loadList();
                        });
                      }}
                    >
                      <Input
                        aria-label={getWorkbenchLabel("workbench.artifacts.name")}
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        disabled={!!busy}
                        maxLength={200}
                        className="h-8 min-w-0 max-w-md flex-1"
                        autoFocus
                      />
                      <Button size="sm" type="submit" disabled={!!busy || !title.trim()}>
                        {getWorkbenchLabel("workbench.artifacts.save")}
                      </Button>
                      <Button
                        size="sm"
                        type="button"
                        variant="ghost"
                        disabled={!!busy}
                        onClick={() => setRenaming(false)}
                      >
                        {getWorkbenchLabel("workbench.artifacts.cancel")}
                      </Button>
                    </form>
                  ) : (
                    <h2 className="min-w-0 break-words text-lg font-medium leading-8">
                      {detail.artifact.title}
                    </h2>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Label htmlFor="artifact-version" className="sr-only">
                      {getWorkbenchLabel("workbench.artifacts.versions")}
                    </Label>
                    <select
                      id="artifact-version"
                      className={selectClass}
                      value={detail.version.version}
                      disabled={!!busy || editing || renaming}
                      onChange={(event) => setSelectedVersion(Number(event.target.value))}
                    >
                      {[...detail.versions]
                        .sort((a, b) => b.version - a.version)
                        .map((version) => (
                          <option key={version.version} value={version.version}>
                            {formatWorkbenchLabel("workbench.artifacts.version", {
                              version: version.version,
                            })}
                          </option>
                        ))}
                    </select>
                    <span>{formats[detail.version.format]}</span>
                  </div>
                  {!editing && detail.version.version < detail.artifact.currentVersion ? (
                    <div
                      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                      aria-live="polite"
                    >
                      <span>
                        {formatWorkbenchLabel("workbench.artifacts.historical", {
                          version: detail.version.version,
                          latest: detail.artifact.currentVersion,
                        })}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!busy || renaming}
                        onClick={() => setSelectedVersion(undefined)}
                      >
                        {getWorkbenchLabel("workbench.artifacts.latest")}
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="flex max-w-full flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={!!busy || editing || renaming}
                    onClick={() =>
                      void act("continue", async () => {
                        await onContinue(detail.artifact, detail.version);
                      })
                    }
                  >
                    {getWorkbenchLabel("workbench.artifacts.continue")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy || editing || renaming}
                    onClick={() => {
                      useArtifactDraftStore.getState().put(detail.artifact.id, {
                        content: detail.version.content,
                        format: detail.version.format,
                        sourceVersion: detail.version.version,
                        expectedVersion: detail.artifact.currentVersion,
                        originalContent: detail.version.content,
                        originalFormat: detail.version.format,
                      });
                    }}
                  >
                    <Plus />
                    {getWorkbenchLabel("workbench.artifacts.edit")}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={getWorkbenchLabel("workbench.artifacts.more")}
                        disabled={!!busy || editing || renaming}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem onSelect={exportVersion}>
                        <Download />
                        {getWorkbenchLabel("workbench.artifacts.export")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!detail.version.sourceConversationId}
                        onSelect={() =>
                          void act("source", async () => {
                            if (detail.version.sourceConversationId)
                              await onOpenSource(detail.version.sourceConversationId);
                          })
                        }
                      >
                        <ExternalLink />
                        {getWorkbenchLabel("workbench.artifacts.openSource")}
                      </DropdownMenuItem>
                      {!detail.version.sourceConversationId ? (
                        <DropdownMenuLabel className="max-w-52 whitespace-normal text-xs font-normal leading-relaxed text-muted-foreground">
                          {getWorkbenchLabel("workbench.artifacts.sourceGone")}
                        </DropdownMenuLabel>
                      ) : null}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => {
                          setTitle(detail.artifact.title);
                          setRenaming(true);
                        }}
                      >
                        <Pencil />
                        {getWorkbenchLabel("workbench.artifacts.rename")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => {
                          setActionError("");
                          setConfirmDelete(true);
                        }}
                      >
                        <Trash2 />
                        {getWorkbenchLabel("workbench.artifacts.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              <fieldset
                aria-label={getWorkbenchLabel("workbench.artifacts.viewMode")}
                className="flex min-w-0 items-center gap-5 border-0 border-b border-border p-0"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className={
                    "h-9 rounded-none border-b-2 px-0 hover:bg-transparent " +
                    (!raw
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground")
                  }
                  aria-pressed={!raw}
                  disabled={editing}
                  onClick={() => setRaw(false)}
                >
                  {getWorkbenchLabel("workbench.artifacts.preview")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={
                    "h-9 rounded-none border-b-2 px-0 hover:bg-transparent " +
                    (raw
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground")
                  }
                  aria-pressed={raw}
                  disabled={editing}
                  onClick={() => setRaw(true)}
                >
                  <FileText />
                  {getWorkbenchLabel("workbench.artifacts.source")}
                </Button>
              </fieldset>
            </header>
            {actionError ? (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
            {editing ? (
              <div className="space-y-3">
                <div className="space-y-1 text-xs text-muted-foreground" aria-live="polite">
                  <p className="font-medium text-foreground">
                    {formatWorkbenchLabel("workbench.artifacts.editingFrom", {
                      version: editDraft.sourceVersion,
                    })}
                  </p>
                  <p>{getWorkbenchLabel("workbench.artifacts.draftHint")}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor="artifact-edit-format">
                    {getWorkbenchLabel("workbench.artifacts.format")}
                  </Label>
                  <select
                    id="artifact-edit-format"
                    className={selectClass}
                    value={draftFormat}
                    disabled={!!busy}
                    onChange={(event) =>
                      updateDraft({ format: event.target.value as ArtifactVersion["format"] })
                    }
                  >
                    {Object.entries(formats).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <Textarea
                  aria-label={getWorkbenchLabel("workbench.artifacts.source")}
                  value={draft}
                  onChange={(event) => updateDraft({ content: event.target.value })}
                  disabled={!!busy}
                  className="min-h-80 font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  {formatWorkbenchLabel("workbench.artifacts.versionHint", {
                    version: detail.artifact.currentVersion + 1,
                  })}
                </p>
                <div className="flex gap-2">
                  <Button disabled={!!busy || !draft.trim() || !changed} onClick={saveVersion}>
                    {busy === "save"
                      ? getWorkbenchLabel("workbench.artifacts.busy")
                      : getWorkbenchLabel("workbench.artifacts.saveVersion")}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => (changed ? setConfirmDiscard(true) : discardDraft())}
                  >
                    {getWorkbenchLabel("workbench.artifacts.cancel")}
                  </Button>
                </div>
              </div>
            ) : raw ? (
              <pre
                className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-4 font-mono text-sm"
                data-testid="artifact-raw"
              >
                {detail.version.content}
              </pre>
            ) : (
              <div className="min-w-0 py-1" data-testid="artifact-preview">
                <DesktopMarkdownMessage
                  content={artifactPreviewContent(detail.version)}
                  genUiScope={`artifact:${detail.artifact.id}:${detail.version.version}`}
                />
              </div>
            )}
            <DiscardChangesDialog
              open={confirmDiscard}
              onKeep={() => setConfirmDiscard(false)}
              onDiscard={discardDraft}
            />

            <Dialog
              open={confirmDelete}
              onOpenChange={(open) => {
                if (!busy) setConfirmDelete(open);
              }}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{getWorkbenchLabel("workbench.artifacts.delete")}</DialogTitle>
                  <DialogDescription>
                    {getWorkbenchLabel("workbench.artifacts.deleteConfirm")}
                  </DialogDescription>
                </DialogHeader>
                {actionError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {actionError}
                  </p>
                ) : null}
                <DialogFooter>
                  <Button
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => setConfirmDelete(false)}
                  >
                    {getWorkbenchLabel("workbench.artifacts.cancel")}
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={!!busy}
                    onClick={() =>
                      void act("delete", async () => {
                        await workbenchApi.artifacts.delete(detail.artifact.id);
                        useArtifactDraftStore.getState().discard(detail.artifact.id);
                        setConfirmDelete(false);
                        setSelectedId(null);
                        setDetail(null);
                        await loadList();
                      })
                    }
                  >
                    {getWorkbenchLabel("workbench.artifacts.confirmDelete")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        ) : null}
      </section>
    </div>
  );
}
