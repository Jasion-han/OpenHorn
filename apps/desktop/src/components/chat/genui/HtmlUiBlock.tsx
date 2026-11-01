import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { extractCompleteStyles, processPartialHtml } from "../../../lib/genui/partialHtml";
import {
  type BridgeMessage,
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

  const bootstrap = buildSandboxDocument(theme);
  return <RunningHtmlUiBlock key={`${bootstrap}\0${code}`} code={code} document={bootstrap} />;
}

type ProposedAction = Exclude<BridgeMessage, { action: "height" | "navigated" }>;

/** Every model message is a proposal. Only the visible parent control acts. */
function RunningHtmlUiBlock({ code, document }: { code: string; document: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const runningWindow = useRef<Window | null>(null);
  const loaded = useRef(false);
  const invalid = useRef(false);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const [navigated, setNavigated] = useState(false);
  const [proposals, setProposals] = useState<ProposedAction[]>([]);
  const pending = useRef<ProposedAction[]>([]);
  const lastProposal = useRef({ sendPrompt: 0, openLink: 0 });
  const invalidateFrame = useCallback(() => {
    invalid.current = true;
    pending.current = [];
    setProposals([]);
    setNavigated(true);
  }, []);

  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (invalid.current || !loaded.current || event.source !== runningWindow.current) return;
      const message = parseBridgeMessage(event.data);
      if (!message) return;
      if (message.action === "navigated") {
        invalidateFrame();
        return;
      }
      if (message.action === "height") {
        setHeight(message.height);
        return;
      }
      // At most one pending proposal of each kind, with bounded visible text.
      // Frame focus, forged activation claims and nonces grant no authority.
      const now = Date.now();
      if (now - lastProposal.current[message.action] < PROMPT_INTERVAL_MS) return;
      if (pending.current.some((proposal) => proposal.action === message.action)) return;
      lastProposal.current[message.action] = now;
      pending.current = [...pending.current, message];
      setProposals(pending.current);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [invalidateFrame]);

  const removeProposal = (proposal: ProposedAction) => {
    pending.current = pending.current.filter((entry) => entry !== proposal);
    setProposals(pending.current);
  };

  const confirmProposal = (proposal: ProposedAction, trusted: boolean) => {
    if (!trusted || invalid.current || !pending.current.includes(proposal)) return;
    removeProposal(proposal);
    if (proposal.action === "sendPrompt") {
      useGenUiStore.getState().requestComposerText(proposal.text);
    } else {
      usePreviewPanelStore.getState().openUrl(proposal.url);
    }
  };

  if (navigated) {
    return (
      <div className={styles.block}>
        <div className={styles.error}>{getGenUiLabel("genui.frameNavigated")}</div>
      </div>
    );
  }

  const onFrameLoad = () => {
    if (loaded.current) {
      invalidateFrame();
      return;
    }
    // This load belongs to a trusted, empty document. Only now may model
    // scripts execute; every subsequent load is an invalid navigation.
    loaded.current = true;
    runningWindow.current = frame.current?.contentWindow ?? null;
    runningWindow.current?.postMessage({ type: MESSAGE_TYPE, action: "render", html: code }, "*");
  };

  return (
    <div className={styles.block}>
      <div className={styles.frameWrap} style={{ height }}>
        <iframe
          ref={frame}
          className={styles.frame}
          title={getGenUiLabel("genui.frameTitle")}
          sandbox="allow-scripts"
          srcDoc={document}
          referrerPolicy="no-referrer"
          onLoad={onFrameLoad}
        />
      </div>
      {proposals.map((proposal) => (
        <div key={proposal.action} className={styles.proposal}>
          <div className={styles.proposalLabel}>
            {getGenUiLabel(
              proposal.action === "sendPrompt" ? "genui.proposedPrompt" : "genui.proposedLink",
            )}
          </div>
          <p className={styles.proposalText}>
            {proposal.action === "sendPrompt" ? proposal.text : proposal.url}
          </p>
          <div className={styles.proposalButtons}>
            <button
              type="button"
              className={styles.proposalConfirm}
              onClick={(event) => confirmProposal(proposal, event.nativeEvent.isTrusted)}
            >
              {getGenUiLabel(
                proposal.action === "sendPrompt" ? "genui.fillComposer" : "genui.openLink",
              )}
            </button>
            <button type="button" onClick={() => removeProposal(proposal)}>
              {getGenUiLabel("genui.dismissProposal")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
