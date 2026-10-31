import { type ActionEvent, createParser, Renderer } from "@openuidev/react-lang";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { loadBlockState, saveBlockState } from "../../../lib/genui/blockState";
import { safeWebUrl } from "../../../lib/genui/sandbox";
import { computedStateNames, repairComputedState } from "../../../lib/genui/stateCheck";
import { getGenUiLabel } from "../../../lib/i18n/agent";
import { useGenUiStore } from "../../../stores/genUiStore";
import { usePreviewPanelStore } from "../../../stores/previewPanelStore";
import { CopyToClipboard } from "./components";
import styles from "./genui.module.css";
import { genUiLibrary } from "./library";

const SAVE_DELAY_MS = 300;

let parser: ReturnType<typeof createParser> | null = null;

/**
 * The program the Renderer gets: once the block is complete, `$x = <expression>`
 * declarations are rewritten to plain derived values so they compute (see
 * `repairComputedState`). The stored message text is never changed.
 */
export function renderableProgram(code: string, streaming: boolean): string {
  if (streaming) return code;
  parser ??= createParser(genUiLibrary.toJSONSchema(), genUiLibrary.root);
  const active = parser;
  try {
    return repairComputedState(code, (source) => active.parse(source));
  } catch {
    return code;
  }
}

/** Runs the actions an answer can trigger. Exported for tests. */
export function runGenUiAction(event: ActionEvent): void {
  switch (event.type) {
    case "continue_conversation": {
      // Placed in the composer for the user to review; never sent from here.
      useGenUiStore.getState().requestComposerText(event.humanFriendlyMessage ?? "");
      return;
    }
    case "open_url": {
      const url = safeWebUrl((event.params as { url?: unknown }).url);
      if (url) usePreviewPanelStore.getState().openUrl(url);
      return;
    }
    case CopyToClipboard.name: {
      const text = (event.params as { text?: unknown }).text;
      if (typeof text === "string") void navigator.clipboard?.writeText(text).catch(() => {});
      return;
    }
    default:
      return;
  }
}

/** A render-time throw in a model-written program must not take the message down. */
class RenderBoundary extends Component<
  { fallback: ReactNode; resetKey: string; children: ReactNode },
  { failed: boolean; resetKey: string }
> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { failed: boolean; resetKey: string },
  ) {
    // New program text (the stream moved on): try rendering again.
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * A ```openui-lang block. While streaming it renders what has parsed so far
 * (inputs stay disabled); once complete the inputs work against the program's
 * own $variables. A program that produces nothing falls back to `fallback`
 * (the plain code block) with a one-line notice.
 */
export function GenUiBlock({
  code,
  streaming,
  stateKey,
  fallback,
}: {
  code: string;
  streaming: boolean;
  /** Where the block's interaction state is persisted; null keeps it in memory. */
  stateKey: string | null;
  fallback: ReactNode;
}) {
  const [initialState] = useState(() => (stateKey ? loadBlockState(stateKey) : undefined));
  const [rendered, setRendered] = useState<boolean | null>(null);
  const [hasErrors, setHasErrors] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const pending = useRef<Record<string, unknown> | null>(null);
  const program = useMemo(() => renderableProgram(code, streaming), [code, streaming]);

  const flush = useCallback(() => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (stateKey && pending.current) saveBlockState(stateKey, pending.current);
    pending.current = null;
  }, [stateKey]);

  useEffect(() => flush, [flush]);

  const onStateUpdate = useCallback(
    (state: Record<string, unknown>) => {
      if (!stateKey || streaming) return;
      pending.current = state;
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flush, SAVE_DELAY_MS);
    },
    [stateKey, streaming, flush],
  );

  const fallbackView = (
    <div className={styles.block}>
      <div className={styles.error}>{getGenUiLabel("genui.renderFailed")}</div>
      {fallback}
    </div>
  );

  if (!streaming && rendered === false) return fallbackView;

  return (
    <RenderBoundary fallback={fallbackView} resetKey={program}>
      <div className={styles.block}>
        {!streaming && hasErrors ? (
          <div className={styles.error}>{getGenUiLabel("genui.partialErrors")}</div>
        ) : null}
        <Renderer
          response={program}
          library={genUiLibrary}
          isStreaming={streaming}
          initialState={initialState}
          onStateUpdate={onStateUpdate}
          onAction={runGenUiAction}
          onParseResult={(result) => {
            setRendered(result ? result.root !== null : false);
            setHasErrors(
              (result?.meta.errors.length ?? 0) > 0 ||
                computedStateNames(result?.stateDeclarations).length > 0,
            );
          }}
        />
      </div>
    </RenderBoundary>
  );
}
