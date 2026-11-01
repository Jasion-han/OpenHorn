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
import { loadBlockState, rememberBlockState, saveBlockState } from "../../../lib/genui/blockState";
import { MAX_PROMPT_LENGTH, safeWebUrl } from "../../../lib/genui/sandbox";
import { repairComputedState, wrapSequenceRoot } from "../../../lib/genui/stateCheck";
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
  try {
    return wrapSequenceRoot(repairComputedState(code));
  } catch {
    return code;
  }
}

/** Explicit context is visible in the reviewable draft; unrelated form state stays local. */
export function followUpDraft(message: string, context: unknown): string {
  const text = message.trim();
  if (context === undefined || context === null) return text.slice(0, MAX_PROMPT_LENGTH);
  let serialized: string;
  try {
    serialized = typeof context === "string" ? context : JSON.stringify(context, null, 2);
  } catch {
    return text.slice(0, MAX_PROMPT_LENGTH);
  }
  if (!serialized?.trim()) return text.slice(0, MAX_PROMPT_LENGTH);
  const heading = `\n\n${getGenUiLabel("genui.followupContext")}:\n`;
  if (text.length + heading.length + serialized.length <= MAX_PROMPT_LENGTH) {
    return `${text}${heading}${serialized}`;
  }
  const messageLimit = Math.min(text.length, Math.floor(MAX_PROMPT_LENGTH / 2));
  const contextLimit = MAX_PROMPT_LENGTH - messageLimit - heading.length;
  const bounded = (value: string, limit: number) =>
    value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  return `${bounded(text, messageLimit)}${heading}${bounded(serialized, contextLimit)}`;
}

/** Runs the actions an answer can trigger. Exported for tests. */
export function runGenUiAction(event: ActionEvent): void {
  switch (event.type) {
    case "continue_conversation": {
      // Placed in the composer for the user to review; never sent from here.
      useGenUiStore
        .getState()
        .requestComposerText(
          followUpDraft(event.humanFriendlyMessage ?? "", event.params?.context),
        );
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
interface GenUiBlockProps {
  code: string;
  streaming: boolean;
  /** Includes the program revision; null keeps this session in memory. */
  stateKey: string | null;
  fallback: ReactNode;
}

export function GenUiBlock(props: GenUiBlockProps) {
  // A replacement program owns a new store. Stream chunks share a stable key;
  // completion switches once to the final revision and restores its snapshot.
  return (
    <GenUiSession key={props.stateKey ?? (props.streaming ? "stream" : props.code)} {...props} />
  );
}

function GenUiSession({ code, streaming, stateKey, fallback }: GenUiBlockProps) {
  const [initialState] = useState(() => (stateKey ? loadBlockState(stateKey) : undefined));
  const [diagnostic, setDiagnostic] = useState<{ program: string; failed: boolean } | null>(null);
  const saveTimer = useRef<number | null>(null);
  const pending = useRef<Record<string, unknown> | null>(null);
  const program = useMemo(() => renderableProgram(code, streaming), [code, streaming]);
  // Parse status belongs to THIS program, not an effect from the previous stream chunk.
  const parsed = useMemo(() => {
    if (streaming) return null;
    try {
      parser ??= createParser(genUiLibrary.toJSONSchema(), genUiLibrary.root);
      return parser.parse(program);
    } catch {
      return null;
    }
  }, [program, streaming]);
  const hasRoot = !!(parsed?.root || parsed?.rootExpression);
  const hasErrors =
    (parsed?.meta.errors.length ?? 0) > 0 || (diagnostic?.program === program && diagnostic.failed);
  const onError = useCallback(
    (errors: unknown[]) => {
      const failed = errors.length > 0;
      setDiagnostic((previous) =>
        previous?.program === program && previous.failed === failed
          ? previous
          : { program, failed },
      );
    },
    [program],
  );

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
      rememberBlockState(stateKey, state);
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

  if (!streaming && !hasRoot) return fallbackView;

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
          onError={onError}
        />
        {!streaming && hasErrors ? fallback : null}
      </div>
    </RenderBoundary>
  );
}
