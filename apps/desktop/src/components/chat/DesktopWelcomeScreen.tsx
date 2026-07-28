import {
  ChevronDown,
  CornerDownLeft,
  Globe,
  MessageSquare,
  Paperclip,
  ShieldOff,
  Sparkles,
  X,
} from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { fileKey } from "shared/format";
import { Button, cn, Textarea } from "ui";
import { getDesktopBackendBase } from "../../lib/backendBase";
import { charCount, pickPlaceholder, takeChars } from "../../lib/composerPlaceholder";
import { DEFAULT_CONVERSATION_TITLE } from "../../lib/conversationTitle";
import { getGlobalDefaultChannel } from "../../lib/defaultChannel";
import { getChatLabel } from "../../lib/i18n/agent";
import { notifyError } from "../../lib/notify";
import { useAuthStore } from "../../stores/authStore";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { DesktopAttachmentPreviewItem } from "./DesktopAttachmentPreviewItem";
import { ACCEPT_FILES } from "./DesktopComposer";
import { DesktopComposerModeChip } from "./DesktopComposerModeChip";
import { DesktopModelPickerModal } from "./DesktopModelPickerModal";
import { DesktopProviderLogo } from "./DesktopProviderLogo";

/**
 * Shown immediately on every visit. Personalised suggestions replace them only
 * once the server already has a cached set — generating costs a model
 * round-trip, which must never sit in front of the first paint.
 */
const DEFAULT_SUGGESTION_KEYS = [
  "chat.welcome.suggestion1",
  "chat.welcome.suggestion2",
  "chat.welcome.suggestion3",
  "chat.welcome.suggestion4",
  "chat.welcome.suggestion5",
] as const;

const DEFAULT_SUGGESTIONS = DEFAULT_SUGGESTION_KEYS.map((key) => getChatLabel(key));

/**
 * The placeholder is a rotating pool, not a fixed line — same behaviour as the
 * in-conversation composer, which re-draws one every time an empty box is
 * focused. It is the one bit of the screen that reacts before you have typed
 * anything, so it reads as alive rather than as a static form field.
 */
const PLACEHOLDER_KEYS = [
  "chat.welcome.placeholder1",
  "chat.welcome.placeholder2",
  "chat.welcome.placeholder3",
  "chat.welcome.placeholder4",
  "chat.welcome.placeholder5",
  "chat.welcome.placeholder6",
  "chat.welcome.placeholder7",
  "chat.welcome.placeholder8",
  "chat.welcome.placeholder9",
  "chat.welcome.placeholder10",
  "chat.welcome.placeholder11",
  "chat.welcome.placeholder12",
] as const;

export const WELCOME_PLACEHOLDERS = PLACEHOLDER_KEYS.map((key) => getChatLabel(key));

/**
 * The placeholder types itself in, rests, rewinds character by character, and
 * types the *same* line again. Only a click on the box draws a different one —
 * a line that swapped itself out on a timer would read as a slideshow demanding
 * attention rather than as an idle input.
 *
 * Erasing runs faster than typing: a rewind that takes as long as the write
 * feels like a mistake being corrected instead of a loop resetting.
 */
const PLACEHOLDER_TYPE_MS = 42;
const PLACEHOLDER_ERASE_MS = 26;
/** Long enough to actually read the line before it starts rewinding. */
const PLACEHOLDER_HOLD_MS = 2400;
/** Beat on the empty box, so the restart reads as deliberate. */
const PLACEHOLDER_REST_MS = 700;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

interface WelcomeSuggestionsResult {
  items: string[];
  /** The server scheduled a regeneration; a newer set will exist shortly. */
  stale: boolean;
}

async function fetchWelcomeSuggestions(): Promise<WelcomeSuggestionsResult> {
  try {
    const response = await fetch(`${getDesktopBackendBase()}/settings/welcome-suggestions`, {
      credentials: "include",
    });
    if (!response.ok) return { items: [], stale: false };
    const data = (await response.json()) as { suggestions?: unknown; stale?: unknown };
    const items = Array.isArray(data.suggestions)
      ? data.suggestions.filter((item): item is string => typeof item === "string")
      : [];
    return { items, stale: data.stale === true };
  } catch {
    // Offline or backend down — the defaults stay.
    return { items: [], stale: false };
  }
}

/**
 * When the first read reports a scheduled regeneration, check back a couple of
 * times so a set that finishes generating while the user is still looking at
 * this screen actually appears — instead of waiting for the next visit.
 */
const STALE_RECHECK_DELAYS_MS = [8000, 20000];

/**
 * Landing view for "no conversation selected". Instead of a dead-end hint it
 * offers the same entry point the composer does: type, and the conversation is
 * created around the prompt. The draft is handed to `DesktopChatArea` through
 * `pendingPrompt` — the chat area owns every send path (slash commands,
 * attachments, agent mode), so duplicating that here would drift.
 */
export function DesktopWelcomeScreen() {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // A pick made before the conversation exists has nowhere to be persisted, so
  // it is held here and passed to createConversation.
  const [pickedModel, setPickedModel] = useState<{ channelId: string; modelId: string } | null>(
    null,
  );
  // Matches the server's default for a fresh conversation; sent along at
  // creation so the very first message already honours it.
  const [forceWebSearch, setForceWebSearch] = useState(true);
  const [starting, setStarting] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>(DEFAULT_SUGGESTIONS);
  // Drawn once per mount, then re-drawn on every focus of the empty box below.
  // `draw` counts the redraws: it makes each draw a distinct value even when the
  // same line comes up twice, so the typewriter below always replays.
  const [placeholder, setPlaceholder] = useState(() => ({
    text: pickPlaceholder(WELCOME_PLACEHOLDERS),
    draw: 0,
  }));
  const [revealed, setRevealed] = useState(0);
  const [erasing, setErasing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const user = useAuthStore((state) => state.user);
  const channels = useChatStore((state) => state.channels);
  const createConversation = useChatStore((state) => state.createConversation);
  const composerMode = useChatStore((state) => state.composerMode);
  const setComposerMode = useChatStore((state) => state.setComposerMode);
  const setPendingPrompt = useDesktopShellStore((state) => state.setPendingPrompt);
  const fullAccessEnabled = useDesktopShellStore((state) => state.fullAccessEnabled);
  const toggleFullAccess = useDesktopShellStore((state) => state.toggleFullAccess);

  // Fire-and-forget: the defaults are already on screen, so a slow or failed
  // response costs nothing. The request also nudges the server to regenerate a
  // stale set for the next visit.
  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];

    const load = async () => {
      const { items, stale } = await fetchWelcomeSuggestions();
      if (cancelled) return;
      if (items.length > 0) setSuggestions(items);
      return stale;
    };

    void load().then((stale) => {
      if (cancelled || !stale) return;
      for (const delay of STALE_RECHECK_DELAYS_MS) {
        timers.push(window.setTimeout(() => void load(), delay));
      }
    });

    return () => {
      cancelled = true;
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);

  // The type → hold → rewind → restart loop. Each step schedules exactly one
  // timeout and then re-enters through its own state change, so there is no
  // interval to leak and no state updater doing side effects (they must stay
  // pure — React may call them twice).
  useEffect(() => {
    const total = charCount(placeholder.text);
    if (prefersReducedMotion()) {
      // A perpetual animation is exactly what this preference asks to be spared:
      // show the line, leave it alone.
      setRevealed(total);
      return;
    }
    // With text in the box the placeholder is invisible; running the loop anyway
    // would re-render on every keystroke-length tick for nothing.
    if (draft.length > 0) return;

    const step = erasing
      ? revealed > 0
        ? { delay: PLACEHOLDER_ERASE_MS, run: () => setRevealed((n) => n - 1) }
        : { delay: PLACEHOLDER_REST_MS, run: () => setErasing(false) }
      : revealed < total
        ? { delay: PLACEHOLDER_TYPE_MS, run: () => setRevealed((n) => n + 1) }
        : { delay: PLACEHOLDER_HOLD_MS, run: () => setErasing(true) };

    const timer = window.setTimeout(step.run, step.delay);
    return () => window.clearTimeout(timer);
  }, [placeholder, revealed, erasing, draft.length]);

  const defaultChannel = getGlobalDefaultChannel(channels);
  const selection = pickedModel ?? defaultChannel ?? null;
  const selectedProvider = pickedModel
    ? (channels.find((channel) => channel.id === pickedModel.channelId)?.provider ?? null)
    : (defaultChannel?.provider ?? null);

  const start = async (prompt: string) => {
    const trimmed = prompt.trim();
    if ((!trimmed && attachments.length === 0) || starting) return;
    setStarting(true);
    try {
      // Parked before the conversation exists so the chat area can pick it up on
      // its very first render for that conversation — which happens while this
      // function is still suspended on the await below.
      setPendingPrompt({ text: trimmed, files: attachments });
      // Mode and web-search seed the conversation itself rather than being
      // corrected afterwards: by the time the await resumes, the chat area has
      // already sent the message.
      await createConversation(DEFAULT_CONVERSATION_TITLE, {
        channelId: selection?.channelId ?? null,
        modelId: selection?.modelId ?? null,
        defaultMode: composerMode,
        forceWebSearch,
      });
      setDraft("");
      setAttachments([]);
    } catch (error) {
      setPendingPrompt(null);
      notifyError(
        getChatLabel("chat.welcome.startFailedTitle"),
        error instanceof Error ? error.message : getChatLabel("chat.welcome.startFailedBody"),
      );
    } finally {
      setStarting(false);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void start(draft);
    }
  };

  const addFiles = (files: FileList | File[]) => {
    const next = Array.from(files);
    if (next.length === 0) return;
    setAttachments((prev) => {
      const seen = new Set(prev.map(fileKey));
      return [...prev, ...next.filter((file) => !seen.has(fileKey(file)))];
    });
  };

  // A suggestion is a starting point, not a command: it fills the box and hands
  // the caret back so it can be edited before sending.
  const applySuggestion = (text: string) => {
    setDraft(text);
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  // Only while the box is empty: with text in it the placeholder is invisible,
  // so redrawing would just be churn. Bound to click as well as focus because
  // the box is auto-focused on arrival — focus alone would fire once and never
  // again, and the point is that every click brings a different line.
  // Swaps in a different line and restarts the loop from an empty box.
  const drawPlaceholder = () => {
    setPlaceholder((prev) => ({
      text: pickPlaceholder(WELCOME_PLACEHOLDERS, prev.text),
      draw: prev.draw + 1,
    }));
    setRevealed(0);
    setErasing(false);
  };

  const rerollPlaceholder = () => {
    if (draft.length > 0) return;
    drawPlaceholder();
  };

  const hasInput = draft.length > 0 || attachments.length > 0;

  // Clears the whole input, attachments included — it sits above the composer as
  // a "start over", not as a per-field reset.
  const clearInput = () => {
    setDraft("");
    setAttachments([]);
    drawPlaceholder();
    textareaRef.current?.focus();
  };

  const canSubmit = (Boolean(draft.trim()) || attachments.length > 0) && !starting;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pb-16">
        <div className="w-full max-w-[720px]">
          <div className="mb-7 flex flex-col items-center text-center">
            <div className="mb-6 flex size-14 items-center justify-center rounded-full bg-foreground/[0.05] ring-1 ring-border/60">
              <Sparkles className="size-6 text-muted-foreground" />
            </div>
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight">
              {user?.username
                ? `${user.username}，${getChatLabel("chat.welcome.title")}`
                : getChatLabel("chat.welcome.title")}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {getChatLabel("chat.welcome.subtitle")}
            </p>
          </div>

          {/* Visual language deliberately mirrors DesktopComposer so the box does
              not appear to move or restyle once the conversation opens. */}
          <div className="rounded-[17px] border-[0.5px] border-border bg-background/70 pt-2 shadow-minimal backdrop-blur-sm transition-colors titlebar-no-drag focus-within:border-foreground/20">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT_FILES}
              className="hidden"
              onChange={(event) => {
                if (event.target.files) addFiles(event.target.files);
                event.target.value = "";
              }}
            />

            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1 px-[15px] py-[5px]">
                {attachments.map((file) => (
                  <DesktopAttachmentPreviewItem
                    key={fileKey(file)}
                    file={file}
                    onRemove={() =>
                      setAttachments((prev) => prev.filter((f) => fileKey(f) !== fileKey(file)))
                    }
                  />
                ))}
              </div>
            )}

            <div className="relative px-[15px] pb-2">
              <Textarea
                autoFocus
                ref={textareaRef}
                value={draft}
                rows={3}
                disabled={starting}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={rerollPlaceholder}
                onClick={rerollPlaceholder}
                placeholder={takeChars(placeholder.text, revealed)}
                // The right padding is constant rather than applied only when the
                // clear button shows — otherwise the text would reflow the moment
                // the first character is typed.
                className="min-h-[72px] max-h-[200px] resize-none border-0 bg-transparent p-0 pr-7 text-sm leading-5 shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0"
              />
              {/* Always mounted so it can fade *out* as well as in; visibility and
                  hit-testing are driven by the same `hasInput` flag. */}
              <button
                type="button"
                aria-hidden={!hasInput}
                tabIndex={hasInput ? 0 : -1}
                onClick={clearInput}
                aria-label={getChatLabel("chat.welcome.clearInput")}
                title={getChatLabel("chat.welcome.clearInput")}
                className={cn(
                  "group absolute right-[13px] top-0 inline-flex size-[22px] items-center justify-center rounded-full text-muted-foreground/60 transition-all duration-150 ease-out hover:bg-foreground/[0.06] hover:text-foreground",
                  hasInput ? "scale-100 opacity-100" : "pointer-events-none scale-90 opacity-0",
                )}
              >
                {/* Rotating the glyph rather than the button keeps the circular
                    hover backdrop still and the hit area unchanged. A ✕ is
                    symmetric every 90°, so a quarter turn is only visible while it
                    is in flight; the slight scale gives the resting hover state a
                    difference you can actually see too. */}
                <X className="size-[15px] transition-transform duration-300 ease-out group-hover:rotate-90 group-hover:scale-110" />
              </button>
            </div>

            <div className="flex h-[40px] items-center justify-between gap-4 px-2 py-[5px]">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => fileInputRef.current?.click()}
                  className="size-[30px] rounded-full text-foreground/60 hover:text-foreground"
                  aria-label="Attach"
                  title="Add Attachments"
                >
                  <Paperclip className="size-5" />
                </Button>

                <DesktopComposerModeChip mode={composerMode} onModeChange={setComposerMode} />

                <button
                  type="button"
                  onClick={() => setModelPickerOpen(true)}
                  className={cn(
                    "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                    selection
                      ? "text-muted-foreground hover:bg-accent hover:text-foreground"
                      : "text-orange-600 hover:bg-orange-500/10 hover:text-orange-700",
                  )}
                  aria-label="Model"
                  title="Model"
                >
                  {selectedProvider ? (
                    <DesktopProviderLogo provider={selectedProvider} className="size-4" />
                  ) : null}
                  <span className="max-w-[220px] truncate">
                    {selection?.modelId ?? getChatLabel("chat.welcome.noModel")}
                  </span>
                  <ChevronDown className="size-3" />
                </button>

                <button
                  type="button"
                  onClick={() => setForceWebSearch((on) => !on)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                    forceWebSearch
                      ? "bg-emerald-400/20 text-emerald-500 hover:bg-emerald-400/30"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  aria-label="Allow web search"
                  title={forceWebSearch ? "Web Search: On" : "Web Search: Off"}
                >
                  <Globe className="size-3.5" />
                  <span>Web Search</span>
                </button>

                {composerMode === "agent" && (
                  <button
                    type="button"
                    onClick={toggleFullAccess}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
                      fullAccessEnabled
                        ? "bg-rose-400/20 text-rose-600 hover:bg-rose-400/30"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                    aria-label="Full Access"
                    title={
                      fullAccessEnabled
                        ? "Full Access: All operations auto-approved"
                        : "Full Access: Off (dangerous commands need approval)"
                    }
                  >
                    <ShieldOff size={14} />
                    <span>Full Access</span>
                  </button>
                )}
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "size-[30px] rounded-full",
                  canSubmit
                    ? "text-primary hover:bg-primary/10"
                    : "cursor-not-allowed text-foreground/30",
                )}
                disabled={!canSubmit}
                onClick={() => void start(draft)}
                aria-label="Send"
                title="Send"
              >
                <CornerDownLeft className="size-[22px]" />
              </Button>
            </div>
          </div>

          {/* `items-start`: without it these stretch to the full column width, so
              the hit area (and the hover highlight) ran far past the text and a
              click on empty space to the right still filled the box. */}
          <div className="mt-4 flex flex-col items-start">
            {suggestions.map((text) => (
              <button
                key={text}
                type="button"
                disabled={starting}
                onClick={() => applySuggestion(text)}
                className="flex max-w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-sm text-foreground/70 transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
              >
                <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{text}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {modelPickerOpen && (
        <DesktopModelPickerModal
          opened={modelPickerOpen}
          onClose={() => setModelPickerOpen(false)}
          onSelect={(next) => setPickedModel(next)}
          appliesTo="draft"
          current={
            selection ? { channelId: selection.channelId, modelId: selection.modelId } : null
          }
        />
      )}
    </div>
  );
}
