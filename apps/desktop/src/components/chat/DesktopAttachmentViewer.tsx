import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  File,
  Maximize2,
  MoreHorizontal,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type KeyboardEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui";
import {
  attachmentKind,
  canOpenAttachment,
  loadAttachmentBlob,
  openAttachmentInDefaultApp,
  previewMediaType,
  readPreviewText,
  saveAttachment,
} from "../../lib/attachmentPreview";
import { getChatLabel } from "../../lib/i18n/agent";
import { isDesktopRuntime } from "../../lib/tauriBridge";
import type { MessageAttachmentMeta } from "../../types/chat";

const PdfPreview = lazy(() =>
  import("./DesktopAttachmentPdf").then((m) => ({ default: m.DesktopAttachmentPdf })),
);
const actionClass =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";
type Source = { blob: Blob; url: string; text: string; truncated: boolean };

function TextPreview({
  text,
  markdown,
  truncated,
}: {
  text: string;
  markdown: boolean;
  truncated: boolean;
}) {
  const [query, setQuery] = useState("");
  const [rendered, setRendered] = useState(markdown && text.length < 200_000);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const matches: number[] = [];
  if (query) {
    const haystack = text.toLowerCase();
    const needle = query.toLowerCase();
    for (
      let at = haystack.indexOf(needle);
      at >= 0 && matches.length < 1000;
      at = haystack.indexOf(needle, at + needle.length)
    )
      matches.push(at);
  }
  const selected = matches[matchIndex % Math.max(1, matches.length)];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setMatchIndex(0);
            setRendered(false);
          }}
          placeholder={getChatLabel("chat.attachment.search")}
          aria-label={getChatLabel("chat.attachment.search")}
          className="min-w-0 flex-1 rounded-md border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {query && (
          <button
            type="button"
            className={actionClass}
            disabled={!matches.length}
            onClick={() => setMatchIndex((i) => i + 1)}
          >
            {matches.length ? (matchIndex % matches.length) + 1 : 0} / {matches.length}
            {matches.length === 1000 ? "+" : ""}
          </button>
        )}
        {markdown && (
          <button
            type="button"
            className={actionClass}
            disabled={text.length >= 200_000}
            onClick={() => {
              setRendered((v) => !v);
              setQuery("");
            }}
          >
            {getChatLabel(rendered ? "chat.attachment.source" : "chat.attachment.rendered")}
          </button>
        )}
        <button
          type="button"
          className={actionClass}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(
              () => {
                setCopied(true);
                setCopyError(false);
              },
              () => setCopyError(true),
            );
          }}
        >
          <Copy aria-hidden="true" className="size-4" />
          {getChatLabel(copied ? "chat.attachment.copied" : "chat.attachment.copy")}
        </button>
      </div>
      {truncated && (
        <p className="border-b px-4 py-2 text-sm text-muted-foreground">
          {getChatLabel("chat.attachment.truncated")}
        </p>
      )}
      {markdown && text.length >= 200_000 && (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          {getChatLabel("chat.attachment.largeMarkdown")}
        </p>
      )}
      {copyError && (
        <p role="alert" className="px-4 text-sm text-destructive">
          {getChatLabel("chat.attachment.actionFailed")}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {rendered ? (
          <div className="prose prose-sm max-w-none break-words dark:prose-invert">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                img: ({ alt }) => <span>{alt}</span>,
                a: ({ children }) => <span className="underline">{children}</span>,
              }}
            >
              {text}
            </ReactMarkdown>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-6">
            {text.length === 0 ? (
              getChatLabel("chat.attachment.empty")
            ) : selected === undefined ? (
              text
            ) : (
              <>
                {text.slice(0, selected)}
                <mark
                  ref={(element) => {
                    if (element) {
                      const container = element.closest("pre")?.parentElement;
                      if (container)
                        container.scrollTop = element.offsetTop - container.offsetTop - 80;
                    }
                  }}
                >
                  {text.slice(selected, selected + query.length)}
                </mark>
                {text.slice(selected + query.length)}
              </>
            )}
          </pre>
        )}
      </div>
    </div>
  );
}

export function DesktopAttachmentViewer({
  attachments,
  index,
  onIndexChange,
  onClose,
  file,
  presentation = "dialog",
  onOpenExternal,
  allowExport = true,
  allowExpand = true,
  closeLabel = getChatLabel("chat.attachment.close"),
}: {
  attachments: MessageAttachmentMeta[];
  index: number;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
  file?: File;
  presentation?: "panel" | "dialog";
  onOpenExternal?: () => Promise<void>;
  allowExport?: boolean;
  allowExpand?: boolean;
  closeLabel?: string;
}) {
  const att = attachments[index];
  const [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [retry, setRetry] = useState(0);
  const kind = att ? attachmentKind(att) : "file";
  const pdfError = useCallback(() => setMediaError(true), []);
  useEffect(() => {
    // retry intentionally restarts this read without changing its source.
    void retry;
    const controller = new AbortController();
    let url: string | undefined;
    setSource(null);
    setError(null);
    setMediaError(false);
    setActionError(false);
    setZoom(1);
    if (att)
      void (async () => {
        const original = await loadAttachmentBlob(att, file, controller.signal);
        const text =
          kind === "text" || kind === "markdown"
            ? await readPreviewText(original)
            : { text: "", truncated: false };
        if (controller.signal.aborted) return;
        // Reapply MIME for files whose upload metadata was application/octet-stream.
        const blob = new Blob([original], {
          type: previewMediaType(att, original.type),
        });
        url = URL.createObjectURL(blob);
        setSource({ blob, url, ...text });
      })().catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "network");
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [att, file, kind, retry]);
  if (!att) return null;
  const runFileAction = async (action: "open" | "export") => {
    if (!source) return;
    setBusy(true);
    setActionError(false);
    try {
      if (action === "open") {
        if (onOpenExternal) await onOpenExternal();
        else await openAttachmentInDefaultApp(source.blob, att.fileName);
      } else await saveAttachment(source.blob, att.fileName);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };
  const navigateImage = (direction: number) => {
    for (let next = index + direction; next >= 0 && next < attachments.length; next += direction) {
      if (attachmentKind(attachments[next]) === "image") {
        onIndexChange?.(next);
        return;
      }
    }
  };
  const previous = attachments.slice(0, index).some((a) => attachmentKind(a) === "image");
  const next = attachments.slice(index + 1).some((a) => attachmentKind(a) === "image");
  const inDialog = presentation === "dialog" || expanded;
  const Heading = inDialog ? DialogTitle : "h2";
  const Description = inDialog ? DialogDescription : "p";
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (kind !== "image" || !onIndexChange) return;
    // Arrow keys belong to focused inputs/buttons unless the reader itself owns focus.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      navigateImage(-1);
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      navigateImage(1);
    }
  };
  const content = (
    <>
      <div className="relative shrink-0 border-b px-5 pb-3 pr-12 pt-5">
        {!inDialog && (
          <button
            type="button"
            className="absolute right-2 top-3 rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onClose}
            aria-label={closeLabel}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}

        <Heading className="break-all text-base font-semibold leading-6">{att.fileName}</Heading>
        <Description className="mt-1 text-xs text-muted-foreground">
          {att.fileType || getChatLabel("chat.attachment.unknownType")}
          {att.fileSize !== undefined &&
            ` · ${att.fileSize < 1024 ? `${att.fileSize} B` : `${(att.fileSize / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`}`}
        </Description>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-1">
          {!inDialog && allowExpand && (
            <button
              ref={expandButton}
              type="button"
              className={actionClass}
              onClick={() => setExpanded(true)}
              aria-label={getChatLabel("chat.attachment.expand")}
              title={getChatLabel("chat.attachment.expand")}
            >
              <Maximize2 aria-hidden="true" className="size-4" />
            </button>
          )}
          {kind === "image" && (
            <>
              <button
                type="button"
                className={actionClass}
                disabled={zoom <= 0.25}
                onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
                aria-label={getChatLabel("chat.attachment.zoomOut")}
              >
                <ZoomOut aria-hidden="true" className="size-4" />
              </button>
              <span className="text-xs">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                className={actionClass}
                disabled={zoom >= 4}
                onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
                aria-label={getChatLabel("chat.attachment.zoomIn")}
              >
                <ZoomIn aria-hidden="true" className="size-4" />
              </button>
              {onIndexChange && (
                <>
                  <button
                    type="button"
                    className={actionClass}
                    disabled={!previous}
                    onClick={() => navigateImage(-1)}
                    aria-label={getChatLabel("chat.attachment.previous")}
                  >
                    <ChevronLeft aria-hidden="true" className="size-4" />
                  </button>
                  <button
                    type="button"
                    className={actionClass}
                    disabled={!next}
                    onClick={() => navigateImage(1)}
                    aria-label={getChatLabel("chat.attachment.next")}
                  >
                    <ChevronRight aria-hidden="true" className="size-4" />
                  </button>
                </>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isDesktopRuntime() && (onOpenExternal || canOpenAttachment(att.fileName)) && (
            <button
              type="button"
              className={actionClass}
              disabled={!source || busy}
              onClick={() => {
                void runFileAction("open");
              }}
            >
              <ExternalLink aria-hidden="true" className="size-4" />
              {getChatLabel("chat.attachment.open")}
            </button>
          )}
          {allowExport && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={actionClass}
                  disabled={!source || busy}
                  aria-label={getChatLabel("chat.attachment.more")}
                  title={getChatLabel("chat.attachment.more")}
                >
                  <MoreHorizontal aria-hidden="true" className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[110]">
                <DropdownMenuItem
                  disabled={!source || busy}
                  onSelect={() => {
                    void runFileAction("export");
                  }}
                >
                  <Download aria-hidden="true" className="mr-2 size-4" />
                  {getChatLabel("chat.attachment.save")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {actionError && (
        <p role="alert" className="px-5 py-2 text-sm text-destructive">
          {getChatLabel("chat.attachment.actionFailed")}
        </p>
      )}
      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <File aria-hidden="true" className="size-10 text-muted-foreground" />
          <p role="alert" className="text-sm text-muted-foreground">
            {getChatLabel(
              error === "unavailable"
                ? "chat.attachment.unavailable"
                : error === "auth"
                  ? "chat.attachment.auth"
                  : "chat.attachment.network",
            )}
          </p>
          <button type="button" className={actionClass} onClick={() => setRetry((r) => r + 1)}>
            {getChatLabel("chat.attachment.retry")}
          </button>
        </div>
      ) : !source ? (
        <output className="p-6 text-sm text-muted-foreground">
          {getChatLabel("chat.attachment.loading")}
        </output>
      ) : mediaError ? (
        <p role="alert" className="p-6 text-sm text-muted-foreground">
          {getChatLabel("chat.attachment.mediaFailed")}
        </p>
      ) : kind === "text" || kind === "markdown" ? (
        <TextPreview
          key={source.url}
          text={source.text}
          truncated={source.truncated}
          markdown={kind === "markdown"}
        />
      ) : kind === "pdf" ? (
        <Suspense fallback={<p className="p-6">{getChatLabel("chat.attachment.loading")}</p>}>
          <PdfPreview blob={source.blob} onError={pdfError} />
        </Suspense>
      ) : kind === "image" ? (
        <div className="min-h-0 flex-1 overflow-auto bg-muted/20 p-4">
          <img
            src={source.url}
            alt={att.fileName}
            onError={() => setMediaError(true)}
            className={cn("mx-auto block object-contain", zoom === 1 && "max-h-full max-w-full")}
            style={zoom === 1 ? undefined : { width: `${zoom * 100}%`, maxWidth: "none" }}
          />
        </div>
      ) : kind === "audio" || kind === "video" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5">
          {kind === "video" ? (
            <video
              controls
              src={source.url}
              className="max-h-full max-w-full"
              onError={() => setMediaError(true)}
            >
              <track kind="captions" />
            </video>
          ) : (
            <audio controls src={source.url} onError={() => setMediaError(true)}>
              <track kind="captions" />
            </audio>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <File aria-hidden="true" className="size-12 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {getChatLabel("chat.attachment.unsupported")}
          </p>
        </div>
      )}
    </>
  );
  if (!inDialog)
    return (
      <section
        aria-label={getChatLabel("chat.attachment.preview")}
        className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground"
        onKeyDown={handleKeyDown}
      >
        {content}
      </section>
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          if (presentation === "panel") setExpanded(false);
          else onClose();
        }
      }}
    >
      <DialogContent
        className="flex h-[min(820px,90vh)] w-[94vw] max-w-5xl flex-col gap-0 overflow-hidden p-0"
        onKeyDown={handleKeyDown}
        onCloseAutoFocus={(e) => {
          if (presentation === "panel") {
            e.preventDefault();
            requestAnimationFrame(() => expandButton.current?.focus());
          }
        }}
      >
        {content}
      </DialogContent>
    </Dialog>
  );
}
