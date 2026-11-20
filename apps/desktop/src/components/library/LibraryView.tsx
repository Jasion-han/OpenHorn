import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Search,
  Star,
  Upload,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { LIBRARY_SYSTEM_TAG, libraryKeywords, libraryKeywordVariants } from "shared/library";
import type {
  LibraryDocument,
  LibraryDocumentDetail,
  LibraryFilter,
  LibraryFolder,
  LibraryListOptions,
  LibraryScope,
  LibrarySearchResult,
  LibraryStats,
  PreparedLibraryQuestion,
  PrepareLibraryQuestionInput,
} from "shared/types";
import {
  Button,
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
} from "ui";
import { saveAttachment } from "../../lib/attachmentPreview";
import { getDesktopBackendBase } from "../../lib/backendBase";
import { formatLibraryLabel as format, getLibraryLabel as label } from "../../lib/i18n/agent";
import { LibraryApiError, libraryApi, libraryError } from "../../lib/libraryApi";
import { appendLibraryChatDraftSource } from "../../lib/libraryChatDraft";
import { notifySuccess } from "../../lib/notify";
import { isDesktopRuntime } from "../../lib/tauriBridge";
import { useAuthStore } from "../../stores/authStore";
import { useChatStore } from "../../stores/chatStore";
import { useConversationDraftStore } from "../../stores/conversationDraftStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { useLibraryDraftStore } from "../../stores/libraryDraftStore";
import { type LibraryBrowsePosition, useLibraryStore } from "../../stores/libraryStore";
import { useProjectStore } from "../../stores/projectStore";
import { reviewSelectClass } from "../workbench/reviews/ReviewImportDialog";
import {
  type LibraryFolderAction,
  LibraryFolderDialog,
  LibraryFolderPicker,
  libraryFolderMenuItemClass,
} from "./LibraryFolderControls";
import { LibraryHistoryDialog } from "./LibraryHistoryDialog";
import { LibraryOcrDialog } from "./LibraryOcrDialog";
import { type LibraryPdfSource, LibraryPdfSourceDialog } from "./LibraryPdfSourceDialog";
import { LibraryQuestionDialog, type LibraryQuestionSelection } from "./LibraryQuestionDialog";
import { exactLibrarySourceRange, formatLibraryLocation } from "./LibrarySourceLocation";
import { LibraryUploadDialog } from "./LibraryUploadDialog";
import { LibraryVersionsDialog } from "./LibraryVersionsDialog";

const scopeFromKey = (key: string): LibraryFilter =>
  key === "all"
    ? { kind: "all" }
    : key === "personal"
      ? { kind: "personal" }
      : { kind: "project", projectId: key.slice(8) };
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function highlightText(text: string, query: string, excerpt = false) {
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const terms = libraryKeywords(query)
    .sort((left, right) => right.length - left.length)
    .map((term) =>
      Array.from(
        term,
        (char) => `(?:${libraryKeywordVariants(char).map(escapeRegex).join("|")})`,
      ).join(""),
    );
  if (!terms.length) return text;
  const pattern = terms.join("|");
  const first = new RegExp(pattern, "u").exec(text);
  if (!first) return text;
  // Let the match appear in the two-line preview even if it is deep in the chunk.
  const sliceStart = excerpt ? Math.max(0, first.index - 28) : 0;
  const sliceEnd = excerpt
    ? Math.min(text.length, first.index + first[0].length + 120)
    : text.length;
  const snippet = `${sliceStart ? "… " : ""}${text.slice(sliceStart, sliceEnd)}${sliceEnd < text.length ? " …" : ""}`;
  const split = new RegExp(`(${pattern})`, "gu");
  let offset = 0;
  return snippet.split(split).map((part, index) => {
    const key = `${offset}:${part}`;
    offset += part.length;
    return index % 2 === 1 ? (
      <mark key={key} className="rounded bg-amber-100 px-0.5 text-amber-950">
        {part}
      </mark>
    ) : (
      part
    );
  });
}
export function LibraryView() {
  const userId = useAuthStore((s) => s.user?.id ?? "");
  return <LibrarySession key={`${getDesktopBackendBase()}:${userId}`} userId={userId} />;
}
function LibrarySession({ userId }: { userId: string }) {
  const projects = useProjectStore((s) => s.projects),
    target = useLibraryStore((s) => s.target);
  const backend = useRef(getDesktopBackendBase()).current;
  const identity = `${backend}:${userId}`;
  const [resume] = useState(() => {
    const { browsePosition, target } = useLibraryStore.getState();
    return !target && browsePosition?.identity === identity ? browsePosition : null;
  });
  const [scopeKey, setScopeKey] = useState(() => {
    if (resume) return resume.scopeKey;
    const projectId = useProjectStore.getState().activeProjectId;
    return projectId ? `project:${projectId}` : "personal";
  });
  const [favoriteOnly, setFavoriteOnly] = useState(resume?.filters.favoriteOnly ?? false),
    [tagFilter, setTagFilter] = useState(resume?.filters.tag ?? "");
  const [folderId, setFolderId] = useState(resume?.filters.folderId),
    [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [documents, setDocuments] = useState<LibraryDocument[]>([]),
    [stats, setStats] = useState<LibraryStats | null>(null),
    [selectedId, setSelectedId] = useState(""),
    [document, setDocument] = useState<LibraryDocumentDetail | null>(null);
  const [query, setQuery] = useState(resume?.query ?? ""),
    [results, setResults] = useState<LibrarySearchResult[] | null>(null),
    [matched, setMatched] = useState<LibrarySearchResult | null>(null);
  const [bulkSelection, setBulkSelection] = useState<Map<string, number> | null>(null);
  const [folderAction, setFolderAction] = useState<LibraryFolderAction | null>(null);
  const [questionSource, setQuestionSource] = useState<LibraryQuestionSelection>();
  const [sourceChanged, setSourceChanged] = useState(false);
  const [pdfSource, setPdfSource] = useState<LibraryPdfSource | null>(null);
  const textDisclosure = useRef<HTMLDetailsElement>(null);
  const textMatch = useRef<HTMLElement>(null);
  const [displayNameDraft, setDisplayNameDraft] = useState(""),
    [tagsDraft, setTagsDraft] = useState("");
  const [loading, setLoading] = useState(true),
    [detailLoading, setDetailLoading] = useState(false),
    [searching, setSearching] = useState(resume?.searched ?? false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [listError, setListError] = useState(""),
    [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<
      "upload" | "question" | "history" | "ocr" | "versions" | null
    >(null),
    [deleting, setDeleting] = useState(false),
    [refresh, setRefresh] = useState(0);
  const live = useRef(false),
    lock = useRef(false),
    epoch = useRef(0),
    listEpoch = useRef(0),
    detailEpoch = useRef(0),
    searchEpoch = useRef(0),
    selected = useRef(""),
    preferredDocument = useRef(resume?.documentId),
    currentScope = useRef(scopeKey);
  const scope = scopeFromKey(scopeKey);
  const nameScope = (scope: LibraryFilter) =>
    scope.kind === "project"
      ? (projects.find((p) => p.id === scope.projectId)?.name ?? label("library.unavailableScope"))
      : label(scope.kind === "all" ? "library.all" : "library.personal");
  const scopeName = nameScope(scope);
  const questionScope = questionSource?.scope ?? scope;
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
    preferredDocument.current = undefined;
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
    setBulkSelection(null);
    epoch.current++;
    searchEpoch.current++;
    setSearching(false);
    currentScope.current = key;
    setScopeKey(key);
    setDocuments([]);
    setFolders([]);
    setFolderAction(null);
    setPdfSource(null);
    setFavoriteOnly(false);
    setTagFilter("");
    setFolderId(undefined);
    setStats(null);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope and explicit refresh own the list request
  useEffect(() => {
    const token = ++listEpoch.current,
      expectedScope = scopeKey;
    const valid = () =>
      owns() && token === listEpoch.current && currentScope.current === expectedScope;
    setLoading(true);
    setListError("");
    void libraryApi
      .list(scopeFromKey(scopeKey))
      .then(({ documents: rows, stats: nextStats, folders: nextFolders }) => {
        if (!valid()) return;
        setDocuments(rows);
        setStats(nextStats);
        setFolders(nextFolders);
        if (
          !useLibraryStore.getState().target &&
          !rows.some((row) => row.id === selected.current)
        ) {
          const eligible = rows.filter((row) => inFilter(row, favoriteOnly, tagFilter, folderId));
          choose(
            (eligible.find((row) => row.id === preferredDocument.current) ?? eligible[0])?.id ?? "",
          );
        }
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
        if (valid()) {
          setDocument(document);
          setDisplayNameDraft(document.displayName);
          setTagsDraft(document.tags.join(", "));
        }
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
        setFavoriteOnly(false);
        setTagFilter("");
        setFolderId(undefined);
        setFolderAction(null);
        setPdfSource(null);
        setBulkSelection(null);
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
    setBulkSelection(null);
    searchEpoch.current++;
    setSearching(false);
    setResults(null);
    setMatched(null);
    setRefresh((v) => v + 1);
  };
  const availableTags = [...new Set(documents.flatMap((row) => row.tags))].sort();
  const inFilter = (
    row: LibraryDocument,
    favorite: boolean,
    tag: string,
    folder: string | null | undefined,
  ) =>
    (!favorite || row.isFavorite) &&
    (!tag || row.tags.includes(tag)) &&
    (folder === undefined || row.folderId === folder);
  const visibleDocuments = documents.filter((row) =>
    inFilter(row, favoriteOnly, tagFilter, folderId),
  );
  const selection = matched?.documentId === document?.id ? matched : null;
  const activeConversation = useChatStore((state) => state.currentConversation);
  const canAddToQuestion = Boolean(
    selection?.revision !== undefined &&
      activeConversation?.systemPrompt?.trimStart().startsWith(LIBRARY_SYSTEM_TAG) &&
      (activeConversation.projectId ?? null) === document?.projectId,
  );
  const matchRange =
    selection && document ? exactLibrarySourceRange(document.text, selection) : null;
  const sourcePage = selection?.location?.pageStart;
  const locateText = () => {
    if (!textDisclosure.current) return;
    textDisclosure.current.open = true;
    textMatch.current?.focus({ preventScroll: true });
    textMatch.current?.scrollIntoView({ block: "center" });
  };
  const selectedFolder = folders.find((folder) => folder.id === folderId);
  const saveFolder = (name: string) => {
    if (!folderAction || scope.kind === "all") return;
    void act(async (valid) => {
      if (folderAction.kind === "create") {
        const { folder } = await libraryApi.folderCreate(scope, name);
        if (!valid()) return;
        setFolderId(folder.id);
        setFolders((current) => [...current, folder]);
        choose("");
      } else if (folderAction.kind === "rename") {
        await libraryApi.folderRename(folderAction.folder.id, folderAction.folder.revision, name);
        if (!valid()) return;
      } else {
        await libraryApi.folderDelete(folderAction.folder.id, folderAction.folder.revision);
        if (!valid()) return;
        setFolderId(null);
        choose("");
      }
      // Selection changes invalidate the operation token. All branches above already checked it.
      if (!owns() || currentScope.current !== scopeKey) return;
      setFolderAction(null);
      reload();
    });
  };
  const displayNames = new Map(documents.map((row) => [row.id, row.displayName]));
  const persistMetadata = (favorite?: boolean, destination?: string | null) => {
    if (!document?.isCurrent) return;
    const submitted = document;
    void act(async (valid) => {
      const result = await libraryApi.updateMetadata(submitted.id, {
        expectedRevision: submitted.revision,
        ...(destination !== undefined
          ? { folderId: destination }
          : favorite !== undefined
            ? { isFavorite: favorite }
            : {
                displayName: displayNameDraft,
                tags: tagsDraft
                  .split(/[,，]/u)
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              }),
      });
      if (!valid()) return;
      setDocument(result.document);
      setDocuments((rows) =>
        rows.map((row) => {
          if (row.id !== submitted.id) return row;
          const { displayName, tags, isFavorite, revision, folderId } = result.document;
          return { ...row, displayName, tags, isFavorite, revision, folderId };
        }),
      );
      if (favorite === undefined && destination === undefined) {
        setDisplayNameDraft(result.document.displayName);
        setTagsDraft(result.document.tags.join(", "));
        if (
          tagFilter &&
          !result.document.tags.includes(tagFilter) &&
          !documents.some((row) => row.id !== submitted.id && row.tags.includes(tagFilter))
        )
          setTagFilter("");
        setNotice(label("library.metadataSaved"));
      }
      if (
        destination !== undefined &&
        !inFilter(result.document, favoriteOnly, tagFilter, folderId)
      )
        choose(visibleDocuments.find((row) => row.id !== submitted.id)?.id ?? "");
      if (destination !== undefined) setNotice(label("library.folderMoved"));
      setBulkSelection(null);
      setResults(null);
      setMatched(null);
    });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh only for the queue this session found on mount
  useEffect(() => {
    const { runningUpload, identity } = useLibraryDraftStore.getState();
    if (!runningUpload) return;
    return useLibraryDraftStore.subscribe((next, previous) => {
      if (
        previous.runningUpload === runningUpload &&
        next.runningUpload === null &&
        next.identity === identity &&
        owns()
      )
        reload();
    });
  }, [backend, userId]);
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
  const handoff = async (
    prepared: PreparedLibraryQuestion,
    valid: () => boolean,
    selectedSource = false,
  ) => {
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
    useLibraryDraftStore.getState().setQuestion(null, selectedSource);
    if (useChatStore.getState().messages.length === 0)
      useDesktopShellStore.getState().setPendingPrompt({
        text: question.question,
        librarySources: question.sources,
        files: [],
        conversationId: id,
        autoSend: false,
      });
    useDesktopShellStore.getState().setActiveView("chat");
  };
  const prepare = (input: PrepareLibraryQuestionInput) =>
    act(async (valid) => {
      const prepared = await libraryApi.prepare(input).catch((error: unknown) => {
        if (valid() && error instanceof LibraryApiError && error.code === "library_source_changed")
          setSourceChanged(true);
        throw error;
      });
      if (valid()) await handoff(prepared, valid, !!input.source);
    });
  const openQuestion = async (id: string) => {
    await act(async (valid) => {
      const prepared = await libraryApi.question(id);
      if (valid()) await handoff(prepared, valid);
    });
  };
  const search = async (
    options: LibraryListOptions = { favoriteOnly, tag: tagFilter, folderId },
    position?: LibraryBrowsePosition,
  ) => {
    setBulkSelection(null);
    const token = ++searchEpoch.current,
      navigation = useLibraryStore.getState().navigationRevision,
      expectedScope = scopeKey,
      text = query.trim();
    if (!text) {
      setResults(null);
      return;
    }
    const valid = () =>
      owns() &&
      token === searchEpoch.current &&
      currentScope.current === expectedScope &&
      navigation === useLibraryStore.getState().navigationRevision;
    setSearching(true);
    setError("");
    try {
      const { results } = await libraryApi.search(scope, text, options);
      if (!valid()) return;
      let result = results.find((row) => row.documentId === position?.documentId) ?? results[0];
      const match = position?.match;
      if (
        result &&
        result.documentId === position?.documentId &&
        match &&
        match.index > 0 &&
        match.index < (result.matchCount ?? 0) &&
        match.revision === result.revision
      ) {
        try {
          const response = await libraryApi.search(scope, text, options, {
            documentId: result.documentId,
            index: match.index,
            revision: match.revision,
          });
          result = response.results[0] ?? result;
        } catch (error) {
          if (!(error instanceof LibraryApiError && error.code === "library_conflict")) throw error;
        }
      }
      if (!valid()) return;
      setResults(results);
      if (result) choose(result.documentId, result.matchCount === 0 ? null : result);
    } catch (error) {
      if (valid()) setError(libraryError(error));
    } finally {
      if (valid()) setSearching(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: replay only the search captured when this session mounted
  useEffect(() => {
    if (resume?.searched && !useLibraryStore.getState().target) void search(resume.filters, resume);
  }, [resume]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: owns() guards writes for this mounted identity
  useEffect(() => {
    if (!owns() || target || searching || loading) return;
    useLibraryStore.getState().saveBrowsePosition({
      identity,
      scopeKey,
      filters: { favoriteOnly, tag: tagFilter, folderId },
      query,
      searched: results !== null,
      documentId: selectedId,
      match:
        matched?.revision === undefined
          ? undefined
          : { index: matched.matchIndex ?? 0, revision: matched.revision },
    });
  }, [
    identity,
    scopeKey,
    favoriteOnly,
    tagFilter,
    folderId,
    query,
    results,
    selectedId,
    matched,
    target,
    searching,
    loading,
  ]);
  const stepMatch = (delta: number) => {
    if (searching || !selection || selection.revision === undefined) return;
    const revision = selection.revision;
    const index = (selection.matchIndex ?? 0) + delta;
    if (index < 0 || index >= (selection.matchCount ?? 0)) return;
    const token = searchEpoch.current;
    void act(async (valid) => {
      const { results } = await libraryApi.search(
        scope,
        query.trim(),
        { favoriteOnly, tag: tagFilter, folderId },
        {
          documentId: selection.documentId,
          index,
          revision,
        },
      );
      if (valid() && token === searchEpoch.current && results[0]) setMatched(results[0]);
    });
  };
  const changeFilters = (
    nextFavorite: boolean,
    nextTag: string,
    nextFolder: string | null | undefined,
  ) => {
    setBulkSelection(null);
    setFavoriteOnly(nextFavorite);
    setTagFilter(nextTag);
    setFolderId(nextFolder);
    if (results !== null || searching) {
      setResults(null);
      setMatched(null);
      void search({ favoriteOnly: nextFavorite, tag: nextTag, folderId: nextFolder });
      return;
    }
    const eligible = (row: LibraryDocument) => inFilter(row, nextFavorite, nextTag, nextFolder);
    if (!documents.some((row) => row.id === selected.current && eligible(row)))
      choose(documents.find(eligible)?.id ?? "");
  };
  const status = (row: LibraryDocument) =>
    row.errorCode === "library_cloud_required"
      ? label("library.ocr.required")
      : label(
          row.status === "indexing" && row.canIndex
            ? "library.status.expired"
            : `library.status.${row.status}`,
        );
  const selectableDocuments = results
    ? results.flatMap(({ documentId, revision }) =>
        revision === undefined ? [] : [{ id: documentId, revision }],
      )
    : visibleDocuments;
  const bulkDisabled = busy || searching;
  const renderDocumentRow = (
    id: string,
    name: string,
    revision: number | undefined,
    row: ReactNode,
  ) => (
    <div key={id} className={cn(bulkSelection && "flex min-w-0 items-start gap-2")}>
      {bulkSelection && (
        <Checkbox
          checked={bulkSelection.has(id)}
          disabled={bulkDisabled || revision === undefined}
          aria-label={format("library.bulkSelectDocument", { name })}
          className="mt-3.5 ml-0.5 border-stone-400 bg-white data-[state=checked]:border-amber-400 data-[state=checked]:bg-amber-100 data-[state=checked]:text-amber-950"
          onCheckedChange={(checked) => {
            if (revision === undefined) return;
            setBulkSelection((current) => {
              if (!current) return null;
              const updated = new Map(current);
              if (checked === true) updated.set(id, revision);
              else updated.delete(id);
              return updated;
            });
          }}
        />
      )}
      {row}
    </div>
  );
  const moveSelected = (folder: string | null | undefined) => {
    if (scope.kind === "all" || folder === undefined || !bulkSelection?.size) return;
    const moving = Array.from(bulkSelection, ([documentId, expectedRevision]) => ({
      documentId,
      expectedRevision,
    }));
    void act(async (valid) => {
      const { moved } = await libraryApi.moveDocuments({
        scope,
        folderId: folder,
        documents: moving,
      });
      if (!valid()) return;
      setBulkSelection(null);
      if (moved > 0) {
        if (folderId !== undefined && folder !== folderId && bulkSelection.has(selected.current))
          choose("");
        reload();
        if (results !== null) void search();
      }
      notifySuccess(
        moved > 0
          ? format("library.bulkMoved", { count: moved })
          : label("library.bulkAlreadyInFolder"),
        folders.find((entry) => entry.id === folder)?.name ?? label("library.uncategorized"),
      );
    });
  };
  const openDialog = (value: typeof dialog) => {
    setError("");
    setQuestionSource(undefined);
    setSourceChanged(false);
    setDialog(value);
  };
  const addSelectionToQuestion = () => {
    if (!canAddToQuestion || !activeConversation || !selection || selection.revision === undefined)
      return;
    const id = activeConversation.id;
    const reference = {
      documentId: selection.documentId,
      chunkIndex: selection.chunkIndex,
      revision: selection.revision,
    };
    void act(async (valid) => {
      const { source } = await libraryApi.conversationSource(id, reference);
      const chat = useChatStore.getState();
      if (!valid() || chat.currentConversation?.id !== id) return;
      if (chat.isStreaming) throw new LibraryApiError("library_index_busy");
      const draftStore = useConversationDraftStore.getState();
      if (draftStore.owner !== identity) return;
      const draft = draftStore.drafts[id] ?? { text: "", files: [] };
      const updated = appendLibraryChatDraftSource(chat.messages, id, draft, source);
      if (!updated) throw new LibraryApiError("library_draft_sources_limit");
      draftStore.update(identity, id, (current) => ({ ...current, ...updated }));
      useDesktopShellStore.getState().setActiveView("chat");
    });
  };
  const askSelection = () => {
    if (!document || !selection || selection.revision === undefined) return;
    const sourceScope: LibraryScope =
      scope.kind !== "all"
        ? scope
        : document.projectId
          ? { kind: "project", projectId: document.projectId }
          : { kind: "personal" };
    openDialog("question");
    setQuestionSource({
      scope: sourceScope,
      reference: {
        documentId: selection.documentId,
        chunkIndex: selection.chunkIndex,
        revision: selection.revision,
      },
      fileName: selection.fileName,
      location: selection.location,
    });
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="library-view">
      <div data-tauri-drag-region className="h-8 shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
        <div className="mx-auto max-w-6xl space-y-5">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
            <h1 className="text-xl font-semibold tracking-tight">{label("library.title")}</h1>
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
                      <DropdownMenuItem onSelect={() => setDialog("versions")}>
                        {label("library.versions")}
                      </DropdownMenuItem>
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
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-pressed={favoriteOnly}
              className={cn(
                "h-9",
                favoriteOnly && "bg-amber-100 text-amber-950 hover:bg-amber-200",
              )}
              disabled={busy}
              onClick={() => changeFilters(!favoriteOnly, tagFilter, folderId)}
            >
              <Star size={14} className={cn(favoriteOnly && "fill-current")} />
              {label("library.favoriteOnly")}
            </Button>
            {(availableTags.length > 0 || tagFilter) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    aria-label={label("library.tagFilter")}
                    className="h-9 max-w-[180px]"
                  >
                    <span className="truncate">{tagFilter || label("library.allTags")}</span>
                    <ChevronDown size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="max-h-60 max-w-[260px] overflow-y-auto border-stone-200 bg-stone-50 text-stone-900"
                >
                  {["", ...new Set([...availableTags, ...(tagFilter ? [tagFilter] : [])])].map(
                    (tag) => (
                      <DropdownMenuItem
                        key={tag}
                        aria-current={tagFilter === tag ? "true" : undefined}
                        className={cn(
                          "min-w-36 gap-3 break-all focus:bg-amber-100 focus:text-amber-950",
                          tagFilter === tag && "bg-amber-100 text-amber-950",
                        )}
                        onSelect={() => changeFilters(favoriteOnly, tag, folderId)}
                      >
                        <span className="flex-1">{tag || label("library.allTags")}</span>
                        {tagFilter === tag && <Check size={14} className="shrink-0" />}
                      </DropdownMenuItem>
                    ),
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {scope.kind !== "all" && (
              <LibraryFolderPicker
                folders={folders}
                value={folderId}
                disabled={busy}
                onChange={(next) => changeFilters(favoriteOnly, tagFilter, next)}
              >
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className={libraryFolderMenuItemClass}
                  onSelect={() => {
                    setError("");
                    setFolderAction({ kind: "create" });
                  }}
                >
                  {label("library.newFolder")}
                </DropdownMenuItem>
                {selectedFolder && (
                  <>
                    <DropdownMenuItem
                      className={libraryFolderMenuItemClass}
                      onSelect={() => {
                        setError("");
                        setFolderAction({ kind: "rename", folder: selectedFolder });
                      }}
                    >
                      {label("library.renameFolder")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-rose-700 focus:bg-rose-50 focus:text-rose-800"
                      onSelect={() => {
                        setError("");
                        setFolderAction({ kind: "delete", folder: selectedFolder });
                      }}
                    >
                      {label("library.deleteFolder")}
                    </DropdownMenuItem>
                  </>
                )}
              </LibraryFolderPicker>
            )}
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
                  setBulkSelection(null);
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
          {stats && (
            <p className="text-xs text-muted-foreground">
              {format("library.usage", {
                documents: stats.documents,
                documentLimit: stats.documentLimit,
                bytes: formatBytes(stats.bytes),
                byteLimit: formatBytes(stats.byteLimit),
              })}
            </p>
          )}
          {error && !dialog && !folderAction && (
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
          ) : results === null &&
            !visibleDocuments.length &&
            (favoriteOnly || tagFilter || folderId !== undefined) ? (
            <div className="space-y-3 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                {label(
                  selectedFolder && !favoriteOnly && !tagFilter
                    ? "library.folderEmpty"
                    : "library.noFilteredDocuments",
                )}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => changeFilters(false, "", undefined)}
              >
                {label("library.clearFilters")}
              </Button>
            </div>
          ) : !documents.length ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <BookOpen size={30} strokeWidth={1.2} className="text-muted-foreground/60" />
              <p className="text-sm font-medium">{label("library.empty")}</p>
              <Button
                size="sm"
                variant="outline"
                disabled={scope.kind === "all" || busy}
                onClick={() => setDialog("upload")}
              >
                <Upload size={14} />
                {label("library.import")}
              </Button>
            </div>
          ) : (
            <div className="grid min-h-[420px] grid-cols-1 gap-6 md:grid-cols-[260px_minmax(0,1fr)]">
              <aside
                className="space-y-2"
                aria-label={results ? label("library.searchResults") : label("library.title")}
              >
                {scope.kind !== "all" &&
                  selectableDocuments.length > 0 &&
                  (bulkSelection ? (
                    <div className="space-y-2 rounded-md border border-amber-100 bg-amber-50/60 px-2 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-x-2">
                        <output className="text-xs font-medium text-amber-950">
                          {format("library.bulkSelected", { count: bulkSelection.size })}
                        </output>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 hover:bg-amber-100"
                          disabled={bulkDisabled}
                          onClick={() => setBulkSelection(null)}
                        >
                          {label("library.bulkFinish")}
                        </Button>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <LibraryFolderPicker
                          folders={folders}
                          value={undefined}
                          actionLabel={label("library.moveFolder")}
                          disabled={bulkDisabled || !bulkSelection.size}
                          onChange={moveSelected}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          className="px-2 hover:bg-amber-100"
                          disabled={bulkDisabled}
                          onClick={() =>
                            setBulkSelection(
                              bulkSelection.size === selectableDocuments.length
                                ? new Map()
                                : new Map(
                                    selectableDocuments.map(({ id, revision }) => [id, revision]),
                                  ),
                            )
                          }
                        >
                          {label(
                            bulkSelection.size === selectableDocuments.length
                              ? "library.bulkClear"
                              : "library.bulkSelectAll",
                          )}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={bulkDisabled}
                      onClick={() => setBulkSelection(new Map())}
                    >
                      {label("library.bulkOrganize")}
                    </Button>
                  ))}
                {results !== null && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {format("library.searchDocuments", { count: results.length })}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setBulkSelection(null);
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
                    results.map((result) =>
                      renderDocumentRow(
                        result.documentId,
                        displayNames.get(result.documentId) ?? result.fileName,
                        result.revision,
                        <button
                          type="button"
                          disabled={busy || searching}
                          aria-pressed={selectedId === result.documentId}
                          onClick={() =>
                            choose(result.documentId, result.matchCount === 0 ? null : result)
                          }
                          className={cn(
                            "w-full min-w-0 space-y-1 rounded-md px-3 py-3 text-left hover:bg-amber-50 focus-visible:ring-2 focus-visible:ring-ring",
                            selectedId === result.documentId && "bg-amber-50",
                          )}
                        >
                          <span className="block truncate text-sm font-medium">
                            {highlightText(
                              displayNames.get(result.documentId) ?? result.fileName,
                              query,
                            )}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {result.matchCount === 0
                              ? label("library.titleMatch")
                              : format("library.matchCount", { count: result.matchCount ?? 1 })}
                          </span>
                          {result.matchCount === 0 &&
                            (displayNames.get(result.documentId) ?? result.fileName) !==
                              result.fileName && (
                              <span className="block truncate text-xs text-muted-foreground">
                                {highlightText(result.fileName, query)}
                              </span>
                            )}
                          {result.matchCount !== 0 && (
                            <>
                              {formatLibraryLocation(result.location) && (
                                <span className="block text-xs text-muted-foreground">
                                  {formatLibraryLocation(result.location)}
                                </span>
                              )}
                              <span className="line-clamp-2 break-words text-xs text-muted-foreground">
                                {highlightText(result.snippet ?? result.text, query, true)}
                              </span>
                            </>
                          )}
                        </button>,
                      ),
                    )
                  )
                ) : (
                  visibleDocuments.map((row) =>
                    renderDocumentRow(
                      row.id,
                      row.displayName,
                      row.revision,
                      <button
                        type="button"
                        aria-pressed={selectedId === row.id}
                        disabled={busy || searching}
                        onClick={() => choose(row.id)}
                        className={cn(
                          "w-full min-w-0 space-y-1 rounded-md px-3 py-3 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
                          selectedId === row.id && "bg-muted",
                        )}
                      >
                        <span className="block truncate text-sm font-medium">
                          {row.displayName}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {status(row)} · {format("library.version", { number: row.version })} ·{" "}
                          {Math.ceil(row.fileSize / 1024)} KB
                        </span>
                      </button>,
                    ),
                  )
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
                      <h2 className="break-words text-base font-medium">{document.displayName}</h2>
                      {document.displayName !== document.fileName && (
                        <p className="break-all text-xs text-muted-foreground">
                          {document.fileName}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {status(document)} ·{" "}
                        {format("library.version", { number: document.version })} ·{" "}
                        {format("library.chunks", {
                          count: document.chunkCount,
                          size: Math.ceil(document.fileSize / 1024),
                        })}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {document.isCurrent && (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-pressed={document.isFavorite}
                          className={cn(
                            document.isFavorite && "bg-amber-100 text-amber-950 hover:bg-amber-200",
                          )}
                          disabled={busy}
                          onClick={() => persistMetadata(!document.isFavorite)}
                        >
                          {label(
                            document.isFavorite ? "library.favoriteRemove" : "library.favoriteAdd",
                          )}
                        </Button>
                      )}
                      {document.isCurrent && (
                        <LibraryFolderPicker
                          folders={folders.filter(
                            (folder) => folder.projectId === document.projectId,
                          )}
                          value={document.folderId}
                          disabled={busy}
                          onChange={(destination) => {
                            if (destination !== undefined && destination !== document.folderId)
                              persistMetadata(undefined, destination);
                          }}
                        />
                      )}
                      {document.tags.map((tag) => (
                        <span key={tag} className="rounded-full bg-muted px-2 py-1 text-xs">
                          {tag}
                        </span>
                      ))}
                    </div>
                    {document.isCurrent && (
                      <details key={document.id} className="space-y-3 rounded-md border px-3 py-2">
                        <summary className="cursor-pointer text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring">
                          {label("library.editMetadata")}
                        </summary>
                        <div className="space-y-3 pt-2">
                          <Label htmlFor="library-display-name">
                            {label("library.displayName")}
                          </Label>
                          <Input
                            id="library-display-name"
                            value={displayNameDraft}
                            maxLength={200}
                            disabled={busy}
                            onChange={(event) => setDisplayNameDraft(event.target.value)}
                          />
                          <Label htmlFor="library-document-tags">{label("library.tags")}</Label>
                          <Input
                            id="library-document-tags"
                            value={tagsDraft}
                            placeholder={label("library.tagsPlaceholder")}
                            maxLength={600}
                            disabled={busy}
                            onChange={(event) => setTagsDraft(event.target.value)}
                          />
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              className="bg-amber-100 text-amber-950 hover:bg-amber-200"
                              disabled={busy || !displayNameDraft.trim()}
                              onClick={() => persistMetadata()}
                            >
                              {label("library.saveMetadata")}
                            </Button>
                          </div>
                        </div>
                      </details>
                    )}
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
                    {selection && (
                      <div className="space-y-2 border-l-2 border-foreground/25 pl-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="text-xs font-medium">
                            {[
                              selection.heading,
                              formatLibraryLocation(selection.location),
                              format("library.chunk", { number: selection.chunkIndex + 1 }),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </h3>
                          {sourcePage !== undefined ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setPdfSource({
                                  documentId: document.id,
                                  fileName: document.fileName,
                                  page: sourcePage,
                                })
                              }
                            >
                              {format("library.openPdfPage", { number: sourcePage })}
                            </Button>
                          ) : (
                            matchRange && (
                              <Button variant="outline" size="sm" onClick={locateText}>
                                {label("library.locateText")}
                              </Button>
                            )
                          )}
                        </div>
                        {(selection.matchCount ?? 0) > 1 && selection.revision !== undefined && (
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              size="icon"
                              variant="outline"
                              className="h-8 w-8"
                              aria-label={label("library.previousMatch")}
                              disabled={busy || searching || (selection.matchIndex ?? 0) === 0}
                              onClick={() => stepMatch(-1)}
                            >
                              <ChevronLeft size={14} />
                            </Button>
                            <output className="text-xs text-muted-foreground" aria-live="polite">
                              {format("library.matchPosition", {
                                index: (selection.matchIndex ?? 0) + 1,
                                count: selection.matchCount ?? 0,
                              })}
                            </output>
                            <Button
                              type="button"
                              size="icon"
                              variant="outline"
                              className="h-8 w-8"
                              aria-label={label("library.nextMatch")}
                              disabled={
                                busy ||
                                searching ||
                                (selection.matchIndex ?? 0) + 1 === selection.matchCount
                              }
                              onClick={() => stepMatch(1)}
                            >
                              <ChevronRight size={14} />
                            </Button>
                          </div>
                        )}
                        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">
                          {selection.text}
                        </pre>
                        {selection.revision !== undefined && (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="hover:bg-accent hover:text-accent-foreground"
                              disabled={busy || searching}
                              onClick={askSelection}
                            >
                              {label("library.askSource")}
                            </Button>
                            {canAddToQuestion && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                title={activeConversation?.title}
                                className="hover:bg-accent hover:text-accent-foreground"
                                disabled={busy || searching}
                                onClick={addSelectionToQuestion}
                              >
                                {label("library.addSourceToQuestion")}
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {document.text ? (
                      <details ref={textDisclosure} open={!selection} className="space-y-3">
                        <summary className="w-fit cursor-pointer rounded text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring">
                          {label("library.originalText")}
                        </summary>
                        <pre className="max-h-[65vh] overflow-y-auto whitespace-pre-wrap break-words pt-2 font-sans text-sm leading-7">
                          {matchRange ? (
                            <>
                              {document.text.slice(0, matchRange.start)}
                              <mark
                                ref={textMatch}
                                tabIndex={-1}
                                className="rounded bg-amber-100 text-amber-950 focus:outline-none"
                              >
                                {selection?.text}
                              </mark>
                              {document.text.slice(matchRange.end)}
                            </>
                          ) : (
                            document.text
                          )}
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
              onConfirm={(connectionToken) =>
                act(async (valid) => {
                  const result = await libraryApi.ocr(document.id, connectionToken);
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
          {folderAction && (
            <LibraryFolderDialog
              action={folderAction}
              busy={busy}
              error={error}
              scopeName={scopeName}
              onClose={() => {
                setFolderAction(null);
                setError("");
              }}
              onSubmit={saveFolder}
            />
          )}
          {dialog === "upload" && scope.kind !== "all" && (
            <LibraryUploadDialog
              key={scopeKey}
              scope={scope}
              scopeName={scopeName}
              defaultFolderId={folderId}
              folders={folders}
              foldersLoading={loading}
              errorMessage={error}
              owns={() => owns() && currentScope.current === scopeKey}
              onClose={() => setDialog(null)}
              onUpload={async (destination, file, destinationFolderId) => {
                let accepted = false;
                await act(async (valid) => {
                  if (!valid() || currentScope.current !== scopeKey) return;
                  const result = await libraryApi.upload(destination, file, destinationFolderId);
                  accepted = true;
                  if (valid()) {
                    if (inFilter(result.document, favoriteOnly, tagFilter, folderId))
                      choose(result.document.id);
                    reload();
                  }
                });
                return accepted;
              }}
            />
          )}
          {dialog === "question" && questionScope.kind !== "all" && (
            <LibraryQuestionDialog
              scope={questionScope}
              scopeName={nameScope(questionScope)}
              selectedSource={questionSource}
              errorMessage={error}
              onClose={() => openDialog(null)}
              onReselect={
                sourceChanged
                  ? () => {
                      openDialog(null);
                      reload();
                    }
                  : undefined
              }
              onPrepare={prepare}
            />
          )}
          {dialog === "history" && (
            <LibraryHistoryDialog
              owns={owns}
              errorMessage={error}
              onClose={() => setDialog(null)}
              onOpen={openQuestion}
              onPreview={setPdfSource}
            />
          )}
          {pdfSource && (
            <LibraryPdfSourceDialog source={pdfSource} onClose={() => setPdfSource(null)} />
          )}
          {dialog === "versions" && document && (
            <LibraryVersionsDialog
              document={document}
              status={status}
              onClose={() => setDialog(null)}
              onDownload={async (version) => {
                await act(async (valid) => {
                  const blob = await libraryApi.original(version.id);
                  if (!valid()) return;
                  const path = await saveAttachment(blob, version.fileName, valid);
                  if (valid() && (path || !isDesktopRuntime()))
                    setNotice(label(path ? "library.saved" : "library.downloadStarted"));
                });
              }}
              onRestore={async (version) => {
                await act(async (valid) => {
                  const result = await libraryApi.restore(version.id, version.revision);
                  if (!valid()) return;
                  const detail = await libraryApi.get(result.document.id);
                  if (!valid()) return;
                  setDocument(detail.document);
                  setDialog(null);
                  reload();
                  setNotice(label("library.versionRestored"));
                });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
