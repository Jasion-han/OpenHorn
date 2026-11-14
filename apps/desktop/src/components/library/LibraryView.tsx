import { BookOpen, MoreHorizontal, Search, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  LibraryDocument,
  LibraryDocumentDetail,
  LibraryFilter,
  LibrarySearchResult,
  PreparedLibraryQuestion,
  PrepareLibraryQuestionInput,
} from "shared/types";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "ui";
import { saveAttachment } from "../../lib/attachmentPreview";
import { getDesktopBackendBase } from "../../lib/backendBase";
import { formatLibraryLabel as format, getLibraryLabel as label } from "../../lib/i18n/agent";
import { LibraryApiError, libraryApi, libraryError } from "../../lib/libraryApi";
import { isDesktopRuntime } from "../../lib/tauriBridge";
import { useAuthStore } from "../../stores/authStore";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { useLibraryDraftStore } from "../../stores/libraryDraftStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useProjectStore } from "../../stores/projectStore";
import { reviewSelectClass } from "../workbench/reviews/ReviewImportDialog";
import { LibraryHistoryDialog } from "./LibraryHistoryDialog";
import { LibraryOcrDialog } from "./LibraryOcrDialog";
import { LibraryQuestionDialog } from "./LibraryQuestionDialog";
import { LibraryUploadDialog } from "./LibraryUploadDialog";

const scopeFromKey = (key: string): LibraryFilter =>
  key === "all"
    ? { kind: "all" }
    : key === "personal"
      ? { kind: "personal" }
      : { kind: "project", projectId: key.slice(8) };
export function LibraryView() {
  const userId = useAuthStore((s) => s.user?.id ?? "");
  return <LibrarySession key={`${getDesktopBackendBase()}:${userId}`} userId={userId} />;
}
function LibrarySession({ userId }: { userId: string }) {
  const projects = useProjectStore((s) => s.projects),
    target = useLibraryStore((s) => s.target);
  const [scopeKey, setScopeKey] = useState(() => {
    const projectId = useProjectStore.getState().activeProjectId;
    return projectId ? `project:${projectId}` : "personal";
  });
  const [documents, setDocuments] = useState<LibraryDocument[]>([]),
    [selectedId, setSelectedId] = useState(""),
    [document, setDocument] = useState<LibraryDocumentDetail | null>(null);
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<LibrarySearchResult[] | null>(null),
    [matched, setMatched] = useState<LibrarySearchResult | null>(null);
  const [loading, setLoading] = useState(true),
    [detailLoading, setDetailLoading] = useState(false),
    [searching, setSearching] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [listError, setListError] = useState(""),
    [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<"upload" | "question" | "history" | "ocr" | null>(null),
    [deleting, setDeleting] = useState(false),
    [refresh, setRefresh] = useState(0);
  const live = useRef(false),
    lock = useRef(false),
    epoch = useRef(0),
    listEpoch = useRef(0),
    detailEpoch = useRef(0),
    searchEpoch = useRef(0),
    selected = useRef(""),
    currentScope = useRef(scopeKey);
  const backend = useRef(getDesktopBackendBase()).current;
  const scope = scopeFromKey(scopeKey);
  const scopeName =
    scope.kind === "project"
      ? (projects.find((p) => p.id === scope.projectId)?.name ?? label("library.unavailableScope"))
      : label(scope.kind === "all" ? "library.all" : "library.personal");
  const owns = () =>
    live.current &&
    useAuthStore.getState().user?.id === userId &&
    getDesktopBackendBase() === backend &&
    useDesktopShellStore.getState().activeView === "library";
  const capture = () => {
    const token = epoch.current,
      revision = useLibraryStore.getState().navigationRevision;
    return () =>
      owns() &&
      token === epoch.current &&
      revision === useLibraryStore.getState().navigationRevision;
  };
  const choose = (id: string, match: LibrarySearchResult | null = null) => {
    setDialog((current) => (current === "ocr" ? null : current));
    epoch.current++;
    const target = useLibraryStore.getState().target;
    if (target) useLibraryStore.getState().clearTarget(target.token);
    if (selected.current !== id) {
      detailEpoch.current++;
      selected.current = id;
      setSelectedId(id);
      setDocument(null);
    }
    setMatched(match);
    setDeleting(false);
    setError("");
    setNotice("");
  };
  const changeScope = (key: string) => {
    epoch.current++;
    searchEpoch.current++;
    setSearching(false);
    currentScope.current = key;
    setScopeKey(key);
    setDocuments([]);
    setResults(null);
    setQuery("");
    choose("");
  };
  useEffect(() => {
    live.current = true;
    useLibraryDraftStore.getState().bind(`${backend}:${userId}`);
    void useProjectStore.getState().loadProjects();
    return () => {
      live.current = false;
      epoch.current++;
      listEpoch.current++;
      detailEpoch.current++;
      searchEpoch.current++;
    };
  }, [backend, userId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope and explicit refresh exclusively own the list request
  useEffect(() => {
    const token = ++listEpoch.current,
      expectedScope = scopeKey;
    const valid = () =>
      owns() && token === listEpoch.current && currentScope.current === expectedScope;
    setLoading(true);
    setListError("");
    void libraryApi
      .list(scopeFromKey(scopeKey))
      .then(({ documents: rows }) => {
        if (!valid()) return;
        setDocuments(rows);
        if (!useLibraryStore.getState().target && !rows.some((row) => row.id === selected.current))
          choose(rows[0]?.id ?? "");
      })
      .catch((error) => {
        if (valid()) setListError(libraryError(error));
      })
      .finally(() => {
        if (valid()) setLoading(false);
      });
  }, [scopeKey, refresh]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection and refresh exclusively own detail reads
  useEffect(() => {
    const token = ++detailEpoch.current,
      id = selectedId;
    if (!id) {
      setDetailLoading(false);
      return;
    }
    const valid = () => owns() && token === detailEpoch.current && selected.current === id;
    setDetailLoading(true);
    void libraryApi
      .get(id)
      .then(({ document }) => {
        if (valid()) setDocument(document);
      })
      .catch((error) => {
        if (valid()) setError(libraryError(error));
      })
      .finally(() => {
        if (valid()) setDetailLoading(false);
      });
  }, [selectedId, refresh]);
  // A search handoff first validates ownership, then derives its actual scope.
  // biome-ignore lint/correctness/useExhaustiveDependencies: token is the navigation identity
  useEffect(() => {
    if (!target) return;
    const token = target.token,
      operation = ++epoch.current,
      valid = () =>
        owns() && epoch.current === operation && useLibraryStore.getState().target?.token === token;
    searchEpoch.current++;
    setSearching(false);
    void libraryApi
      .get(target.id)
      .then(({ document }) => {
        if (!valid()) return;
        const key = document.projectId ? `project:${document.projectId}` : "personal";
        currentScope.current = key;
        setScopeKey(key);
        setResults(null);
        setQuery("");
        choose(document.id);
        setDocument(document);
        useLibraryStore.getState().clearTarget(token);
      })
      .catch((error) => {
        if (valid()) {
          setError(libraryError(error));
          useLibraryStore.getState().clearTarget(token);
        }
      });
  }, [target?.token]);
  const reload = () => {
    searchEpoch.current++;
    setSearching(false);
    setResults(null);
    setMatched(null);
    setRefresh((v) => v + 1);
  };
  const act = async (work: (valid: () => boolean) => Promise<void>): Promise<boolean> => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const valid = capture();
    try {
      await work(valid);
      return valid();
    } catch (error) {
      if (valid()) setError(libraryError(error));
      return false;
    } finally {
      lock.current = false;
      if (owns()) setBusy(false);
    }
  };
  const handoff = async (prepared: PreparedLibraryQuestion, valid: () => boolean) => {
    const question = prepared.question,
      id = question.conversationId;
    if (!prepared.replayable || !id) throw new LibraryApiError("library_not_found");
    if (useChatStore.getState().isStreaming) throw new LibraryApiError("library_index_busy");
    await useChatStore.getState().loadConversations();
    if (!valid()) return;
    if (!useChatStore.getState().conversations.some((c) => c.id === id))
      throw new LibraryApiError("library_not_found");
    await useChatStore.getState().selectConversation(id);
    if (!valid() || useChatStore.getState().currentConversation?.id !== id) return;
    useLibraryDraftStore.getState().setQuestion(null);
    if (useChatStore.getState().messages.length === 0)
      useDesktopShellStore.getState().setPendingPrompt({
        text: question.prompt,
        files: [],
        conversationId: id,
        autoSend: false,
      });
    useDesktopShellStore.getState().setActiveView("chat");
  };
  const prepare = (input: PrepareLibraryQuestionInput) =>
    act(async (valid) => {
      const prepared = await libraryApi.prepare(input);
      if (valid()) await handoff(prepared, valid);
    });
  const openQuestion = async (id: string) => {
    await act(async (valid) => {
      const prepared = await libraryApi.question(id);
      if (valid()) await handoff(prepared, valid);
    });
  };
  const search = async () => {
    const token = ++searchEpoch.current,
      expectedScope = scopeKey,
      text = query.trim();
    if (!text) {
      setResults(null);
      return;
    }
    const valid = () =>
      owns() && token === searchEpoch.current && currentScope.current === expectedScope;
    setSearching(true);
    setError("");
    try {
      const { results } = await libraryApi.search(scope, text);
      if (valid()) {
        setResults(results);
        if (results[0]) choose(results[0].documentId, results[0]);
      }
    } catch (error) {
      if (valid()) setError(libraryError(error));
    } finally {
      if (valid()) setSearching(false);
    }
  };
  const status = (row: LibraryDocument) =>
    row.errorCode === "library_cloud_required"
      ? label("library.ocr.required")
      : label(
          row.status === "indexing" && row.canIndex
            ? "library.status.expired"
            : `library.status.${row.status}`,
        );
  const openDialog = (value: typeof dialog) => {
    setError("");
    setDialog(value);
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="library-view">
      <div data-tauri-drag-region className="h-8 shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
        <div className="mx-auto max-w-6xl space-y-5">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
            <div className="space-y-1">
              <h1 className="text-xl font-semibold tracking-tight">{label("library.title")}</h1>
              <p className="text-xs text-muted-foreground">{label("library.description")}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={busy || scope.kind === "all"}
                onClick={() => openDialog("upload")}
              >
                <Upload size={14} className="mr-2" />
                {label("library.import")}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={label("library.more")}
                    disabled={busy}
                  >
                    <MoreHorizontal size={17} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="bg-card text-foreground [&_[role=menuitem]]:focus:bg-accent [&_[role=menuitem]]:focus:text-accent-foreground"
                >
                  <DropdownMenuItem
                    disabled={scope.kind === "all"}
                    onSelect={() => openDialog("question")}
                  >
                    {label("library.ask")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openDialog("history")}>
                    {label("library.history")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={reload}>{label("library.refresh")}</DropdownMenuItem>
                  {document && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() =>
                          void act(async (valid) => {
                            const blob = await libraryApi.original(document.id);
                            if (!valid()) return;
                            const path = await saveAttachment(blob, document.fileName, valid);
                            if (valid() && (path || !isDesktopRuntime()))
                              setNotice(label(path ? "library.saved" : "library.downloadStarted"));
                          })
                        }
                      >
                        {label("library.download")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!document.canIndex}
                        onSelect={() =>
                          void act(async (valid) => {
                            await libraryApi.index(document.id);
                            if (valid()) reload();
                          })
                        }
                      >
                        {label("library.index")}
                      </DropdownMenuItem>
                      {document.canOcr &&
                        document.status !== "ready" &&
                        label("library.ocr.action") && (
                          <DropdownMenuItem
                            onSelect={() => {
                              setError("");
                              setDialog("ocr");
                            }}
                          >
                            {label("library.ocr.action")}
                          </DropdownMenuItem>
                        )}
                      <DropdownMenuItem
                        className="text-destructive"
                        onSelect={() => setDeleting(true)}
                      >
                        {label("library.delete")}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <div className="flex flex-wrap gap-3">
            <select
              aria-label={label("library.scope")}
              value={scopeKey}
              disabled={busy}
              className={`${reviewSelectClass} max-w-[240px]`}
              onChange={(event) => changeScope(event.target.value)}
            >
              <option value="personal">{label("library.personal")}</option>
              {projects.map((project) => (
                <option key={project.id} value={`project:${project.id}`}>
                  {project.name}
                </option>
              ))}
              {scope.kind === "project" && !projects.some((p) => p.id === scope.projectId) && (
                <option value={scopeKey}>{label("library.unavailableScope")}</option>
              )}
              <option value="all">{label("library.all")}</option>
            </select>
            <form
              className="flex min-w-0 flex-1 gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void search();
              }}
            >
              <Input
                aria-label={label("library.search")}
                placeholder={label("library.searchPlaceholder")}
                maxLength={500}
                value={query}
                disabled={busy}
                onChange={(event) => {
                  searchEpoch.current++;
                  setSearching(false);
                  setResults(null);
                  setMatched(null);
                  setQuery(event.target.value);
                }}
              />
              <Button
                type="submit"
                size="icon"
                variant="outline"
                aria-label={label("library.search")}
                disabled={!query.trim() || busy || searching}
              >
                <Search size={16} />
              </Button>
            </form>
          </div>
          {error && !dialog && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {notice && <output className="text-xs text-muted-foreground">{notice}</output>}
          {listError ? (
            <div role="alert" className="space-y-3 py-10 text-center">
              <p className="text-sm text-destructive">{listError}</p>
              <Button variant="outline" onClick={reload}>
                {label("library.retry")}
              </Button>
            </div>
          ) : loading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {label("library.loading")}
            </p>
          ) : !documents.length ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <BookOpen size={30} strokeWidth={1.2} className="text-muted-foreground/60" />
              <p className="text-sm font-medium">{label("library.empty")}</p>
              <p className="max-w-sm text-xs leading-6 text-muted-foreground">
                {label("library.emptyHint")}
              </p>
            </div>
          ) : (
            <div className="grid min-h-[420px] grid-cols-1 gap-6 md:grid-cols-[260px_minmax(0,1fr)]">
              <aside
                className="space-y-2"
                aria-label={results ? label("library.searchResults") : label("library.title")}
              >
                {results !== null && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {label("library.searchResults")} · {results.length}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        searchEpoch.current++;
                        setSearching(false);
                        setResults(null);
                        setMatched(null);
                      }}
                    >
                      {label("library.clearSearch")}
                    </Button>
                  </div>
                )}
                {results !== null ? (
                  !results.length ? (
                    <p className="py-5 text-xs text-muted-foreground">
                      {label("library.noResults")}
                    </p>
                  ) : (
                    results.map((result) => (
                      <button
                        key={`${result.documentId}:${result.chunkIndex}`}
                        type="button"
                        disabled={busy}
                        onClick={() => choose(result.documentId, result)}
                        className={cn(
                          "w-full space-y-1 rounded-md px-3 py-3 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
                          matched?.documentId === result.documentId &&
                            matched.chunkIndex === result.chunkIndex &&
                            "bg-muted",
                        )}
                      >
                        <span className="block truncate text-sm font-medium">
                          {result.fileName}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {format("library.chunk", { number: result.chunkIndex + 1 })}
                        </span>
                        <span className="line-clamp-2 break-words text-xs text-muted-foreground">
                          {result.text}
                        </span>
                      </button>
                    ))
                  )
                ) : (
                  documents.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      aria-pressed={selectedId === row.id}
                      disabled={busy}
                      onClick={() => choose(row.id)}
                      className={cn(
                        "w-full space-y-1 rounded-md px-3 py-3 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
                        selectedId === row.id && "bg-muted",
                      )}
                    >
                      <span className="block truncate text-sm font-medium">{row.fileName}</span>
                      <span className="block text-xs text-muted-foreground">
                        {status(row)} · {Math.ceil(row.fileSize / 1024)} KB
                      </span>
                    </button>
                  ))
                )}
              </aside>
              <section
                className="min-w-0 space-y-4 border-t pt-4 md:border-l md:border-t-0 md:pl-6 md:pt-0"
                aria-label={label("library.originalText")}
              >
                {detailLoading ? (
                  <p className="text-sm text-muted-foreground">{label("library.loading")}</p>
                ) : document ? (
                  <>
                    <div className="space-y-1">
                      <h2 className="break-words text-base font-medium">{document.fileName}</h2>
                      <p className="text-xs text-muted-foreground">
                        {status(document)} ·{" "}
                        {format("library.chunks", {
                          count: document.chunkCount,
                          size: Math.ceil(document.fileSize / 1024),
                        })}
                      </p>
                    </div>
                    {document.errorCode && document.errorCode !== "library_cloud_required" && (
                      <p role="alert" className="text-sm text-destructive">
                        {libraryError(new LibraryApiError(document.errorCode))}
                      </p>
                    )}
                    {deleting && (
                      <div role="alert" className="space-y-3 rounded-md border p-4">
                        <p className="text-sm font-medium">{label("library.delete")}</p>
                        <p className="text-xs text-muted-foreground">
                          {label("library.deleteHint")}
                        </p>
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => setDeleting(false)}
                          >
                            {label("library.cancel")}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy}
                            onClick={() =>
                              void act(async (valid) => {
                                await libraryApi.delete(document.id, document.revision);
                                if (valid()) {
                                  choose("");
                                  reload();
                                }
                              })
                            }
                          >
                            {label("library.delete")}
                          </Button>
                        </div>
                      </div>
                    )}
                    {matched && (
                      <div className="space-y-2 border-l-2 border-foreground/25 pl-4">
                        <h3 className="text-xs font-medium">
                          {format("library.chunk", { number: matched.chunkIndex + 1 })}
                        </h3>
                        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">
                          {matched.text}
                        </pre>
                      </div>
                    )}
                    {document.text ? (
                      <details open={!matched} className="space-y-3">
                        <summary className="w-fit cursor-pointer rounded text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring">
                          {label("library.originalText")}
                        </summary>
                        <pre className="max-h-[65vh] overflow-y-auto whitespace-pre-wrap break-words pt-2 font-sans text-sm leading-7">
                          {document.text}
                        </pre>
                      </details>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {label(document.canOcr ? "library.ocr.noText" : "library.noText")}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="py-10 text-sm text-muted-foreground">{label("library.choose")}</p>
                )}
              </section>
            </div>
          )}
          {dialog === "ocr" && document && (
            <LibraryOcrDialog
              key={document.id}
              document={document}
              errorMessage={error}
              onClose={() => setDialog(null)}
              onConfirm={() =>
                act(async (valid) => {
                  const result = await libraryApi.ocr(document.id);
                  if (!valid()) return;
                  setDocument((current) =>
                    current?.id === result.document.id
                      ? { ...current, ...result.document }
                      : current,
                  );
                  reload();
                  if (result.document.status !== "ready")
                    throw new LibraryApiError(result.document.errorCode ?? "library_ocr_failed");
                })
              }
            />
          )}
          {dialog === "upload" && scope.kind !== "all" && (
            <LibraryUploadDialog
              scope={scope}
              scopeName={scopeName}
              errorMessage={error}
              onClose={() => setDialog(null)}
              onUpload={async (scope, file) => {
                let accepted = false;
                await act(async (valid) => {
                  const result = await libraryApi.upload(scope, file);
                  if (valid()) {
                    accepted = true;
                    choose(result.document.id);
                    reload();
                  }
                });
                return accepted;
              }}
            />
          )}
          {dialog === "question" && scope.kind !== "all" && (
            <LibraryQuestionDialog
              scope={scope}
              scopeName={scopeName}
              errorMessage={error}
              onClose={() => setDialog(null)}
              onPrepare={prepare}
            />
          )}
          {dialog === "history" && (
            <LibraryHistoryDialog
              owns={owns}
              errorMessage={error}
              onClose={() => setDialog(null)}
              onOpen={openQuestion}
            />
          )}
        </div>
      </div>
    </div>
  );
}
