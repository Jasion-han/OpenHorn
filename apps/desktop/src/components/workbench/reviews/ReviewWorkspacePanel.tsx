import { Download, FileSpreadsheet, MoreHorizontal, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildReviewPrompt, reviewCsv, reviewReport } from "shared/reviews";
import type {
  CreateReviewWorkspaceInput,
  ReviewAnnotation,
  ReviewNoteVerificationResult,
  ReviewRecord,
  ReviewRun,
  ReviewWorkspace,
  ReviewWorkspaceSummary,
} from "shared/types";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Label,
} from "ui";
import { useJevStatus } from "../../../hooks/useJevStatus";
import { saveAttachment } from "../../../lib/attachmentPreview";
import { getDesktopBackendBase } from "../../../lib/backendBase";
import { getGlobalDefaultChannel } from "../../../lib/defaultChannel";
import {
  formatWorkbenchLabel as format,
  getJevLabel,
  getWorkbenchLabel as label,
  presentJevTopic,
} from "../../../lib/i18n/agent";
import { ReviewApiError, reviewApi, reviewError } from "../../../lib/reviewWorkspaceApi";
import { useAuthStore } from "../../../stores/authStore";
import { useChatStore } from "../../../stores/chatStore";
import { useDesktopShellStore } from "../../../stores/desktopShellStore";
import { useWorkbenchStore } from "../../../stores/workbenchStore";
import { ReviewAnnotationDialog } from "./ReviewAnnotationDialog";
import { ReviewDataset } from "./ReviewDataset";
import { ReviewImportDialog, reviewSelectClass } from "./ReviewImportDialog";
import { ReviewRuns } from "./ReviewRuns";

/** Per-identity mount: old callbacks and drafts never cross accounts/backends. */
export function ReviewWorkspacePanel() {
  const userId = useAuthStore((state) => state.user?.id ?? "");
  return <ReviewWorkspaceSession key={`${getDesktopBackendBase()}:${userId}`} userId={userId} />;
}

function ReviewWorkspaceSession({ userId }: { userId: string }) {
  const navigation = useWorkbenchStore((s) => s.navigationTarget);
  const lastNavigation = useRef(navigation?.token);
  const [workspaces, setWorkspaces] = useState<ReviewWorkspaceSummary[]>([]);
  const [workspace, setWorkspace] = useState<ReviewWorkspace | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<ReviewRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [model, setModel] = useState("");
  const channels = useChatStore((state) => state.channels);
  const selected = useRef("");
  const live = useRef(false);
  const mutation = useRef(false);
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const handoffEpoch = useRef(0);
  const backend = useRef(getDesktopBackendBase()).current;
  const jev = useJevStatus();
  const retryJev = useRef<{ signature: string; requestId: string } | null>(null);
  const retryPrepare = useRef<{ signature: string; requestId: string } | null>(null);
  const models = useMemo(
    () =>
      channels
        .filter((channel) => channel.enabled && channel.hasApiKey && channel.protocol !== "acp")
        .flatMap((channel) =>
          channel.models
            .filter((model) => model.enabled)
            .map((model) => ({
              value: JSON.stringify([channel.id, model.modelId]),
              label: `${channel.name} / ${model.displayName || model.modelId}`,
            })),
        ),
    [channels],
  );
  useEffect(() => {
    setModel((current) => {
      if (models.some((item) => item.value === current)) return current;
      const fallback = getGlobalDefaultChannel(channels);
      const value = fallback ? JSON.stringify([fallback.channelId, fallback.modelId]) : "";
      return models.some((item) => item.value === value) ? value : "";
    });
  }, [channels, models]);
  const owns = () =>
    live.current &&
    useAuthStore.getState().user?.id === userId &&
    getDesktopBackendBase() === backend;
  const navigationOwner = (epoch: number) =>
    owns() &&
    epoch === handoffEpoch.current &&
    useDesktopShellStore.getState().activeView === "workbench" &&
    useWorkbenchStore.getState().tab === "reviews";
  const accept = (value: ReviewWorkspace) => {
    detailEpoch.current++;
    listEpoch.current++;
    setLoading(false);
    selected.current = value.id;
    setSelectedId(value.id);
    setWorkspace(value);
    setError("");
    const { data: _data, ...summary } = value;
    setWorkspaces((items) => [summary, ...items.filter((item) => item.id !== value.id)]);
  };
  const loadDetail = async (id: string) => {
    const token = ++detailEpoch.current;
    setError("");
    try {
      const result = await reviewApi.get(id);
      if (!owns() || token !== detailEpoch.current || selected.current !== id) return;
      accept(result.workspace);
    } catch (error) {
      if (owns() && token === detailEpoch.current && selected.current === id)
        setError(reviewError(error));
    }
  };
  const choose = (id: string) => {
    handoffEpoch.current++;
    selected.current = id;
    setSelectedId(id);
    setWorkspace(null);
    setEditing(null);
    setError("");
    if (id) void loadDetail(id);
  };
  const load = async () => {
    const token = ++listEpoch.current;
    const navigationAtStart = useWorkbenchStore.getState().navigationTarget?.token;
    setLoading(true);
    setListError("");
    try {
      const result = await reviewApi.list();
      if (!owns() || token !== listEpoch.current) return;
      const currentNavigation = useWorkbenchStore.getState().navigationTarget;
      if (currentNavigation && currentNavigation.token !== navigationAtStart) return;
      setWorkspaces(result.workspaces);
      const target = useWorkbenchStore.getState().navigationTarget;
      if (target?.tab === "reviews") {
        choose(target.id);
        useWorkbenchStore.getState().clearNavigation(target.token);
      } else if (!result.workspaces.some((item) => item.id === selected.current))
        choose(result.workspaces[0]?.id ?? "");
      else if (selected.current) void loadDetail(selected.current);
    } catch (error) {
      if (owns() && token === listEpoch.current) setListError(reviewError(error));
    } finally {
      if (owns() && token === listEpoch.current) setLoading(false);
    }
  };
  // A mounted identity owns its callbacks; StrictMode cleanup invalidates pending reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity changes remount this entire session
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
      listEpoch.current++;
      detailEpoch.current++;
      handoffEpoch.current++;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: load uses the mounted identity and only a new navigation token reissues the read
  useEffect(() => {
    if (navigation?.tab !== "reviews" || navigation.token === lastNavigation.current) return;
    lastNavigation.current = navigation.token;
    void load();
  }, [navigation]);
  const act = async <T,>(action: () => Promise<T>): Promise<T> => {
    if (mutation.current) throw new Error("busy");
    mutation.current = true;
    setBusy(true);
    setError("");
    try {
      return await action();
    } finally {
      mutation.current = false;
      if (owns()) setBusy(false);
    }
  };
  const create = async (input: CreateReviewWorkspaceInput) => {
    await act(async () => {
      const result = await reviewApi.create(input);
      if (owns()) {
        accept(result.workspace);
        setLoading(false);
        setListError("");
      }
    });
  };
  const annotate = async (
    revision: number,
    annotation: Omit<ReviewAnnotation, "source" | "runId">,
  ) => {
    if (!workspace || !editing) return;
    await act(async () => {
      const result = await reviewApi.annotate(workspace.id, editing.id, revision, annotation);
      if (owns() && selected.current === workspace.id) accept(result.workspace);
    });
  };
  const verifyNote = async (
    revision: number,
    requestId: string,
  ): Promise<ReviewNoteVerificationResult> => {
    if (!workspace || !editing) throw new ReviewApiError("review_not_found");
    return act(async () => {
      const result = await reviewApi.verifyNote(workspace.id, editing.id, revision, requestId);
      if (!owns() || selected.current !== workspace.id)
        throw new ReviewApiError("review_not_found");
      accept(result.workspace);
      return result;
    });
  };
  const open = async (run: ReviewRun) => {
    if (!run.conversationId || mutation.current) return;
    const epoch = ++handoffEpoch.current;
    try {
      await act(async () => {
        await useChatStore.getState().loadConversations();
        if (!navigationOwner(epoch)) return;
        if (!useChatStore.getState().conversations.some((item) => item.id === run.conversationId))
          throw new ReviewApiError("review_source_not_ready");
        await useChatStore.getState().selectConversation(run.conversationId as string);
        if (
          !navigationOwner(epoch) ||
          useChatStore.getState().currentConversation?.id !== run.conversationId
        )
          return;
        if (!run.results && useChatStore.getState().messages.length === 0)
          useDesktopShellStore.getState().setPendingPrompt({
            text: buildReviewPrompt(run),
            files: [],
            conversationId: run.conversationId as string,
            autoSend: false,
          });
        useDesktopShellStore.getState().setActiveView("chat");
      });
    } catch (error) {
      if (navigationOwner(epoch)) setError(reviewError(error));
    }
  };
  const prepare = async (rowIds: string[]) => {
    if (!workspace || !model || mutation.current) {
      if (!model) setError(label("reviews.errors.channel"));
      return false;
    }
    if (useChatStore.getState().isStreaming) {
      setError(label("workbench.recipes.running"));
      return false;
    }
    const epoch = ++handoffEpoch.current;
    const signature = JSON.stringify([workspace.id, workspace.revision, rowIds, model]);
    const requestId =
      retryPrepare.current?.signature === signature
        ? retryPrepare.current.requestId
        : crypto.randomUUID();
    retryPrepare.current = { signature, requestId };
    try {
      await act(async () => {
        const [channelId, modelId] = JSON.parse(model) as [string, string];
        const result = await reviewApi.prepare(workspace.id, {
          expectedRevision: workspace.revision,
          requestId,
          rowIds,
          channelId,
          modelId,
          instructions: label("reviews.instructions"),
        });
        if (!navigationOwner(epoch) || selected.current !== workspace.id) return;
        accept(result.workspace);
        retryPrepare.current = null;
        await useChatStore.getState().loadConversations();
        if (!navigationOwner(epoch)) return;
        await useChatStore.getState().selectConversation(result.run.conversationId as string);
        if (
          !navigationOwner(epoch) ||
          useChatStore.getState().currentConversation?.id !== result.run.conversationId
        )
          return;
        useDesktopShellStore.getState().setPendingPrompt({
          text: result.prompt,
          files: [],
          conversationId: result.run.conversationId as string,
          autoSend: false,
        });
        useDesktopShellStore.getState().setActiveView("chat");
      });
      return true;
    } catch (error) {
      if (navigationOwner(epoch)) setError(reviewError(error));
      return false;
    }
  };
  const sync = async (run: ReviewRun) => {
    if (!workspace || mutation.current) return;
    const id = workspace.id;
    try {
      await act(async () => {
        const result = await reviewApi.sync(id, run.id, workspace.revision);
        if (owns() && selected.current === id) accept(result.workspace);
      });
    } catch (error) {
      if (owns()) setError(reviewError(error));
    }
  };
  const classify = async (rowIds: string[]) => {
    if (!workspace || mutation.current) return false;
    const id = workspace.id;
    const signature = JSON.stringify([id, workspace.revision, rowIds]);
    const requestId =
      retryJev.current?.signature === signature ? retryJev.current.requestId : crypto.randomUUID();
    retryJev.current = { signature, requestId };
    try {
      let completed = false;
      await act(async () => {
        const result = await reviewApi.classify(id, workspace.revision, requestId, rowIds);
        if (!owns() || selected.current !== id) return;
        accept(result.workspace);
        completed = result.run.decision?.status === "completed";
        if (!completed)
          setError(
            getJevLabel(
              result.run.decision?.error === "budget" ? "jev.reviews.budget" : "jev.reviews.error",
            ),
          );
        retryJev.current = null;
      });
      return completed;
    } catch (error) {
      if (owns() && selected.current === id) setError(reviewError(error));
      return false;
    }
  };
  const remove = async () => {
    if (!workspace || mutation.current) return;
    try {
      await act(async () => {
        await reviewApi.delete(workspace.id, workspace.revision);
        if (!owns()) return;
        detailEpoch.current++;
        listEpoch.current++;
        const items = workspaces.filter((item) => item.id !== workspace.id);
        setWorkspaces(items);
        setDeleting(false);
        choose(items[0]?.id ?? "");
      });
    } catch (error) {
      if (owns()) setError(reviewError(error));
    }
  };
  const exportFile = async (kind: "csv" | "source" | "report") => {
    if (!workspace) return;
    const fields = [
      "row",
      "text",
      "rating",
      "sentiment",
      "topics",
      "quote",
      "note",
      "source",
    ] as const;
    const exportData = {
      ...workspace.data,
      rows: workspace.data.rows.map((row) => ({
        ...row,
        annotation: row.annotation
          ? { ...row.annotation, topics: row.annotation.topics.map(presentJevTopic) }
          : null,
      })),
    };
    const content =
      kind === "source"
        ? workspace.data.source.csv
        : kind === "csv"
          ? reviewCsv(
              exportData,
              fields.map((key) => label(`reviews.${key}`)),
            )
          : reviewReport(workspace.title, exportData, {
              total: label("reviews.total"),
              annotated: label("reviews.annotated"),
              sentiment: label("reviews.sentiment"),
              topics: label("reviews.topics"),
              evidence: label("reviews.quote"),
              source: label("reviews.source"),
              sentiments: Object.fromEntries(
                (["positive", "negative", "neutral", "mixed", "unknown"] as const).map((key) => [
                  key,
                  label(`reviews.${key}`),
                ]),
              ),
              sources: {
                ai: label("reviews.ai"),
                manual: label("reviews.manual"),
                unannotated: label("reviews.unannotated"),
              },
            });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip C0 controls from user-provided filenames
    const name = workspace.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 100);
    try {
      await saveAttachment(
        new Blob([content], {
          type: kind === "report" ? "text/markdown;charset=utf-8" : "text/csv;charset=utf-8",
        }),
        `${name}${kind === "source" ? "-original" : ""}.${kind === "report" ? "md" : "csv"}`,
      );
    } catch (error) {
      if (owns()) setError(reviewError(error));
    }
  };
  return (
    <div className="min-w-0 space-y-5">
      {workspaces.length > 0 && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="review-workspace">{label("reviews.project")}</Label>
            <select
              id="review-workspace"
              aria-label={label("reviews.choose")}
              className={`${reviewSelectClass} w-full sm:max-w-sm`}
              value={selectedId}
              disabled={busy || loading}
              onChange={(e) => choose(e.target.value)}
            >
              <option value="" disabled>
                {label("reviews.choose")}
              </option>
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </div>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={busy || loading}
                aria-label={label("reviews.more")}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setImporting(true)}>
                <FileSpreadsheet className="mr-2 h-4 w-4" />
                {label("reviews.import")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void load()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {label("reviews.refresh")}
              </DropdownMenuItem>
              {workspace && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void exportFile("csv")}>
                    <Download className="mr-2 h-4 w-4" />
                    {label("reviews.exportCsv")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportFile("source")}>
                    {label("reviews.exportSource")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportFile("report")}>
                    {label("reviews.exportReport")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(true)}>
                    {label("reviews.delete")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {listError && (
        <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
          {listError}
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {label("reviews.retry")}
          </Button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive/30 p-3 text-sm text-destructive"
        >
          <p>{error}</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>
            {label("reviews.refresh")}
          </Button>
        </div>
      )}
      {loading && (
        <output className="block text-sm text-muted-foreground">{label("reviews.loading")}</output>
      )}
      {!loading && !listError && !selectedId && (
        <section className="space-y-3 rounded-md border border-dashed px-5 py-10">
          <FileSpreadsheet className="h-7 w-7 text-muted-foreground" />
          <h2 className="text-lg font-semibold">{label("reviews.emptyTitle")}</h2>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            {label("reviews.emptyDescription")}
          </p>
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
            {label("reviews.storage")}
          </p>
          <Button onClick={() => setImporting(true)}>{label("reviews.import")}</Button>
        </section>
      )}
      {selectedId && !workspace && !error && (
        <output className="block text-sm text-muted-foreground">{label("reviews.loading")}</output>
      )}
      {workspace && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h2 className="break-words text-lg font-semibold">{workspace.title}</h2>
              <p className="break-words text-xs text-muted-foreground">
                {format("reviews.savedRevision", {
                  revision: workspace.revision,
                  file: workspace.data.source.fileName,
                })}
              </p>
            </div>
          </div>
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {(
              [
                ["total", workspace.data.rows.length],
                ["annotated", workspace.annotatedCount],
                [
                  "manual",
                  workspace.data.rows.filter((row) => row.annotation?.source === "manual").length,
                ],
                ["unannotated", workspace.rowCount - workspace.annotatedCount],
              ] as const
            ).map(([key, count]) => (
              <div key={key} className="flex items-baseline gap-2">
                <dt className="text-xs text-muted-foreground">{label(`reviews.${key}`)}</dt>
                <dd className="font-medium tabular-nums">{count}</dd>
              </div>
            ))}
          </dl>
          <ReviewDataset
            key={workspace.id}
            workspace={workspace}
            busy={busy}
            onEdit={setEditing}
            onPrepare={prepare}
            onClassify={classify}
            models={models}
            model={model}
            onModelChange={setModel}
            jevEnabled={Boolean(
              jev.status?.configured && jev.status.enabled && jev.status.features.reviews,
            )}
          />
          <ReviewRuns
            runs={workspace.data.runs}
            busy={busy}
            onOpen={(run) => void open(run)}
            onSync={(run) => void sync(run)}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {label("reviews.storage")}
          </p>
        </>
      )}
      {importing && <ReviewImportDialog onClose={() => setImporting(false)} onSave={create} />}
      {editing && workspace && (
        <ReviewAnnotationDialog
          key={editing.id}
          row={editing}
          revision={workspace.revision}
          onClose={() => setEditing(null)}
          onSave={annotate}
          onVerify={verifyNote}
        />
      )}
      <Dialog
        open={deleting}
        onOpenChange={(value) => {
          if (!busy) setDeleting(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label("reviews.deleteTitle")}</DialogTitle>
            <DialogDescription>{label("reviews.deleteHint")}</DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeleting(false)}>
              {label("reviews.cancel")}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              {label(busy ? "reviews.working" : "reviews.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
