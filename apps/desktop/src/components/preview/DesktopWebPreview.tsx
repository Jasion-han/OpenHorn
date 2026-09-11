import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, cn } from "ui";
import { subscribeDialogPresence } from "../../lib/dialogPresence";
import { getPreviewLabel } from "../../lib/i18n/agent";
import { normalizeAddressInput, previewWebviewLabel } from "../../lib/previewWebview";
import {
  isDesktopRuntime,
  type PreviewWebviewRect,
  previewWebviewClose,
  previewWebviewHistory,
  previewWebviewHistoryState,
  previewWebviewNavigate,
  previewWebviewOpen,
  previewWebviewReload,
  previewWebviewSetBounds,
  previewWebviewSetVisible,
  previewWebviewSnapshot,
} from "../../lib/tauriBridge";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { type PreviewTab, usePreviewPanelStore } from "../../stores/previewPanelStore";

type WebTab = Extract<PreviewTab, { kind: "web" }>;

const HISTORY_REFRESH_DELAY_MS = 300;
// Pre-snapshots are taken on input that may open a dialog; this is the
// minimum spacing between two of them (each one rasterises + PNG-encodes the
// page on the native main thread).
const PRE_SNAPSHOT_THROTTLE_MS = 250;
// A pre-snapshot older than this is not trusted to match what is on screen.
const PRE_SNAPSHOT_MAX_AGE_MS = 3000;

interface CapturedFrame {
  dataUrl: string;
  at: number;
}

function rectOf(element: HTMLElement): PreviewWebviewRect {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** Keys that plausibly activate something which opens a dialog. */
function mayOpenDialog(event: KeyboardEvent): boolean {
  if (event.key === "Enter" || event.key === " ") return true;
  return (event.metaKey || event.ctrlKey) && event.key.length === 1;
}

/**
 * Embedded browser tab. The page itself lives in a Tauri child webview that
 * this component positions over its placeholder `<div>`; the toolbar here
 * drives it through the bridge.
 */
export function DesktopWebPreview({ tab, active }: { tab: WebTab; active: boolean }) {
  const desktop = isDesktopRuntime();
  const label = previewWebviewLabel(tab.id);
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const openedRef = useRef(false);
  const boundsFrameRef = useRef<number | null>(null);
  const [address, setAddress] = useState(tab.url);
  const panelCollapsed = usePreviewPanelStore((state) => state.collapsed);
  // A dialog anywhere in the app hides the native view (it would otherwise sit
  // on top of the dialog's overlay); `frozenFrame` is the snapshot painted in
  // its place meanwhile so the swap is invisible.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const latestFrameRef = useRef<CapturedFrame | null>(null);
  const pendingSnapshotRef = useRef<Promise<string | null> | null>(null);
  const lastSnapshotAtRef = useRef(0);
  const visibilityTokenRef = useRef(0);
  const visible = active && !panelCollapsed && !dialogOpen;
  // Mirror of the visibility inputs for the async open callback below.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const updateTab = usePreviewPanelStore((state) => state.updateTab);
  const closeTab = usePreviewPanelStore((state) => state.closeTab);
  const panelWidth = usePreviewPanelStore((state) => state.width);
  const sidebarCollapsed = useDesktopShellStore((state) => state.sidebarCollapsed);

  // Keep the address bar in sync with in-page navigation unless the user is
  // editing it.
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    setAddress(tab.url);
  }, [tab.url]);

  const pushBounds = useCallback(() => {
    if (!desktop) return;
    if (boundsFrameRef.current !== null) return;
    boundsFrameRef.current = window.requestAnimationFrame(() => {
      boundsFrameRef.current = null;
      const el = placeholderRef.current;
      if (!el || !openedRef.current) return;
      const rect = rectOf(el);
      if (rect.width <= 0 || rect.height <= 0) return;
      void previewWebviewSetBounds(label, rect).catch(() => {});
    });
  }, [desktop, label]);

  // Create the child webview on mount, destroy it on unmount (tab closed or
  // panel closed). The initial URL is captured once; later URL changes come
  // from the page itself or from explicit navigate calls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab.url is read once at creation; pushBounds is stable per label
  useEffect(() => {
    if (!desktop) return;
    const el = placeholderRef.current;
    if (!el) return;
    let disposed = false;
    const rect = rectOf(el);
    void previewWebviewOpen({
      label,
      url: tab.url,
      rect: { ...rect, width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) },
    })
      .then(() => {
        if (disposed) return;
        openedRef.current = true;
        // The visibility effect may have run before the webview existed (its
        // call failed silently); re-apply so a tab deactivated mid-creation
        // does not surface on top of the one that replaced it.
        void previewWebviewSetVisible(label, visibleRef.current).catch(() => {});
        pushBounds();
      })
      .catch(() => {});
    return () => {
      disposed = true;
      openedRef.current = false;
      if (boundsFrameRef.current !== null) {
        window.cancelAnimationFrame(boundsFrameRef.current);
        boundsFrameRef.current = null;
      }
      void previewWebviewClose(label).catch(() => {});
    };
  }, [desktop, label]);

  // Follow the placeholder: its own size, the window, the panel width and the
  // sidebar (which shifts x without resizing the placeholder).
  useEffect(() => {
    if (!desktop) return;
    const el = placeholderRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => pushBounds());
    observer.observe(el);
    window.addEventListener("resize", pushBounds);
    pushBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", pushBounds);
    };
  }, [desktop, pushBounds]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: panelWidth/sidebarCollapsed/active are triggers, not read in body
  useEffect(() => {
    pushBounds();
  }, [pushBounds, panelWidth, sidebarCollapsed, active]);

  useEffect(() => {
    if (!desktop) return;
    return subscribeDialogPresence(setDialogOpen);
  }, [desktop]);

  // Pre-snapshot: a dialog is almost always opened by a pointer press or a
  // key, so capture the page on those (capture phase, throttled) while the
  // native view is showing. When the dialog then appears, the frame is
  // already at hand and the view can be hidden without waiting on IPC.
  useEffect(() => {
    if (!desktop || !visible) return;
    const capture = () => {
      if (!visibleRef.current || !openedRef.current) return;
      const now = performance.now();
      if (now - lastSnapshotAtRef.current < PRE_SNAPSHOT_THROTTLE_MS) return;
      lastSnapshotAtRef.current = now;
      const pending = previewWebviewSnapshot(label).then((dataUrl) => {
        if (pendingSnapshotRef.current === pending) pendingSnapshotRef.current = null;
        if (dataUrl) latestFrameRef.current = { dataUrl, at: performance.now() };
        return dataUrl;
      });
      pendingSnapshotRef.current = pending;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (mayOpenDialog(event)) capture();
    };
    document.addEventListener("pointerdown", capture, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", capture, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [desktop, visible, label]);

  // Visibility: only the active tab of an expanded panel shows, and never
  // while a dialog is open. Hiding for a dialog first paints the latest frame
  // into the placeholder so nothing pops; showing again re-sends bounds
  // (layout may have changed while hidden — a collapsed panel is display:none,
  // so the ResizeObserver saw a zero-size placeholder meanwhile) and drops
  // the frozen frame a frame later, once the native view is back on top.
  // Each run invalidates the previous one's pending async steps.
  useEffect(() => {
    if (!desktop) return;
    const token = ++visibilityTokenRef.current;
    const stale = () => visibilityTokenRef.current !== token;

    if (visible) {
      void previewWebviewSetVisible(label, true)
        .then(() => {
          if (stale()) return;
          pushBounds();
          window.requestAnimationFrame(() => {
            if (!stale()) setFrozenFrame(null);
          });
        })
        .catch(() => {});
      return;
    }

    const hide = () => void previewWebviewSetVisible(label, false).catch(() => {});
    // Hidden for a reason other than a dialog (inactive tab, collapsed panel):
    // the placeholder is display:none anyway, nothing to freeze.
    if (!dialogOpen || !active || panelCollapsed) {
      hide();
      return;
    }

    // Commit the frame, then hide on the next animation frame so the <img>
    // has been laid out before the native view goes away.
    const freezeThenHide = (dataUrl: string | null) => {
      if (stale()) return;
      setFrozenFrame(dataUrl);
      window.requestAnimationFrame(() => {
        if (!stale()) hide();
      });
    };
    const latest = latestFrameRef.current;
    if (latest && performance.now() - latest.at < PRE_SNAPSHOT_MAX_AGE_MS) {
      freezeThenHide(latest.dataUrl);
      return;
    }
    // No usable pre-snapshot: take one now (slower — the view stays on top of
    // the overlay until it lands) or reuse the one still in flight.
    const pending = pendingSnapshotRef.current ?? previewWebviewSnapshot(label);
    void pending.then(freezeThenHide);
  }, [desktop, label, visible, dialogOpen, active, panelCollapsed, pushBounds]);

  const navigate = useCallback(
    (url: string) => {
      updateTab(tab.id, { url, loading: true });
      setAddress(url);
      void previewWebviewNavigate(label, url).catch(() => {});
    },
    [label, tab.id, updateTab],
  );

  const handleAddressSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const url = normalizeAddressInput(address);
      if (!url) return;
      navigate(url);
      inputRef.current?.blur();
    },
    [address, navigate],
  );

  // Native back/forward. Availability is re-read shortly after the step (the
  // page-load listener in the panel refreshes it again once the load events
  // arrive; this covers same-document history entries that emit none).
  const historyRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (historyRefreshRef.current !== null) clearTimeout(historyRefreshRef.current);
    };
  }, []);
  const stepHistory = useCallback(
    (delta: -1 | 1) => {
      void previewWebviewHistory(label, delta).catch(() => {});
      if (historyRefreshRef.current !== null) clearTimeout(historyRefreshRef.current);
      historyRefreshRef.current = setTimeout(() => {
        historyRefreshRef.current = null;
        void previewWebviewHistoryState(label)
          .then((history) => updateTab(tab.id, history))
          .catch(() => {});
      }, HISTORY_REFRESH_DELAY_MS);
    },
    [label, tab.id, updateTab],
  );

  const handleOpenExternal = useCallback(() => {
    import("@tauri-apps/plugin-shell")
      .then((mod) => mod.open(tab.url))
      .catch(() => window.open(tab.url, "_blank"));
  }, [tab.url]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        onSubmit={handleAddressSubmit}
        className="flex shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5 py-1"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={getPreviewLabel("preview.web.back")}
          title={getPreviewLabel("preview.web.back")}
          disabled={!desktop || !tab.canGoBack}
          onClick={() => stepHistory(-1)}
        >
          <ArrowLeft size={14} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={getPreviewLabel("preview.web.forward")}
          title={getPreviewLabel("preview.web.forward")}
          disabled={!desktop || !tab.canGoForward}
          onClick={() => stepHistory(1)}
        >
          <ArrowRight size={14} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={getPreviewLabel("preview.web.reload")}
          title={getPreviewLabel("preview.web.reload")}
          disabled={!desktop}
          onClick={() => {
            updateTab(tab.id, { loading: true });
            void previewWebviewReload(label).catch(() => {});
          }}
        >
          <RotateCw size={14} className={cn(tab.loading && "animate-spin")} />
        </Button>
        <input
          ref={inputRef}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setAddress(tab.url);
              e.currentTarget.blur();
            }
          }}
          placeholder={getPreviewLabel("preview.web.address")}
          aria-label={getPreviewLabel("preview.web.address")}
          spellCheck={false}
          autoComplete="off"
          className="mx-1 h-7 min-w-0 flex-1 rounded-md border border-border/60 bg-muted/50 px-2.5 font-mono text-[12px] text-foreground/85 outline-none transition-colors focus:border-border focus:bg-background"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={getPreviewLabel("preview.web.openExternal")}
          title={getPreviewLabel("preview.web.openExternal")}
          onClick={handleOpenExternal}
        >
          <ExternalLink size={14} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={getPreviewLabel("preview.tab.close")}
          title={getPreviewLabel("preview.tab.close")}
          onClick={() => closeTab(tab.id)}
        >
          <X size={14} />
        </Button>
      </form>

      {/* The native child webview is laid over this element. While it is hidden
          for a dialog, the last captured frame stands in; the snapshot has the
          placeholder's aspect ratio, so `fill` maps it 1:1. */}
      <div
        ref={placeholderRef}
        className={cn("relative min-h-0 flex-1", dialogOpen ? "bg-muted/30" : "bg-background")}
      >
        {frozenFrame && (
          <img
            src={frozenFrame}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full select-none"
            style={{ objectFit: "fill" }}
          />
        )}
        {!desktop && (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-foreground/50">
            {getPreviewLabel("preview.web.desktopOnly")}
          </div>
        )}
      </div>
    </div>
  );
}
