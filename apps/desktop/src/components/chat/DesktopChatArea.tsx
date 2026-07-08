import { defaultRangeExtractor, type Range, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fileKey } from "shared/format";
import { Button, cn, Textarea } from "ui";
import { useSidecarAgentRun } from "../../hooks/useSidecarAgentRun";
import { filesToAttachmentParts } from "../../lib/attachmentParts";
import { uploadAttachments } from "../../lib/attachments";
import { getDesktopBackendBase } from "../../lib/backendBase";
import {
  DEFAULT_CONVERSATION_TITLE,
  isDefaultConversationTitle,
} from "../../lib/conversationTitle";
import { getGlobalDefaultChannel } from "../../lib/defaultChannel";
import { getEffectiveModelForConversation } from "../../lib/effectiveModel";
import { getChatLabel, getSlashLabel } from "../../lib/i18n/agent";
import {
  findGroupIndexByMessageId,
  groupMessagesByRound,
  type MessageRoundGroup,
} from "../../lib/messageGroups";
import { notifyWarning } from "../../lib/notify";
import { createServerApi, readErrorMessage } from "../../lib/serverApi";
import {
  findKnownSlashToken,
  findSlashTokenAtCursor,
  type SlashCommandType,
  stripSlashToken,
} from "../../lib/slashToken";
import { readSseStream } from "../../lib/sse";
import { discoverSkills, skillsDisabledList } from "../../lib/tauriBridge";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { useSidecarStore } from "../../stores/sidecarStore";
import type { ChatStreamEvent, Message, MessageAttachmentMeta } from "../../types/chat";
import { DesktopChatHeader } from "./DesktopChatHeader";
import { DesktopComposer, type SlashHighlightRange, type SlashPanelItem } from "./DesktopComposer";
import { MessageBubble } from "./DesktopMessageBubble";
import { DesktopModelPickerModal } from "./DesktopModelPickerModal";
import { DesktopSidecarRuntimePanel } from "./DesktopSidecarRuntimePanel";

const PAGE_PAD = "16px";
const COMPOSER_PAD_BOTTOM = "env(safe-area-inset-bottom, 0px)";
const PLACEHOLDERS = [
  "Start with a spark — I will shape the rest.",
  "What should we build, refine, or rethink today?",
  "Drop a thought. I will turn it into something real.",
  "Give me a direction, I will find the path.",
  "Ask anything. Then push it one level deeper.",
  "Sketch the idea. I will fill in the lines.",
  "Let us turn a question into a plan.",
  "Pitch the headline. I will write the story.",
  "Take the blank page. I will bring the motion.",
  "Name the problem. I will cut through it.",
  "Start messy. End elegant.",
  "One prompt away from clarity.",
  "Tell me the goal, I will map the route.",
  "What would you love to ship this week?",
  "Let us turn curiosity into momentum.",
  "If you can imagine it, we can draft it.",
  "Give me the vibe. I will deliver the words.",
  "Turn a rough idea into a sharp answer.",
  "Ask for bold. I will keep it grounded.",
  "What do you wish existed right now?",
  "We can brainstorm or go straight to done.",
  "Write less. Say more.",
  "A single line can unlock the whole plan.",
  "Let us design the next move.",
  "Bring the question. Leave with the output.",
  "Make it clear, make it quick, make it real.",
  "Want a first draft that actually works?",
  "Turn complexity into clean steps.",
  "Take a breath — then type the dream.",
  "If it matters, put it here.",
];

type DesktopSearchStatus = {
  configured: boolean;
  source: "user" | "server" | "none" | "disabled";
};

function pickPlaceholder(avoid?: string) {
  if (PLACEHOLDERS.length === 0) return "";
  if (PLACEHOLDERS.length === 1) return PLACEHOLDERS[0] ?? "";
  let next = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)] ?? "";
  if (avoid && PLACEHOLDERS.length > 1) {
    let tries = 0;
    while (next === avoid && tries < 4) {
      next = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)] ?? next;
      tries += 1;
    }
  }
  return next;
}

async function fetchDesktopSearchStatus(): Promise<DesktopSearchStatus> {
  const response = await fetch(`${getDesktopBackendBase()}/settings/search-status`, {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Failed to read search status"));
  }

  return (await response.json()) as DesktopSearchStatus;
}

const chatAreaApi = createServerApi();
const GLOBAL_SYSTEM_PROMPT_KEY = "chat.systemPrompt";

async function fetchGlobalSystemPrompt(): Promise<string | undefined> {
  try {
    const { settings } = await chatAreaApi.settings.get([GLOBAL_SYSTEM_PROMPT_KEY]);
    const value = settings[GLOBAL_SYSTEM_PROMPT_KEY];
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shared run-settings resolution used by the send / retry / edit paths so the
 * three sites cannot drift. Returns the global system prompt plus the Tavily
 * key (only forwarded when web search is forced and Tavily is enabled; a
 * disabled Tavily lets the sidecar fall back to keyless DuckDuckGo).
 */
async function resolveRunSettings(forceWebSearch: boolean): Promise<{
  systemPrompt: string | undefined;
  tavilyApiKey: string | undefined;
}> {
  const systemPrompt = await fetchGlobalSystemPrompt();
  let tavilyApiKey: string | undefined;
  if (forceWebSearch) {
    try {
      const { settings } = await chatAreaApi.settings.get([
        "liveSearch.tavilyApiKey",
        "liveSearch.tavilyEnabled",
      ]);
      if (settings["liveSearch.tavilyEnabled"] !== "false") {
        tavilyApiKey = settings["liveSearch.tavilyApiKey"] || undefined;
      }
    } catch {
      // ignore
    }
  }
  return { systemPrompt, tavilyApiKey };
}

/** Collapse newlines / repeated whitespace into a single line for the slash panel. */
function collapseLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

// Meta persisted with a local (sidecar) run's user message. Only durable fields
// go to the server — previewUrl is a session-scoped objectURL and must not leak.
function toSyncAttachmentsMeta(
  meta?: MessageAttachmentMeta[],
): Array<{ fileName: string; fileType?: string; fileSize?: number }> | undefined {
  if (!meta || meta.length === 0) return undefined;
  return meta.map(({ fileName, fileType, fileSize }) => ({ fileName, fileType, fileSize }));
}

export function DesktopChatArea() {
  const ASSISTANT_BUBBLE_WIDTH = "92%";
  const USER_BUBBLE_MAX_WIDTH = "72%";
  const currentConversation = useChatStore((state) => state.currentConversation);
  const channels = useChatStore((state) => state.channels);
  const messages = useChatStore((state) => state.messages);
  const isLoading = useChatStore((state) => state.isLoading);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const composerMode = useChatStore((state) => state.composerMode);
  const setComposerMode = useChatStore((state) => state.setComposerMode);
  const addMessage = useChatStore((state) => state.addMessage);
  const autoTitleConversation = useChatStore((state) => state.autoTitleConversation);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const applyStreamEvent = useChatStore((state) => state.applyStreamEvent);
  const loadMessages = useChatStore((state) => state.loadMessages);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const deleteMessage = useChatStore((state) => state.deleteMessage);
  const regenerateMessage = useChatStore((state) => state.regenerateMessage);
  const abortStreaming = useChatStore((state) => state.abortStreaming);
  const setLoading = useChatStore((state) => state.setLoading);
  const setStreaming = useChatStore((state) => state.setStreaming);
  const setError = useChatStore((state) => state.setError);
  const editUserMessage = useChatStore((state) => state.editUserMessage);
  const updateMessage = useChatStore((state) => state.updateMessage);
  const [input, setInput] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [placeholder, setPlaceholder] = useState(() => pickPlaceholder());
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingPreviewUrlsRef = useRef<Map<string, string[]>>(new Map());
  const pendingScrollTargetRef = useRef<
    { type: "bottom" } | { type: "message"; id: string } | null
  >(null);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const fullAccessEnabled = useDesktopShellStore((state) => state.fullAccessEnabled);
  const toggleFullAccess = useDesktopShellStore((state) => state.toggleFullAccess);
  const createConversation = useChatStore((state) => state.createConversation);
  const openSettings = useDesktopShellStore((state) => state.openSettings);
  const setActiveView = useDesktopShellStore((state) => state.setActiveView);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  // The `/token` span (start = `/`, end = cursor) the panel is filtering on.
  // Captured on input so a later panel click (which does not move the caret)
  // still replaces the right slice.
  const slashTokenRangeRef = useRef<{ start: number; end: number } | null>(null);
  const [slashSkills, setSlashSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [slashMcps, setSlashMcps] = useState<Array<{ id: string; name: string; type: string }>>([]);
  // Known skill/MCP command names with their type — drives the bubble chip and
  // send-time slash resolution. Built-in commands are added separately where
  // needed (highlight/send); they never persist into a stored message.
  const knownSlashCommands = useMemo(() => {
    const map = new Map<string, SlashCommandType>();
    for (const s of slashSkills) map.set(s.name.toLowerCase(), "skill");
    for (const m of slashMcps) map.set(m.name.toLowerCase(), "mcp");
    return map;
  }, [slashSkills, slashMcps]);
  const sidecarRun = useSidecarAgentRun();
  const prevSidecarBusyRef = useRef(false);
  useEffect(() => {
    const wasBusy = prevSidecarBusyRef.current;
    prevSidecarBusyRef.current = sidecarRun.isBusy;
    if (wasBusy && !sidecarRun.isBusy) {
      setStreaming(false);
      setStreamingAssistantId(null);
      const conv = useChatStore.getState().currentConversation;
      if (conv && isDefaultConversationTitle(conv.title)) {
        const firstUserMsg = useChatStore
          .getState()
          .messages.find((m) => m.conversationId === conv.id && m.role === "user");
        const seed = firstUserMsg?.content || "";
        if (seed) {
          void autoTitleConversation(conv.id, seed).catch(() => {});
        }
      }
      void loadConversations();
    }
  }, [sidecarRun.isBusy, autoTitleConversation]);

  const effectiveModel = getEffectiveModelForConversation(channels, currentConversation);
  const agentModeSupported = effectiveModel.ok;
  const agentModeDisabledReason = effectiveModel.ok
    ? null
    : getChatLabel("chat.agentUnavailableReason");
  const hasInput = Boolean(input.trim());
  const hasFiles = pendingAttachments.length > 0;
  const forceWebSearch = currentConversation?.forceWebSearch ?? true;
  const canSend =
    effectiveModel.ok &&
    Boolean(currentConversation) &&
    !isLoading &&
    !isStreaming &&
    !isUploading &&
    (hasInput || hasFiles);
  // Memoized: during streaming `messages` changes on every token, and without
  // this the whole round-grouping array would be rebuilt each token even though
  // the grouping only depends on the message list.
  const groupedMessages = useMemo(() => groupMessagesByRound(messages), [messages]);

  // Group indexes that MUST always stay mounted regardless of the scroll window:
  //  - the group carrying the currently streaming assistant (keeps the
  //    `DesktopStreamingMarkdownMessage` smoother alive so it never resets),
  //  - any group whose assistant run is still running/partial (survives a
  //    conversation switch and back),
  //  - the group being edited (keeps the inline <Textarea> + its focus mounted).
  // The pinned scroll target's user message lives in the same round group as the
  // streaming assistant, so forcing the streaming group also keeps the pin
  // target rendered for the re-pin layout effect below.
  const forcedGroupIndexes = useMemo(() => {
    const indexes: number[] = [];
    if (streamingAssistantId) {
      const idx = groupedMessages.findIndex(
        (g) =>
          g.assistant?.msg.id === streamingAssistantId || g.user?.msg.id === streamingAssistantId,
      );
      if (idx >= 0) indexes.push(idx);
    }
    const runningIdx = groupedMessages.findIndex((g) => {
      const status = g.assistant?.msg.agentRun?.status;
      return status === "running" || status === "partial";
    });
    if (runningIdx >= 0) indexes.push(runningIdx);
    if (editingMessageId) {
      const idx = findGroupIndexByMessageId(groupedMessages, editingMessageId);
      if (idx >= 0) indexes.push(idx);
    }
    return indexes;
  }, [groupedMessages, streamingAssistantId, editingMessageId]);

  const getItemKey = useCallback(
    (index: number) => groupedMessages[index]?.key ?? index,
    [groupedMessages],
  );

  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      for (const idx of forcedGroupIndexes) {
        if (idx >= 0 && idx < range.count) indexes.add(idx);
      }
      return Array.from(indexes).sort((a, b) => a - b);
    },
    [forcedGroupIndexes],
  );

  const virtualizer = useVirtualizer({
    count: groupedMessages.length,
    getScrollElement: () => viewportRef.current,
    // Rough initial guess; every row is dynamically re-measured via
    // `measureElement`'s ResizeObserver (handles deferred code highlighting,
    // AgentRunPanel expand/collapse, async images and streaming growth).
    estimateSize: () => 120,
    getItemKey,
    overscan: 6,
    // React 19: avoid the "flushSync was called from inside a lifecycle" warning.
    useFlushSync: false,
    rangeExtractor,
  });

  useEffect(() => {
    pendingScrollTargetRef.current = { type: "bottom" };
    queueMicrotask(() => inputRef.current?.focus());
  }, [currentConversation?.id]);

  useLayoutEffect(() => {
    const viewportEl = viewportRef.current;
    const pending = pendingScrollTargetRef.current;
    if (!viewportEl || !pending) return;

    if (pending.type === "bottom") {
      const lastIndex = groupedMessages.length - 1;
      if (lastIndex < 0) {
        pendingScrollTargetRef.current = null;
        return;
      }
      // scrollToIndex keeps an internal reconcile loop and re-settles to the
      // real bottom as dynamic row heights are measured, replacing the old
      // `scrollTop = scrollHeight` one-shot.
      virtualizer.scrollToIndex(lastIndex, { align: "end" });
      pendingScrollTargetRef.current = null;
      return;
    }

    // Pin the target user message's group to the top of the viewport. While
    // streaming we keep retrying (the assistant answer grows below, so the
    // group can only reach the very top once enough content exists) — this
    // mirrors the old anchor-based re-pin behaviour exactly.
    const groupIndex = findGroupIndexByMessageId(groupedMessages, pending.id);
    if (groupIndex < 0) return; // group not present yet — retry on next run

    virtualizer.scrollToIndex(groupIndex, { align: "start" });

    const rowEl = viewportEl.querySelector<HTMLElement>(`[data-index="${groupIndex}"]`);
    if (!rowEl) return; // forced row not mounted yet — retry on next run

    const distanceFromTop =
      rowEl.getBoundingClientRect().top - viewportEl.getBoundingClientRect().top;

    if (Math.abs(distanceFromTop) <= 4 || !isStreaming) {
      pendingScrollTargetRef.current = null;
    }
  }, [
    messages,
    groupedMessages,
    currentConversation?.id,
    editingMessageId,
    isStreaming,
    virtualizer,
  ]);

  useEffect(() => {
    setStreamingAssistantId(null);
    sidecarRun.clearError();
  }, [currentConversation?.id]);

  useEffect(() => {
    setPendingAttachments([]);
  }, [currentConversation?.id]);

  // Prefetch enabled skills + MCP servers for the slash (/) command panel.
  // currentConversation?.id and slashOpen are intentional re-fetch triggers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are triggers, not read in body
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [discovered, disabled, mcpRes] = await Promise.all([
          discoverSkills(),
          skillsDisabledList(),
          chatAreaApi.mcp.listServers(),
        ]);
        if (cancelled) return;
        const disabledSet = new Set(disabled.map((n) => n.trim().toLowerCase()));
        const servers = mcpRes.servers as Array<{
          id: string;
          name: string;
          type?: string;
          isEnabled: boolean;
        }>;
        setSlashSkills(
          (discovered ?? [])
            .filter((s) => !disabledSet.has(s.name.trim().toLowerCase()))
            .map((s) => ({
              id: s.path,
              name: s.name,
              description: collapseLine(s.description ?? ""),
            })),
        );
        setSlashMcps(
          servers
            .filter((m) => m.isEnabled)
            .map((m) => ({ id: m.id, name: m.name, type: m.type ?? "" })),
        );
      } catch {
        // ignore — the panel still works with built-in commands only
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentConversation?.id, slashOpen]);

  useEffect(() => {
    if (!input.trim()) {
      setPlaceholder((prev) => pickPlaceholder(prev));
    }
  }, [currentConversation?.id, input]);

  useEffect(() => {
    return () => {
      for (const urls of pendingPreviewUrlsRef.current.values()) {
        for (const url of urls) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore
          }
        }
      }
      pendingPreviewUrlsRef.current.clear();
    };
  }, [currentConversation?.id]);

  // Precompute editability once per `messages` change. `renderMessageRow` runs
  // for every visible row on every streamed token, so calling the O(n)
  // `getEditableMessageRound` per row was O(visibleRows × messages) per token.
  // The set mirrors `getEditableMessageRound(...)` truthiness exactly: a
  // non-draft user message whose following message (if any) is a matching
  // non-draft assistant of the same mode.
  const editableMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (let i = 0; i < messages.length; i++) {
      const userMessage = messages[i];
      if (userMessage.role !== "user" || userMessage.id.startsWith("draft-")) continue;
      const assistantMessage = messages[i + 1];
      if (
        assistantMessage &&
        (assistantMessage.role !== "assistant" ||
          assistantMessage.mode !== userMessage.mode ||
          assistantMessage.id.startsWith("draft-"))
      ) {
        continue;
      }
      ids.add(userMessage.id);
    }
    return ids;
  }, [messages]);

  const getEditableMessageRound = (messageId: string) => {
    const messageIndex = messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) return null;

    const userMessage = messages[messageIndex];
    const assistantMessage = messages[messageIndex + 1];
    if (!userMessage || userMessage.role !== "user" || userMessage.id.startsWith("draft-")) {
      return null;
    }
    if (
      assistantMessage &&
      (assistantMessage.role !== "assistant" ||
        assistantMessage.mode !== userMessage.mode ||
        assistantMessage.id.startsWith("draft-"))
    ) {
      return null;
    }

    return { userMessage, assistantMessage };
  };

  const handleAddAttachments = (files: File[]) => {
    setPendingAttachments((currentFiles) => {
      const seen = new Set(currentFiles.map(fileKey));
      const nextFiles = [...currentFiles];

      for (const file of files) {
        const key = fileKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        nextFiles.push(file);
      }

      return nextFiles;
    });
  };

  const handleRemoveAttachment = (file: File) => {
    const targetKey = fileKey(file);
    setPendingAttachments((currentFiles) =>
      currentFiles.filter((item) => fileKey(item) !== targetKey),
    );
  };

  const consumeStreamingResponse = async (messageId: string, response: Response) => {
    let terminalEvent: Extract<ChatStreamEvent, { type: "done" | "error" }> | null = null;

    await readSseStream(response, (event) => {
      if (event.type === "delta") {
        const chunk = event.content || "";
        if (!chunk) return;
        useChatStore.getState().appendMessageDelta(messageId, chunk);
        return;
      }

      if (event.type === "done" || event.type === "error") {
        terminalEvent = event;
        return;
      }

      applyStreamEvent(messageId, event);
    });

    if (terminalEvent) {
      applyStreamEvent(messageId, terminalEvent);
    }
  };

  const handleInputFocus = () => {
    if (!input.trim()) {
      setPlaceholder((prev) => pickPlaceholder(prev));
    }
  };

  const runNewConversation = () => {
    const state = useChatStore.getState();
    const defaultChannel = getGlobalDefaultChannel(state.channels);
    void createConversation(DEFAULT_CONVERSATION_TITLE, {
      channelId: defaultChannel?.channelId ?? null,
      modelId: defaultChannel?.modelId ?? null,
    })
      .then(() => setActiveView("chat"))
      .catch(() => {});
  };

  // Plain consts (not memoized): recomputed each render, which is cheap and
  // avoids stale closures over the latest store state inside the handlers.
  const builtinCommands: Array<{ id: string; name: string; subtitle: string; run: () => void }> = [
    {
      id: "new-conversation",
      name: getSlashLabel("slash.command.newConversation"),
      subtitle: getSlashLabel("slash.command.newConversation.desc"),
      run: runNewConversation,
    },
    {
      id: "open-settings",
      name: getSlashLabel("slash.command.openSettings"),
      subtitle: getSlashLabel("slash.command.openSettings.desc"),
      run: () => openSettings(),
    },
  ];

  const buildSlashItems = (): Array<SlashPanelItem & { run?: () => void }> => {
    if (!slashOpen) return [];
    const q = slashQuery.toLowerCase();
    const items: Array<SlashPanelItem & { run?: () => void }> = [];
    const skillGroup = getSlashLabel("slash.group.skill");
    for (const s of slashSkills) {
      if (q && !s.name.toLowerCase().includes(q)) continue;
      items.push({
        type: "skill",
        id: s.id,
        name: s.name,
        subtitle: s.description,
        group: skillGroup,
      });
    }
    const mcpGroup = getSlashLabel("slash.group.mcp");
    for (const m of slashMcps) {
      if (q && !m.name.toLowerCase().includes(q)) continue;
      items.push({ type: "mcp", id: m.id, name: m.name, subtitle: m.type, group: mcpGroup });
    }
    const cmdGroup = getSlashLabel("slash.group.command");
    for (const c of builtinCommands) {
      if (q && !c.name.toLowerCase().includes(q)) continue;
      items.push({
        type: "command",
        id: c.id,
        name: c.name,
        subtitle: c.subtitle,
        group: cmdGroup,
        run: c.run,
      });
    }
    return items;
  };
  const slashItems = buildSlashItems();

  // The `/<name>` token span to paint blue, anywhere in the input, but only when
  // it matches a *recognized* command (enabled skill / enabled MCP server /
  // built-in command id or name). Unrecognized `/xxx` is not highlighted. Reuses
  // the slash data already fetched for the panel — no extra requests.
  const slashHighlight: SlashHighlightRange | null = (() => {
    const recognized = new Map(knownSlashCommands);
    for (const c of builtinCommands) {
      recognized.set(c.name.toLowerCase(), "command");
      recognized.set(c.id.toLowerCase(), "command");
    }
    const token = findKnownSlashToken(input, recognized);
    return token ? { start: token.start, len: token.end - token.start } : null;
  })();

  const handleInputChange = (value: string) => {
    setInput(value);
    // The textarea's selection is already updated when change fires, so the
    // cursor position tells us which `/token` (if any) is being typed.
    const cursor = inputRef.current?.selectionStart ?? value.length;
    const token = findSlashTokenAtCursor(value, cursor);
    if (token) {
      slashTokenRangeRef.current = { start: token.start, end: cursor };
      setSlashQuery(token.query);
      setSlashIndex(0);
      setSlashOpen(true);
      return;
    }
    slashTokenRangeRef.current = null;
    setSlashOpen(false);
  };

  const handleSlashSelect = (index: number) => {
    const item = slashItems[index];
    if (!item) return;
    // Re-validate the captured `/token` span against the *current* input before
    // splicing — a stale or shifted range (e.g. IME composition edge cases) must
    // never eat user text. If invalid, re-derive from the caret; if that also
    // fails, close the panel and leave the input untouched.
    const stored = slashTokenRangeRef.current;
    slashTokenRangeRef.current = null;
    setSlashOpen(false);
    let range =
      stored &&
      stored.start >= 0 &&
      stored.end >= stored.start + 1 &&
      stored.end <= input.length &&
      input[stored.start] === "/" &&
      !/\s/.test(input.slice(stored.start + 1, stored.end))
        ? stored
        : null;
    if (!range) {
      const cursor = inputRef.current?.selectionStart ?? input.length;
      const token = findSlashTokenAtCursor(input, cursor);
      if (token) range = { start: token.start, end: Math.min(cursor, input.length) };
    }
    if (!range) return;
    if (item.type === "command") {
      // Built-ins run immediately; only the typed `/token` is cleaned up, any
      // other text the user already wrote stays.
      const remainder = input.slice(0, range.start) + input.slice(range.end).replace(/^[ \t]/, "");
      setInput(remainder.trim() ? remainder : "");
      item.run?.();
      return;
    }
    // Replace the typed `/token` in place — never wipe the rest of the input.
    const insert = `/${item.name} `;
    const next = input.slice(0, range.start) + insert + input.slice(range.end);
    const caret = range.start + insert.length;
    setInput(next);
    queueMicrotask(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent;
    const keyCode =
      "keyCode" in nativeEvent ? (nativeEvent.keyCode as number | undefined) : undefined;
    const composing = nativeEvent.isComposing || keyCode === 229;

    if (slashOpen && !composing && slashItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((i) => (i + 1) % slashItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        handleSlashSelect(slashIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashOpen(false);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      if (composing) {
        return;
      }
      event.preventDefault();
      void handleSend();
    }
  };

  // Resolve the first token-boundary `/skill` or `/mcp` slash command (anywhere
  // in the text, one per message) into the model-facing instruction wrapper
  // (`sendContent`), the content shown/stored in the user bubble
  // (`displayContent`, keeps the `/token` in place for the chip), and a clean
  // title seed. Shared by the send and edit-resend paths so both behave the same.
  const resolveSkillMcpSlash = (
    text: string,
  ): {
    sendContent: string;
    displayContent: string;
    titleContent: string;
    // Canonical name of the invoked MCP server (undefined for skills/no token);
    // startRun uses it to connect that single server instead of the full roster.
    targetMcpServer?: string;
  } => {
    const token = findKnownSlashToken(text, knownSlashCommands);
    if (!token) {
      return { sendContent: text, displayContent: text, titleContent: text };
    }
    const canonicalName =
      token.type === "skill"
        ? (slashSkills.find((s) => s.name.toLowerCase() === token.name.toLowerCase())?.name ??
          token.name)
        : (slashMcps.find((m) => m.name.toLowerCase() === token.name.toLowerCase())?.name ??
          token.name);
    const rest = stripSlashToken(text, token);
    const instructionKey =
      token.type === "skill" ? "slash.instruction.skill" : "slash.instruction.mcp";
    const sendContent = getSlashLabel(instructionKey)
      .replace("{name}", canonicalName)
      .replace("{rest}", rest)
      .trimEnd();
    return {
      sendContent,
      displayContent: text,
      titleContent: rest || canonicalName,
      targetMcpServer: token.type === "mcp" ? canonicalName : undefined,
    };
  };

  const handleSend = async () => {
    if (!canSend || !currentConversation) return;

    if (composerMode === "agent" && !agentModeSupported) {
      notifyWarning(
        getChatLabel("chat.agentUnavailableTitle"),
        agentModeDisabledReason || getChatLabel("chat.agentUnavailableReason"),
      );
      return;
    }

    const conversationId = currentConversation.id;
    const mode = composerMode;
    const trimmed = input.trim();

    // Built-in slash commands (e.g. /新会话) run immediately and abort the send,
    // matching the same any-position token-boundary rule as skills/MCP.
    // Skill/MCP commands resolve into the instruction wrapper below.
    // Recognize both name and id, matching the highlight's `recognized` map — a
    // token painted blue in the input must also be acted on at send time.
    const builtinNames = new Map<string, SlashCommandType>();
    for (const c of builtinCommands) {
      builtinNames.set(c.name.toLowerCase(), "command");
      builtinNames.set(c.id.toLowerCase(), "command");
    }
    const builtinToken = findKnownSlashToken(trimmed, builtinNames);
    if (builtinToken) {
      const typed = builtinToken.name.toLowerCase();
      const cmd = builtinCommands.find(
        (c) => c.name.toLowerCase() === typed || c.id.toLowerCase() === typed,
      );
      if (cmd) {
        cmd.run();
        setInput("");
        setSlashOpen(false);
        return;
      }
    }
    // `sendContent` is what we transmit to the model (may carry a strong skill
    // instruction); `displayContent` is what the user's bubble shows/stores
    // (their request with the normalized `/token` preserved for the chip).
    const { sendContent, displayContent, titleContent, targetMcpServer } =
      resolveSkillMcpSlash(trimmed);

    const files = pendingAttachments;
    const autoTitleSeed =
      titleContent.length > 0
        ? titleContent
        : files.length > 0
          ? `Attachments: ${files.map((file) => file.name).join(", ")}`
          : "";
    const previewUrls: string[] = [];
    const localAttachmentMeta: MessageAttachmentMeta[] = files.map((file) => {
      const previewUrl = file.type?.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (previewUrl) {
        previewUrls.push(previewUrl);
      }
      return {
        fileName: file.name,
        fileType: file.type || undefined,
        fileSize: file.size,
        previewUrl,
      };
    });
    const userMessageId = `temp-${Date.now()}`;
    const assistantMessageId = `temp-assistant-${Date.now()}`;
    if (previewUrls.length > 0) {
      pendingPreviewUrlsRef.current.set(userMessageId, previewUrls);
    }

    let attachmentIds: string[] | undefined;
    let attachmentsMeta:
      | Array<{
          id: string;
          fileName: string;
          fileType: string;
          fileSize: number;
        }>
      | undefined;

    try {
      addMessage({
        id: userMessageId,
        conversationId,
        role: "user",
        content: displayContent,
        mode,
        attachmentsMeta: localAttachmentMeta.length > 0 ? localAttachmentMeta : undefined,
        createdAt: new Date(),
      });
      addMessage({
        id: assistantMessageId,
        conversationId,
        role: "assistant",
        content: "",
        mode,
        agentRun:
          mode === "agent"
            ? {
                status: "partial",
                summary: "Thinking",
                steps: [],
              }
            : undefined,
        createdAt: new Date(),
      });
      pendingScrollTargetRef.current = { type: "message", id: userMessageId };
      setInput("");
      setSlashOpen(false);
      setLoading(true);
      setStreaming(true);
      setStreamingAssistantId(assistantMessageId);
      setError(null);
      queueMicrotask(() => inputRef.current?.focus());

      const sidecar = useSidecarStore.getState();
      if (sidecar.status !== "ready") {
        throw new Error(getChatLabel("chat.error.sidecarNotReady"));
      }

      if (mode === "agent") {
        // Local (sidecar) runs read attachments client-side and inject them as
        // normalized parts: image base64 + extracted file/PDF text.
        const attachmentParts = files.length > 0 ? await filesToAttachmentParts(files) : undefined;
        if (files.length > 0) {
          setPendingAttachments([]);
        }
        if (!currentConversation.channelId) {
          throw new Error(getChatLabel("chat.error.noChannel"));
        }
        if (!effectiveModel.ok) {
          throw new Error(getChatLabel("chat.error.noModel"));
        }
        const historyMsgs = useChatStore
          .getState()
          .messages.filter((m) => m.conversationId === conversationId && !m.id.startsWith("draft-"))
          .filter((m) => m.id !== userMessageId && m.id !== assistantMessageId);
        const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
        for (const m of historyMsgs) {
          const text = (m.content || "").trim();
          if (!text) continue;
          if (m.role === "user" || m.role === "assistant") {
            conversationHistory.push({ role: m.role, content: text });
          }
        }
        const { systemPrompt: globalSystemPrompt, tavilyApiKey } =
          await resolveRunSettings(forceWebSearch);
        await sidecarRun.startRun({
          conversationId,
          channelId: currentConversation.channelId,
          modelId: effectiveModel.modelId,
          assistantMessageId,
          prompt: sendContent,
          displayContent,
          permissionMode: fullAccessEnabled ? "full-access" : "default",
          systemPrompt: globalSystemPrompt,
          webSearchEnabled: forceWebSearch,
          tavilyApiKey,
          targetMcpServer,
          conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
          attachments: attachmentParts,
          attachmentsMeta: toSyncAttachmentsMeta(localAttachmentMeta),
        });

        setLoading(false);
        setIsUploading(false);
        queueMicrotask(() => inputRef.current?.focus());
        return;
      }

      if (files.length > 0) {
        setIsUploading(true);
        const upload = await uploadAttachments({
          conversationId,
          files,
        });
        attachmentIds = upload.attachments.map((attachment) => attachment.id);
        attachmentsMeta = upload.attachments.map((attachment) => ({
          id: attachment.id,
          fileName: attachment.fileName,
          fileType: attachment.fileType,
          fileSize: attachment.fileSize,
        }));
        updateMessage(userMessageId, {
          attachments: attachmentIds,
          attachmentsMeta: localAttachmentMeta.map((local, index) => {
            const server = upload.attachments[index];
            return {
              ...local,
              id: server?.id ?? local.id,
              fileName: server?.fileName ?? local.fileName,
              fileType: server?.fileType ?? local.fileType,
              fileSize: server?.fileSize ?? local.fileSize,
            };
          }),
        });
        setPendingAttachments([]);
      }

      const prepared = await chatAreaApi.messages.chatPrepare({
        conversationId,
        content: sendContent,
        attachments: attachmentIds,
      });

      updateMessage(userMessageId, { id: prepared.userMessageId });
      updateMessage(assistantMessageId, { id: prepared.assistantMessageId });
      setStreamingAssistantId(prepared.assistantMessageId);

      const sidecarClient = useSidecarStore.getState().client;
      if (!sidecarClient) {
        throw new Error(getChatLabel("chat.error.sidecarDisconnected"));
      }

      let chatContent = "";
      await new Promise<void>((resolve, reject) => {
        sidecarClient
          .chatStream({
            apiKey: prepared.apiKey,
            baseUrl: prepared.baseUrl || undefined,
            protocol: prepared.protocol,
            model: prepared.model,
            messages: prepared.messages,
            onEvent: (event) => {
              if (event.type === "execution_event" && event.eventType === "text") {
                chatContent += event.content || "";
                useChatStore
                  .getState()
                  .appendMessageDelta(prepared.assistantMessageId, event.content || "");
              }
            },
            onError: (message) => {
              chatContent = `Error: ${message}`;
              useChatStore
                .getState()
                .updateMessage(prepared.assistantMessageId, { content: chatContent });
              reject(new Error(message));
            },
            onDone: () => resolve(),
          })
          .catch(reject);
      });

      await chatAreaApi.messages.chatComplete({
        assistantMessageId: prepared.assistantMessageId,
        conversationId,
        content: chatContent,
        model: prepared.model,
      });

      setStreaming(false);
      setStreamingAssistantId(null);
      await Promise.all([loadMessages(conversationId), loadConversations()]);
      const nextConversation = useChatStore.getState().currentConversation;
      if (
        nextConversation &&
        nextConversation.id === conversationId &&
        isDefaultConversationTitle(nextConversation.title) &&
        autoTitleSeed
      ) {
        void autoTitleConversation(conversationId, autoTitleSeed).catch(() => {});
      }

      const urls = pendingPreviewUrlsRef.current.get(userMessageId);
      if (urls) {
        for (const url of urls) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore
          }
        }
        pendingPreviewUrlsRef.current.delete(userMessageId);
      }
    } catch (error) {
      setLoading(false);
      setStreaming(false);
      setStreamingAssistantId(null);
      if (isAbortError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : "Stream error";
      useChatStore.getState().failStreamingMessage(assistantMessageId, message);
      setError(message);
    } finally {
      setLoading(false);
      setIsUploading(false);
      queueMicrotask(() => inputRef.current?.focus());
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    try {
      await deleteMessage(messageId);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Delete message failed");
    }
  };

  const handleRetryMessage = async (messageId: string) => {
    if (!currentConversation) return;

    const messageIndex = messages.findIndex((message) => message.id === messageId);
    const assistantMessage = messageIndex >= 0 ? messages[messageIndex] : null;
    if (!assistantMessage || assistantMessage.role !== "assistant") return;

    let userMessage: Message | null = null;
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate?.role === "user") {
        userMessage = candidate;
        break;
      }
    }

    if (userMessage) {
      pendingScrollTargetRef.current = { type: "message", id: userMessage.id };
    }
    setLoading(true);
    setStreaming(true);
    setStreamingAssistantId(messageId);
    setError(null);
    useChatStore.getState().updateMessage(messageId, {
      content: "",
      streamTail: undefined,
      streamPulseKey: 0,
      citations: undefined,
      liveStatus: undefined,
      liveRoute: undefined,
      liveLabel: undefined,
      agentRun:
        assistantMessage.mode === "agent"
          ? {
              status: "partial",
              summary: "Thinking",
              steps: [],
            }
          : undefined,
    });

    const isSidecarRetry =
      assistantMessage?.mode === "agent" && currentConversation.channelId && effectiveModel.ok;

    try {
      if (isSidecarRetry && userMessage) {
        if (sidecarRun.isBusy) {
          await sidecarRun.cancel();
        }
        const historyMsgs = useChatStore
          .getState()
          .messages.filter(
            (m) => m.conversationId === currentConversation.id && !m.id.startsWith("draft-"),
          )
          .filter((m) => m.id !== userMessage.id && m.id !== messageId);
        const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
        for (const m of historyMsgs) {
          const text = (m.content || "").trim();
          if (!text) continue;
          if (m.role === "user" || m.role === "assistant") {
            conversationHistory.push({ role: m.role, content: text });
          }
        }
        const { systemPrompt: retrySystemPrompt, tavilyApiKey: retryTavilyApiKey } =
          await resolveRunSettings(forceWebSearch);
        // Re-parse the original message so a retried `/server` (or `/skill`)
        // invocation behaves exactly like the original send: the model gets the
        // instruction wrapper, the run targets that single MCP server, and the
        // bubble/persisted content keeps the raw `/token` text.
        const { sendContent: retrySendContent, targetMcpServer: retryTargetMcpServer } =
          resolveSkillMcpSlash(userMessage.content);
        await sidecarRun.startRun({
          conversationId: currentConversation.id,
          channelId: currentConversation.channelId!,
          modelId: effectiveModel.ok ? effectiveModel.modelId : "",
          assistantMessageId: messageId,
          prompt: retrySendContent,
          displayContent: userMessage.content,
          permissionMode: fullAccessEnabled ? "full-access" : "default",
          systemPrompt: retrySystemPrompt,
          webSearchEnabled: forceWebSearch,
          tavilyApiKey: retryTavilyApiKey,
          targetMcpServer: retryTargetMcpServer,
          conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
          attachmentsMeta: toSyncAttachmentsMeta(userMessage.attachmentsMeta),
        });
        setLoading(false);
      } else {
        const response = await regenerateMessage(
          messageId,
          userMessage && !userMessage.id.startsWith("draft-")
            ? {
                userMessageId: userMessage.id,
                userContent: userMessage.content,
              }
            : undefined,
        );

        if (!response.ok) {
          throw new Error(await readErrorMessage(response, "Failed to regenerate message"));
        }

        await consumeStreamingResponse(messageId, response);
        setStreaming(false);
        setStreamingAssistantId(null);
        await Promise.all([loadMessages(currentConversation.id), loadConversations()]);
      }
    } catch (error) {
      setLoading(false);
      setStreaming(false);
      setStreamingAssistantId(null);
      if (isAbortError(error)) {
        return;
      }
      setError(error instanceof Error ? error.message : "Retry message failed");
      useChatStore
        .getState()
        .failStreamingMessage(
          messageId,
          error instanceof Error ? error.message : "Retry message failed",
        );
    } finally {
      setLoading(false);
    }
  };

  const handleStartEdit = (message: Message) => {
    const editable = getEditableMessageRound(message.id);
    if (!editable) return;
    setEditingMessageId(message.id);
    setEditingContent(message.content);
  };

  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditingContent("");
  };

  const handleSaveEdit = async (messageId: string) => {
    const nextContent = editingContent.trim();
    if (!currentConversation || !nextContent) return;

    // Resolve slash commands just like a fresh send, so editing a `/web-access …`
    // message re-triggers the skill (wrapped prompt) instead of sending the raw
    // slash text — which would run tools but yield no final answer.
    const {
      sendContent: editSendContent,
      displayContent: editDisplayContent,
      targetMcpServer: editTargetMcpServer,
    } = resolveSkillMcpSlash(nextContent);

    const editable = getEditableMessageRound(messageId);
    if (!editable) {
      notifyWarning(getChatLabel("chat.notEditableTitle"), getChatLabel("chat.notEditableBody"));
      handleCancelEdit();
      return;
    }

    const { userMessage, assistantMessage: existingAssistantMessage } = editable;
    const assistantMessageId = existingAssistantMessage?.id ?? `temp-assistant-edit-${Date.now()}`;
    handleCancelEdit();
    pendingScrollTargetRef.current = { type: "message", id: userMessage.id };
    setLoading(true);
    setStreaming(true);
    setStreamingAssistantId(assistantMessageId);
    setError(null);
    useChatStore.getState().updateMessage(userMessage.id, { content: editDisplayContent });
    if (existingAssistantMessage) {
      useChatStore.getState().updateMessage(existingAssistantMessage.id, {
        content: "",
        streamTail: undefined,
        streamPulseKey: 0,
        citations: undefined,
        liveStatus: undefined,
        liveRoute: undefined,
        liveLabel: undefined,
        agentRun:
          existingAssistantMessage.mode === "agent"
            ? {
                status: "partial",
                summary: "Thinking",
                steps: [],
              }
            : undefined,
      });
    } else {
      addMessage({
        id: assistantMessageId,
        conversationId: currentConversation.id,
        role: "assistant",
        content: "",
        mode: userMessage.mode,
        agentRun:
          userMessage.mode === "agent"
            ? {
                status: "partial",
                summary: "Thinking",
                steps: [],
              }
            : undefined,
        createdAt: new Date(),
      });
    }

    const useSidecarForEdit =
      existingAssistantMessage?.mode === "agent" &&
      currentConversation.channelId &&
      effectiveModel.ok;

    try {
      if (useSidecarForEdit) {
        const historyMsgs = useChatStore
          .getState()
          .messages.filter(
            (m) => m.conversationId === currentConversation.id && !m.id.startsWith("draft-"),
          )
          .filter((m) => m.id !== userMessage.id && m.id !== assistantMessageId);
        const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
        for (const m of historyMsgs) {
          const text = (m.content || "").trim();
          if (!text) continue;
          if (m.role === "user" || m.role === "assistant") {
            conversationHistory.push({ role: m.role, content: text });
          }
        }
        const { systemPrompt: editSystemPrompt, tavilyApiKey: editTavilyApiKey } =
          await resolveRunSettings(forceWebSearch);
        await sidecarRun.startRun({
          conversationId: currentConversation.id,
          channelId: currentConversation.channelId!,
          modelId: effectiveModel.ok ? effectiveModel.modelId : "",
          assistantMessageId,
          prompt: editSendContent,
          displayContent: editDisplayContent,
          existingUserMessageId: userMessage.id,
          existingAssistantMessageId: existingAssistantMessage?.id,
          permissionMode: fullAccessEnabled ? "full-access" : "default",
          systemPrompt: editSystemPrompt,
          webSearchEnabled: forceWebSearch,
          tavilyApiKey: editTavilyApiKey,
          targetMcpServer: editTargetMcpServer,
          conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
          attachmentsMeta: toSyncAttachmentsMeta(userMessage.attachmentsMeta),
        });
        setLoading(false);
      } else {
        const response = await editUserMessage(userMessage.id, nextContent);
        await consumeStreamingResponse(assistantMessageId, response);
        setStreaming(false);
        setStreamingAssistantId(null);
        await Promise.all([loadMessages(currentConversation.id), loadConversations()]);
      }
    } catch (error) {
      setLoading(false);
      setStreaming(false);
      setStreamingAssistantId(null);
      if (isAbortError(error)) {
        return;
      }
      setError(error instanceof Error ? error.message : "Edit message failed");
      useChatStore
        .getState()
        .failStreamingMessage(
          assistantMessageId,
          error instanceof Error ? error.message : "Edit message failed",
        );
    } finally {
      setLoading(false);
    }
  };

  const handleToggleWebSearch = async () => {
    if (!currentConversation) return;

    const next = !forceWebSearch;
    if (next) {
      try {
        const status = await fetchDesktopSearchStatus();
        if (!status.configured || status.source === "none") {
          notifyWarning(
            getChatLabel("chat.search.notConfiguredTitle"),
            getChatLabel("chat.search.notConfiguredBody"),
          );
        } else if (status.source === "disabled") {
          notifyWarning(
            getChatLabel("chat.search.disabledTitle"),
            getChatLabel("chat.search.disabledBody"),
          );
        }
      } catch {
        // ignore search-status probe failures
      }
    }

    try {
      await useChatStore
        .getState()
        .updateConversation(currentConversation.id, { forceWebSearch: next });
    } catch {
      // updateConversation already restores previous state and records the error
    }
  };

  const handleStop = async () => {
    if (sidecarRun.isBusy) {
      await sidecarRun.cancel();
    }
    abortStreaming();

    setLoading(false);
    setStreaming(false);
    setStreamingAssistantId(null);
    if (!currentConversation) return;
    try {
      await loadMessages(currentConversation.id);
    } catch {
      // ignore reload failures after stop
    }
    queueMicrotask(() => inputRef.current?.focus());
  };

  if (!currentConversation) {
    return (
      <div className="flex flex-1 flex-col overflow-x-hidden">
        <div style={{ padding: PAGE_PAD, paddingBottom: "8px" }}>
          <DesktopChatHeader conversation={null} />
        </div>
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">{getChatLabel("chat.emptyState")}</p>
        </div>
      </div>
    );
  }

  const renderMessageRow = (message: Message) => (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        message.role === "assistant" ? "items-start" : "items-end",
      )}
    >
      {(() => {
        // "In progress" must be derived from the globally-persisted agentRun.status
        // (partial/running) rather than only the local streamingAssistantId. The
        // local id is reset whenever the user switches conversations / the area
        // unmounts, which previously made an active run look frozen on return.
        // Reading agentRun.status restores the live appearance on remount because
        // the global chat store (with messageCache fallback) keeps writing it.
        const isInProgress =
          message.agentRun?.status === "partial" || message.agentRun?.status === "running";
        // Keep the local-streaming fallback for chat-mode messages, which have no
        // agentRun. It also covers the brief window after sending an agent message
        // but before the first agent_event materializes agentRun.
        const isLocallyStreaming = Boolean(
          isStreaming && streamingAssistantId && message.id === streamingAssistantId,
        );
        const isMessageStreaming = isInProgress || isLocallyStreaming;

        return (
          <MessageBubble
            message={message}
            isStreaming={isMessageStreaming}
            canEdit={editableMessageIds.has(message.id)}
            canRetry={
              message.role === "assistant" && !isLoading && !isMessageStreaming && !isUploading
            }
            canDelete={!message.id.startsWith("draft-")}
            onEdit={() => handleStartEdit(message)}
            onRetry={() => void handleRetryMessage(message.id)}
            onDelete={() => void handleDeleteMessage(message.id)}
            assistantWidth={ASSISTANT_BUBBLE_WIDTH}
            userMaxWidth={USER_BUBBLE_MAX_WIDTH}
            knownCommands={knownSlashCommands}
          />
        );
      })()}

      {message.role === "user" && editingMessageId === message.id && (
        <div className="mt-1 flex w-full max-w-[72%] self-end flex-col items-end gap-1">
          <Textarea
            value={editingContent}
            onChange={(event) => setEditingContent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSaveEdit(message.id);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                handleCancelEdit();
              }
            }}
            className="w-full"
            rows={3}
            autoFocus
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={handleCancelEdit}>
              {getChatLabel("chat.edit.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSaveEdit(message.id)}
              disabled={!editingContent.trim() || isStreaming}
            >
              {getChatLabel("chat.edit.confirm")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden">
      <div style={{ padding: PAGE_PAD, paddingBottom: "8px" }}>
        <DesktopChatHeader conversation={currentConversation} />
      </div>

      <div
        ref={viewportRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto scrollbar-thin"
        style={{ paddingLeft: PAGE_PAD, paddingRight: PAGE_PAD }}
      >
        <div className="flex min-w-0 w-full flex-col">
          {/*
            Virtualized round-group list. `mt-auto` keeps short conversations
            hugging the composer (unchanged). The inner spacer owns the full
            measured height; each round group is absolutely positioned at its
            measured offset and only the visible window (+overscan +forced
            rows) is mounted. `getItemKey` (= group.key) keeps measurements and
            scroll stable across streaming updates and post-stream reloads.
          */}
          <div className="mt-auto flex min-w-0 flex-col pb-2">
            <div
              style={{
                position: "relative",
                width: "100%",
                height: virtualizer.getTotalSize(),
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const group: MessageRoundGroup | undefined = groupedMessages[virtualRow.index];
                if (!group) return null;
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                      // Replaces the removed flex `gap-2` between groups so the
                      // measured height still includes the inter-group spacing.
                      paddingBottom: 8,
                    }}
                  >
                    <div className="flex min-w-0 flex-col gap-2">
                      {group.user ? renderMessageRow(group.user.msg) : null}
                      {group.assistant ? renderMessageRow(group.assistant.msg) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {!effectiveModel.ok && (
        <div style={{ paddingLeft: PAGE_PAD, paddingRight: PAGE_PAD }}>
          {effectiveModel.scope === "conversation" ? (
            <div className="mb-2 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm shadow-minimal">
              <p className="font-medium text-orange-800">
                {getChatLabel("chat.model.unavailableTitle")}
              </p>
              <p className="text-orange-700">{effectiveModel.reason}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {getChatLabel("chat.model.fixHint")}
              </p>
            </div>
          ) : (
            <div className="mb-2 flex items-center gap-3 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm shadow-minimal">
              <p className="flex-1 text-orange-700">{effectiveModel.reason}</p>
              <p className="text-xs text-muted-foreground">
                Set a default model in Settings (gear) → Channels
              </p>
            </div>
          )}
        </div>
      )}

      <div
        style={{
          paddingLeft: PAGE_PAD,
          paddingRight: PAGE_PAD,
          paddingBottom: COMPOSER_PAD_BOTTOM,
        }}
      >
        <DesktopSidecarRuntimePanel
          pendingApproval={sidecarRun.pendingApproval}
          isBusy={sidecarRun.isBusy && !sidecarRun.pendingApproval && !isStreaming}
          onApprove={(toolUseId) => void sidecarRun.respondToApproval(toolUseId, true)}
          onReject={(toolUseId) => void sidecarRun.respondToApproval(toolUseId, false)}
          onCancel={() => void sidecarRun.cancel()}
        />
        <DesktopComposer
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          slashHighlight={slashHighlight}
          slashOpen={slashOpen}
          slashItems={slashItems}
          slashIndex={slashIndex}
          slashEmptyLabel={getSlashLabel("slash.empty")}
          onSlashSelect={handleSlashSelect}
          onSlashHover={setSlashIndex}
          onSlashClose={() => setSlashOpen(false)}
          placeholder={placeholder}
          attachments={pendingAttachments}
          disabled={isUploading}
          onAddAttachments={handleAddAttachments}
          onRemoveAttachment={handleRemoveAttachment}
          mode={composerMode}
          onModeChange={(nextMode) => {
            if (nextMode === "agent" && !agentModeSupported) {
              notifyWarning(
                getChatLabel("chat.agentUnavailableTitle"),
                agentModeDisabledReason || getChatLabel("chat.agentUnavailableReason"),
              );
              return;
            }
            setComposerMode(nextMode);
          }}
          agentModeAvailable={agentModeSupported}
          agentModeDisabledReason={agentModeDisabledReason}
          onSubmit={() => void handleSend()}
          modelProvider={effectiveModel.ok ? effectiveModel.provider : null}
          modelLabel={
            effectiveModel.ok
              ? effectiveModel.modelDisplayName
              : effectiveModel.scope === "conversation"
                ? "Fix model"
                : "Select model"
          }
          modelTone={effectiveModel.ok ? "normal" : "warning"}
          onOpenModelPicker={() => setModelPickerOpen(true)}
          fullAccessEnabled={fullAccessEnabled}
          onToggleFullAccess={toggleFullAccess}
          forceWebSearch={forceWebSearch}
          onToggleWebSearch={() => void handleToggleWebSearch()}
          onInputFocus={handleInputFocus}
          streaming={isStreaming}
          canSubmit={canSend}
          onStop={() => void handleStop()}
          inputRef={inputRef}
        />
      </div>

      {modelPickerOpen && (
        <DesktopModelPickerModal
          opened={modelPickerOpen}
          onClose={() => {
            setModelPickerOpen(false);
            setTimeout(() => inputRef.current?.focus(), 100);
          }}
          conversationId={currentConversation.id}
          conversationFixReason={
            !effectiveModel.ok && effectiveModel.scope === "conversation"
              ? effectiveModel.reason
              : null
          }
          current={
            currentConversation.channelId && currentConversation.modelId
              ? {
                  channelId: currentConversation.channelId,
                  modelId: currentConversation.modelId,
                }
              : effectiveModel.ok
                ? {
                    channelId: effectiveModel.channelId,
                    modelId: effectiveModel.modelId,
                  }
                : null
          }
        />
      )}
    </div>
  );
}
