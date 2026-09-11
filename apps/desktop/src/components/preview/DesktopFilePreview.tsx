import { Check, RefreshCw } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Button, cn } from "ui";
import { formatPreviewLabel, getPreviewLabel } from "../../lib/i18n/agent";
import { languageForPath } from "../../lib/referenceLink";
import { THEME_MODE_CHANGE_EVENT } from "../../lib/theme";
import { useChatStore } from "../../stores/chatStore";
import type { PreviewTab } from "../../stores/previewPanelStore";
import { resolveProjectRootForConversation } from "../../stores/projectStore";
import { useSidecarStore } from "../../stores/sidecarStore";
import { DesktopFileOpenButton } from "./DesktopFileOpenButton";
import styles from "./desktop-preview.module.css";

type FileTab = Extract<PreviewTab, { kind: "file" }>;

// Beyond either limit Prism tokenizing blocks the main thread for seconds;
// fall back to a plain per-line render that still has numbers and the range.
const HIGHLIGHT_MAX_BYTES = 300 * 1024;
const HIGHLIGHT_MAX_LINES = 5000;

const CODE_CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: 0,
  background: "transparent",
  // The surrounding .codeScroll owns scrolling in both axes; the theme's own
  // `overflow: auto` would otherwise nest a second horizontal scrollbar.
  overflow: "visible",
  fontSize: "inherit",
  lineHeight: "inherit",
  fontFamily: "inherit",
};

const LINE_NUMBER_STYLE: React.CSSProperties = {
  minWidth: "3.2em",
  paddingRight: "0.9em",
  color: "hsl(var(--muted-foreground) / 0.55)",
  fontVariantNumeric: "tabular-nums",
  userSelect: "none",
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; content: string };

function isInRange(n: number, line: number | undefined, endLine: number | undefined): boolean {
  if (line === undefined) return false;
  return n >= line && n <= (endLine ?? line);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Reads `tab.path` through the sidecar (workspace-bounded) and renders it as
 * numbered source with the referenced range highlighted and scrolled into view.
 */
export function DesktopFilePreview({ tab, active }: { tab: FileTab; active: boolean }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [copied, setCopied] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [openExternalError, setOpenExternalError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const openErrorTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const compute = () => setIsDark(document.documentElement.classList.contains("dark"));
    compute();
    window.addEventListener(THEME_MODE_CHANGE_EVENT, compute);
    return () => window.removeEventListener(THEME_MODE_CHANGE_EVENT, compute);
  }, []);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
      if (openErrorTimerRef.current !== null) window.clearTimeout(openErrorTimerRef.current);
    };
  }, []);

  // Load (and re-load on retry). The conversation's project folder decides
  // which workspace the sidecar must be pointed at before reading; a plain
  // conversation reads from whatever root the sidecar currently has.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is the retry trigger
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const sidecar = useSidecarStore.getState();
        const chat = useChatStore.getState();
        const conversation =
          chat.conversations.find((c) => c.id === tab.conversationId) ??
          (chat.currentConversation?.id === tab.conversationId ? chat.currentConversation : null);
        const projectRoot = resolveProjectRootForConversation(conversation);
        if (projectRoot && sidecar.workspaceRoot !== projectRoot) {
          // ensureWorkspace reports failure by returning null (sidecar not
          // ready, or the project folder is gone). Reading on in the previous
          // workspace would silently show a different project's file.
          const synced = await sidecar.ensureWorkspace(projectRoot);
          if (!synced) {
            const after = useSidecarStore.getState();
            if (after.status !== "ready") {
              throw new Error(getPreviewLabel("preview.file.noWorkspace"));
            }
            throw new Error(
              after.lastError ??
                formatPreviewLabel("preview.file.projectRootUnavailable", { root: projectRoot }),
            );
          }
        }
        const client = useSidecarStore.getState().client;
        if (!client) throw new Error(getPreviewLabel("preview.file.noWorkspace"));
        const { content } = await client.readFile(tab.path);
        if (!cancelled) setState({ status: "ready", content });
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: describeError(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab.path, tab.conversationId, reloadNonce]);

  const content = state.status === "ready" ? state.content : null;
  const lines = useMemo(() => (content === null ? [] : content.split("\n")), [content]);
  const useHighlight =
    content !== null &&
    content.length <= HIGHLIGHT_MAX_BYTES &&
    lines.length <= HIGHLIGHT_MAX_LINES;
  const language = useMemo(() => languageForPath(tab.path), [tab.path]);
  const syntaxTheme = useMemo(
    () => (isDark ? oneDark : oneLight) as unknown as Record<string, React.CSSProperties>,
    [isDark],
  );

  // Centre the first referenced line once the content is in the DOM and the
  // tab is visible (scrollIntoView is a no-op inside display:none). Each
  // content + range combination scrolls once, so switching back to the tab
  // keeps the user's own scroll position, while a new link into the same file
  // (range change) or a reload (content change) re-centres.
  const scrolledKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (content === null || tab.line === undefined || !active) return;
    const key = `${tab.line}:${tab.endLine ?? ""}:${content.length}:${reloadNonce}`;
    if (scrolledKeyRef.current === key) return;
    const root = scrollRef.current;
    if (!root) return;
    const frame = window.requestAnimationFrame(() => {
      const target = root.querySelector<HTMLElement>("[data-preview-line-start]");
      if (!target) return;
      scrolledKeyRef.current = key;
      target.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [content, tab.line, tab.endLine, active, reloadNonce]);

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(tab.path);
    } catch {
      return;
    }
    setCopied(true);
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }, [tab.path]);

  const showOpenExternalError = useCallback((message: string) => {
    setOpenExternalError(message);
    if (openErrorTimerRef.current !== null) window.clearTimeout(openErrorTimerRef.current);
    openErrorTimerRef.current = window.setTimeout(() => setOpenExternalError(null), 6000);
  }, []);

  const lineProps = useCallback(
    (lineNumber: number) => {
      const highlighted = isInRange(lineNumber, tab.line, tab.endLine);
      const props: Record<string, unknown> = {
        className: cn(styles.line, highlighted && styles.lineHighlight),
      };
      if (highlighted && lineNumber === tab.line) props["data-preview-line-start"] = "";
      return props as React.HTMLProps<HTMLElement>;
    },
    [tab.line, tab.endLine],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
        <button
          type="button"
          onClick={() => void handleCopyPath()}
          title={getPreviewLabel("preview.file.copyPath")}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left font-mono text-[12px] text-foreground/75 transition-colors hover:bg-muted hover:text-foreground"
        >
          <span className="truncate" dir="rtl">
            <bdi>{tab.path}</bdi>
          </span>
          {copied ? (
            <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-foreground/60">
              <Check size={12} />
              {getPreviewLabel("preview.file.copied")}
            </span>
          ) : null}
        </button>
        {content !== null ? (
          <span className="shrink-0 px-1 text-[11px] tabular-nums text-foreground/45">
            {formatPreviewLabel("preview.file.lines", { count: lines.length })}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={getPreviewLabel("preview.file.reload")}
          title={getPreviewLabel("preview.file.reload")}
          onClick={() => setReloadNonce((n) => n + 1)}
        >
          <RefreshCw size={14} />
        </Button>
        <DesktopFileOpenButton
          path={tab.path}
          line={tab.line}
          conversationId={tab.conversationId}
          onError={showOpenExternalError}
        />
      </div>

      {openExternalError ? (
        <div
          role="alert"
          className="shrink-0 border-b border-border/60 bg-destructive/10 px-3 py-1 text-[11px] text-destructive break-all"
        >
          {openExternalError}
        </div>
      ) : null}

      {state.status === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-sm text-foreground/50">
          {getPreviewLabel("preview.file.loading")}
        </div>
      ) : state.status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-sm font-medium text-foreground/80">
            {getPreviewLabel("preview.file.error")}
          </div>
          <div className="max-w-full break-all font-mono text-[12px] text-foreground/55">
            {state.message}
          </div>
          <Button variant="outline" size="sm" onClick={() => setReloadNonce((n) => n + 1)}>
            {getPreviewLabel("preview.file.retry")}
          </Button>
        </div>
      ) : (
        <>
          {!useHighlight ? (
            <div className="shrink-0 border-b border-border/60 px-3 py-1 text-[11px] text-foreground/50">
              {getPreviewLabel("preview.file.largeFile")}
            </div>
          ) : null}
          <div ref={scrollRef} className={styles.codeScroll}>
            {useHighlight ? (
              <SyntaxHighlighter
                style={syntaxTheme}
                language={language}
                PreTag="div"
                showLineNumbers
                startingLineNumber={1}
                wrapLines
                wrapLongLines={false}
                lineProps={lineProps}
                customStyle={CODE_CUSTOM_STYLE}
                lineNumberStyle={LINE_NUMBER_STYLE}
                codeTagProps={{ style: { fontFamily: "inherit" } }}
              >
                {content ?? ""}
              </SyntaxHighlighter>
            ) : (
              <pre>
                {lines.map((line, index) => {
                  const n = index + 1;
                  const highlighted = isInRange(n, tab.line, tab.endLine);
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: line order is stable
                    <Fragment key={index}>
                      <span
                        className={cn(styles.line, highlighted && styles.lineHighlight)}
                        {...(highlighted && n === tab.line
                          ? { "data-preview-line-start": "" }
                          : {})}
                      >
                        <span className={styles.lineNumber}>{n}</span>
                        {line}
                      </span>
                    </Fragment>
                  );
                })}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}
