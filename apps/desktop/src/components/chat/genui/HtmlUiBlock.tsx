import { useEffect, useMemo, useRef, useState } from "react";
import { extractCompleteStyles, processPartialHtml } from "../../../lib/genui/partialHtml";
import {
  acceptsUserAction,
  buildPreviewDocument,
  buildSandboxDocument,
  MESSAGE_TYPE,
  parseBridgeMessage,
  readThemeSnapshot,
  type ThemeSnapshot,
} from "../../../lib/genui/sandbox";
import { getGenUiLabel } from "../../../lib/i18n/agent";
import { THEME_MODE_CHANGE_EVENT } from "../../../lib/theme";
import { useGenUiStore } from "../../../stores/genUiStore";
import { usePreviewPanelStore } from "../../../stores/previewPanelStore";
import styles from "./genui.module.css";

const STREAMING_HEIGHT = 240;
const INITIAL_HEIGHT = 320;
/** How often the static preview may reload while the block streams. */
const PREVIEW_INTERVAL_MS = 400;
/** A frame may offer at most one follow-up (and open one link) per this interval. */
const PROMPT_INTERVAL_MS = 1000;

function useThemeSnapshot(): ThemeSnapshot {
  const [theme, setTheme] = useState<ThemeSnapshot>(() => readThemeSnapshot());
  useEffect(() => {
    const update = () => setTheme(readThemeSnapshot());
    window.addEventListener(THEME_MODE_CHANGE_EVENT, update);
    return () => window.removeEventListener(THEME_MODE_CHANGE_EVENT, update);
  }, []);
  return theme;
}

/** `value`, updated at most once per `interval` ms (trailing). */
function useThrottled<T>(value: T, interval: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + interval - Date.now());
    const timer = window.setTimeout(() => {
      last.current = Date.now();
      setShown(value);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [value, interval]);
  return shown;
}

/**
 * A ```html-ui block. While it streams, a script-free preview of the markup so
 * far; once complete, the fragment runs once in a sandboxed frame (see
 * lib/genui/sandbox.ts for the isolation and the bridge).
 */
export function HtmlUiBlock({ code, streaming }: { code: string; streaming: boolean }) {
  const theme = useThemeSnapshot();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const lastPrompt = useRef(0);
  const lastLink = useRef(0);
  // Load events of the running frame, per document. The srcdoc load is the
  // first; any later one means the frame navigated itself away, and the new
  // page is not covered by our CSP. A new runDoc (theme switch) reloads
  // legitimately, so the count restarts for it.
  const loads = useRef<{ doc: string; count: number }>({ doc: "", count: 0 });
  const [navigated, setNavigated] = useState(false);

  const previewSource = useThrottled(streaming ? code : "", PREVIEW_INTERVAL_MS);
  const previewDoc = useMemo(
    () =>
      buildPreviewDocument(
        extractCompleteStyles(previewSource),
        processPartialHtml(previewSource),
        theme,
      ),
    [previewSource, theme],
  );
  const runDoc = useMemo(
    () => (streaming ? "" : buildSandboxDocument(code, theme)),
    [streaming, code, theme],
  );

  useEffect(() => {
    if (streaming) return;
    const onMessage = (event: MessageEvent) => {
      // Only this block's own frame; every other window is ignored.
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = parseBridgeMessage(event.data);
      if (!message) return;
      // Follow-ups and links only while the user is in this frame; a script
      // must not fill the composer or open links on its own.
      if (!acceptsUserAction(message, document.activeElement === frame.current)) return;
      switch (message.action) {
        case "height":
          setHeight(message.height);
          return;
        case "sendPrompt": {
          const now = Date.now();
          if (now - lastPrompt.current < PROMPT_INTERVAL_MS) return;
          lastPrompt.current = now;
          useGenUiStore.getState().requestComposerText(message.text);
          return;
        }
        case "openLink": {
          // Each link is a preview-panel webview; without a limit a looping
          // frame could open tabs without end.
          const now = Date.now();
          if (now - lastLink.current < PROMPT_INTERVAL_MS) return;
          lastLink.current = now;
          usePreviewPanelStore.getState().openUrl(message.url);
          return;
        }
      }
    };
    window.addEventListener("message", onMessage);
    // The frame may have reported before this listener existed.
    frame.current?.contentWindow?.postMessage({ type: MESSAGE_TYPE, action: "measure" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, [streaming]);

  if (streaming) {
    return (
      <div className={styles.block}>
        <div className={styles.frameWrap} style={{ height: STREAMING_HEIGHT }}>
          <iframe
            className={styles.frame}
            title={getGenUiLabel("genui.frameTitle")}
            sandbox=""
            srcDoc={previewDoc}
            referrerPolicy="no-referrer"
          />
          <div className={styles.frameWait}>{getGenUiLabel("genui.preparing")}</div>
        </div>
      </div>
    );
  }

  if (navigated) {
    return (
      <div className={styles.block}>
        <div className={styles.error}>{getGenUiLabel("genui.frameNavigated")}</div>
      </div>
    );
  }

  const onFrameLoad = () => {
    if (loads.current.doc !== runDoc) loads.current = { doc: runDoc, count: 0 };
    loads.current.count += 1;
    if (loads.current.count > 1) setNavigated(true);
  };

  return (
    <div className={styles.block}>
      <div className={styles.frameWrap} style={{ height }}>
        <iframe
          ref={frame}
          className={styles.frame}
          title={getGenUiLabel("genui.frameTitle")}
          sandbox="allow-scripts"
          srcDoc={runDoc}
          referrerPolicy="no-referrer"
          onLoad={onFrameLoad}
        />
      </div>
    </div>
  );
}
