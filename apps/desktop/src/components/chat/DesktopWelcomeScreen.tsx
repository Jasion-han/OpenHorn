import {
  ChevronDown,
  CornerDownLeft,
  Globe,
  MessageSquare,
  Paperclip,
  ShieldOff,
  Sparkles,
} from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { fileKey } from "shared/format";
import { Button, cn, Textarea } from "ui";
import { getDesktopBackendBase } from "../../lib/backendBase";
import { DEFAULT_CONVERSATION_TITLE } from "../../lib/conversationTitle";
import { getGlobalDefaultChannel } from "../../lib/defaultChannel";
import { getChatLabel } from "../../lib/i18n/agent";
import { notifyError } from "../../lib/notify";
import { useAuthStore } from "../../stores/authStore";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { DesktopAttachmentPreviewItem } from "./DesktopAttachmentPreviewItem";
import { ACCEPT_FILES } from "./DesktopComposer";
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
  const fileInputRef = useRef<HTMLInputElement>(null);

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

            <div className="px-[15px] pb-2">
              <Textarea
                autoFocus
                value={draft}
                rows={3}
                disabled={starting}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={getChatLabel("chat.welcome.placeholder")}
                className="min-h-[72px] max-h-[200px] resize-none border-0 bg-transparent p-0 text-sm leading-5 shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0"
              />
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

                <button
                  type="button"
                  onClick={() => setComposerMode(composerMode === "chat" ? "agent" : "chat")}
                  className="flex min-w-[68px] items-center justify-center gap-1.5 rounded-[10px] px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="Mode"
                  title="Mode"
                >
                  <span className="truncate">{composerMode === "chat" ? "Chat" : "Agent"}</span>
                  <ChevronDown className="size-3" />
                </button>

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

          <div className="mt-4 flex flex-col">
            {suggestions.map((text) => (
              <button
                key={text}
                type="button"
                disabled={starting}
                onClick={() => void start(text)}
                className="flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-sm text-foreground/70 transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
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
