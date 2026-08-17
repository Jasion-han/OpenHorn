import { create } from "zustand";
import { type ChatAdapter, createChatAdapter } from "../lib/chatAdapter";
import type {
  ApiAgentRun,
  ApiAgentRunStep,
  ApiCitation,
  Channel,
  ChatMode,
  ChatStreamEvent,
  Conversation,
  Message,
  MessageAttachmentMeta,
  SendMessageInput,
} from "../types/chat";

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function createDraftMessage(input: {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  mode: ChatMode;
  attachments?: string[];
  attachmentsMeta?: MessageAttachmentMeta[];
}): Message {
  return {
    id: input.id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    mode: input.mode,
    attachments: input.attachments,
    attachmentsMeta: input.attachmentsMeta,
    createdAt: new Date(),
  };
}

function createPartialAgentRun(): ApiAgentRun {
  return {
    status: "partial",
    summary: "Thinking",
    steps: [],
  };
}

const STREAM_TAIL_WINDOW = 18;

function getRollingTail(text: string, size = STREAM_TAIL_WINDOW) {
  // Only the trailing `size` code points matter. Over-slice by UTF-16 code
  // units first (×4 covers surrogate pairs even if the leading unit is a
  // dangling half) so this stays O(size) instead of scanning the whole string.
  const chars = Array.from(text.slice(-size * 4));
  return chars.slice(Math.max(0, chars.length - size)).join("");
}

// Shared streaming-delta updater so the in-view and background-cache branches
// stay in sync (same content append + tail + pulse). Deriving the next tail
// from the previously stored `streamTail` (a bounded suffix) instead of the
// full accumulated content keeps `appendMessageDelta` O(delta) per token.
function applyStreamDelta(message: Message, delta: string, updates?: Partial<Message>): Message {
  return {
    ...message,
    ...updates,
    content: `${message.content}${delta}`,
    streamTail: getRollingTail(`${message.streamTail ?? ""}${delta}`),
    streamPulseKey: (message.streamPulseKey ?? 0) + 1,
  };
}

function applyAgentEventToRun(
  run: ApiAgentRun | undefined,
  event: Extract<ChatStreamEvent, { type: "agent_event" }>["event"],
): ApiAgentRun {
  const base = run || createPartialAgentRun();

  if (event.type === "tool_start" || event.type === "tool_result") {
    return {
      ...base,
      summary: "Working",
      steps: [
        ...base.steps,
        {
          type: event.type,
          toolName: event.toolName,
          content: event.content,
          toolInput: event.toolInput,
        },
      ],
    };
  }

  if (event.type === "tool_call_detail") {
    const meta = event.toolInput as Record<string, unknown> | undefined;
    if (!meta) return base;
    const toolCallId = typeof meta.toolCallId === "string" ? meta.toolCallId : undefined;
    const existingIdx = toolCallId
      ? base.steps.findIndex((s) => s.type === "tool_detail" && s.toolCallId === toolCallId)
      : -1;
    const step: ApiAgentRunStep = {
      type: "tool_detail",
      toolCallId,
      toolName: typeof meta.title === "string" ? meta.title : undefined,
      kind: typeof meta.kind === "string" ? meta.kind : undefined,
      status: typeof meta.status === "string" ? meta.status : "pending",
      locations: Array.isArray(meta.locations)
        ? (meta.locations as Array<{ path: string; line?: number }>)
        : undefined,
      diff:
        meta.diff && typeof meta.diff === "object"
          ? (meta.diff as { path: string; oldText: string | null; newText: string })
          : undefined,
      content: typeof meta.content === "string" ? meta.content : undefined,
      toolInput:
        meta.rawInput && typeof meta.rawInput === "object"
          ? (meta.rawInput as Record<string, unknown>)
          : undefined,
    };
    if (existingIdx >= 0) {
      // Merge update into existing step (status/locations/diff may change).
      const updatedSteps = [...base.steps];
      const existing = updatedSteps[existingIdx];
      updatedSteps[existingIdx] = {
        ...existing,
        ...step,
        // Preserve title from the original tool_call if the update omits it.
        toolName: step.toolName || existing.toolName,
      };
      return { ...base, summary: "Working", steps: updatedSteps };
    }
    return { ...base, summary: "Working", steps: [...base.steps, step] };
  }

  if (event.type === "plan") {
    const meta = event.toolInput as Record<string, unknown> | undefined;
    const entries = Array.isArray(meta?.entries)
      ? (meta.entries as Array<{ content: string; priority: string; status: string }>)
      : [];
    return {
      ...base,
      planEntries: entries,
      steps: [...base.steps, { type: "plan", planEntries: entries }],
    };
  }

  if (event.type === "agent_info") {
    const meta = event.toolInput as Record<string, unknown> | undefined;
    if (!meta) return base;
    return {
      ...base,
      agentInfo: {
        name: typeof meta.agentName === "string" ? meta.agentName : "",
        version: typeof meta.agentVersion === "string" ? meta.agentVersion : "",
      },
    };
  }

  if (event.type === "context_usage") {
    const meta = event.toolInput as Record<string, unknown> | undefined;
    if (!meta) return base;
    return {
      ...base,
      contextUsage: {
        used: typeof meta.used === "number" ? meta.used : 0,
        size: typeof meta.size === "number" ? meta.size : 0,
        cost:
          meta.cost && typeof meta.cost === "object"
            ? (meta.cost as { amount: number; currency: string })
            : undefined,
      },
    };
  }

  if (event.type === "text" || event.type === "thinking") {
    const content = event.content ?? "";
    const lastStep = base.steps[base.steps.length - 1];
    if (lastStep && lastStep.type === "text") {
      const updatedSteps = [...base.steps];
      updatedSteps[updatedSteps.length - 1] = {
        ...lastStep,
        content: (lastStep.content ?? "") + content,
      };
      return { ...base, steps: updatedSteps };
    }
    return {
      ...base,
      steps: [...base.steps, { type: "text", content }],
    };
  }

  if (event.type === "error") {
    const message = event.content || "Agent error";
    return {
      ...base,
      status: "failed",
      summary: "Error",
      error: message,
      steps: [...base.steps, { type: "error", content: message }],
    };
  }

  return base;
}

function completeAgentRun(run: ApiAgentRun | undefined): ApiAgentRun | undefined {
  if (!run) return undefined;
  if (run.status === "failed" || run.error) {
    return run;
  }
  const trimmedSteps = run.steps ? [...run.steps] : [];
  while (trimmedSteps.length > 0 && trimmedSteps[trimmedSteps.length - 1].type === "text") {
    trimmedSteps.pop();
  }
  return { ...run, status: "completed", steps: trimmedSteps };
}

export interface ChatState {
  channels: Channel[];
  conversations: Conversation[];
  currentConversation: Conversation | null;
  messages: Message[];
  composerMode: ChatMode;
  selectedChannelId: string | null;
  isLoading: boolean;
  isStreaming: boolean;
  error: string | null;

  loadChannels: () => Promise<void>;
  loadConversations: () => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  createConversation: (
    title: string,
    options?: {
      channelId?: string | null;
      modelId?: string | null;
      defaultMode?: ChatMode;
      forceWebSearch?: boolean;
    },
  ) => Promise<Conversation>;
  /**
   * "新会话" as a UI state, not a database row: deselects the current
   * conversation so the welcome screen takes over. The row is created only when
   * the first message is actually sent, so browsing away from a conversation
   * never leaves an empty one behind.
   */
  startNewConversation: () => void;
  updateConversation: (conversationId: string, updates: Partial<Conversation>) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  autoTitleConversation: (
    conversationId: string,
    prompt: string,
  ) => Promise<{ success: boolean; title?: string }>;
  loadMessages: (conversationId: string) => Promise<void>;
  sendMessage: (
    input: Omit<SendMessageInput, "conversationId"> & {
      attachmentsMeta?: MessageAttachmentMeta[];
      existingMessageIds?: { userMessageId: string; assistantMessageId: string };
    },
  ) => Promise<{ userMessageId: string; assistantMessageId: string; response: Response }>;
  addMessage: (message: Message) => void;
  deleteMessage: (messageId: string) => Promise<void>;
  regenerateMessage: (
    messageId: string,
    data?: { userMessageId?: string; userContent?: string },
  ) => Promise<Response>;
  editUserMessage: (messageId: string, content: string) => Promise<Response>;
  abortStreaming: () => void;
  applyStreamEvent: (messageId: string, event: ChatStreamEvent) => void;
  completeStreamingMessage: (messageId: string) => void;
  failStreamingMessage: (messageId: string, error: string) => void;
  updateMessage: (messageId: string, updates: Partial<Message>) => void;
  appendMessageDelta: (messageId: string, delta: string, updates?: Partial<Message>) => void;
  findMessageAnywhere: (messageId: string) => Message | undefined;
  // Mark/unmark the message ids of an in-flight run. While marked, selectConversation
  // keeps the live/cached copy of these messages instead of the (stale) DB copy —
  // an in-flight edit re-uses persisted ids, so the server row is out of date until
  // the run completes and persists.
  markMessagesActive: (ids: string[]) => void;
  unmarkMessagesActive: (ids: string[]) => void;
  reconcileSidecarMessageIds: (input: {
    conversationId: string;
    assistantDraftId: string;
    userMessageId: string;
    assistantMessageId: string;
  }) => void;
  replaceMessages: (messages: Message[]) => void;
  setComposerMode: (mode: ChatMode) => void;
  setSelectedChannelId: (channelId: string | null) => void;
  setLoading: (loading: boolean) => void;
  setStreaming: (streaming: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  channels: [] as Channel[],
  conversations: [] as Conversation[],
  currentConversation: null as Conversation | null,
  messages: [] as Message[],
  composerMode: "agent" as ChatMode,
  selectedChannelId: null as string | null,
  isLoading: false,
  isStreaming: false,
  error: null as string | null,
};

export function createDesktopChatStore(adapter: ChatAdapter = createChatAdapter()) {
  let selectConversationRequestId = 0;
  // Bounded LRU of per-conversation message lists. Purpose (from 05-20):
  //   A. instant, flicker-free re-open of recently visited conversations;
  //   B. no lost content when switching away from a still-streaming conversation.
  // A plain Map preserves insertion order, so the head is always the least
  // recently used. cacheSet re-inserts at the tail and evicts the head past the
  // cap; cacheGet re-inserts to mark "recently used". A conversation that keeps
  // receiving background deltas is refreshed on every write, so it is naturally
  // never the eviction target while it streams.
  const MAX_CACHED_CONVERSATIONS = 20;
  const messageCache = new Map<string, Message[]>();
  // Message ids currently being written by an active run (assistant + its user).
  const activeRunMessageIds = new Set<string>();

  function cacheSet(conversationId: string, msgs: Message[]) {
    if (messageCache.has(conversationId)) messageCache.delete(conversationId);
    messageCache.set(conversationId, msgs);
    while (messageCache.size > MAX_CACHED_CONVERSATIONS) {
      const oldest = messageCache.keys().next().value;
      if (oldest === undefined) break;
      messageCache.delete(oldest);
    }
  }

  function cacheGet(conversationId: string): Message[] | undefined {
    const msgs = messageCache.get(conversationId);
    if (msgs && messageCache.size > 1) {
      messageCache.delete(conversationId);
      messageCache.set(conversationId, msgs);
    }
    return msgs;
  }

  function updateCachedMessage(messageId: string, updater: (msg: Message) => Message): boolean {
    for (const [conversationId, msgs] of messageCache) {
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        const updated = [...msgs];
        updated[idx] = updater(updated[idx]);
        cacheSet(conversationId, updated);
        return true;
      }
    }
    return false;
  }

  return create<ChatState>((set, get) => ({
    ...INITIAL_STATE,

    async loadChannels() {
      set({ isLoading: true, error: null });
      try {
        const channels = await adapter.listChannels();
        set((state) => ({
          channels,
          selectedChannelId:
            state.selectedChannelId &&
            channels.some((channel) => channel.id === state.selectedChannelId)
              ? state.selectedChannelId
              : (channels.find((channel) => channel.isDefault)?.id ?? channels[0]?.id ?? null),
          isLoading: false,
        }));
      } catch (error) {
        set({ isLoading: false, error: toErrorMessage(error) });
        throw error;
      }
    },

    async loadConversations() {
      set({ isLoading: true, error: null });
      try {
        const conversations = await adapter.listConversations();
        set((state) => {
          const currentConversation = state.currentConversation
            ? conversations.find(
                (conversation) => conversation.id === state.currentConversation?.id,
              ) || null
            : null;

          return {
            conversations,
            currentConversation,
            selectedChannelId: currentConversation?.channelId || state.selectedChannelId,
            composerMode: currentConversation?.lastMode || state.composerMode,
            isLoading: false,
          };
        });
      } catch (error) {
        set({ isLoading: false, error: toErrorMessage(error) });
        throw error;
      }
    },

    async selectConversation(conversationId) {
      const prev = get();
      if (prev.currentConversation?.id && prev.messages.length > 0) {
        cacheSet(prev.currentConversation.id, prev.messages);
      }

      const conversation = get().conversations.find((item) => item.id === conversationId) || null;

      if (!conversation) {
        set({
          currentConversation: null,
          messages: [],
        });
        return;
      }

      const cached = cacheGet(conversationId);

      const requestId = ++selectConversationRequestId;
      set((state) => ({
        currentConversation: conversation,
        messages: cached || [],
        composerMode: conversation.lastMode || state.composerMode,
        selectedChannelId: conversation.channelId || state.selectedChannelId,
        isLoading: !cached,
        error: null,
      }));

      try {
        const dbMessages = await adapter.loadMessages(conversation.id);
        if (requestId !== selectConversationRequestId) return;

        const current = get().messages;
        const dbIds = new Set(dbMessages.map((m) => m.id));
        // An in-flight edit re-uses the persisted ids but hasn't written the new
        // content to the DB yet, so the server copy of those rows is stale. For
        // ids belonging to an active run, prefer the live/cached message (edited
        // prompt + streaming answer) over the DB row.
        const currentById = new Map(current.map((m) => [m.id, m]));
        const dbMerged =
          activeRunMessageIds.size > 0
            ? dbMessages.map((m) =>
                activeRunMessageIds.has(m.id) ? (currentById.get(m.id) ?? m) : m,
              )
            : dbMessages;
        // Optimistic drafts use client ids (draft-*). Once a run is persisted,
        // the server assigns new ids, so an id-only check would keep the stale
        // draft alongside the persisted copy and render the whole exchange
        // twice. Drop any draft whose (role, content) already exists in the DB;
        // only genuinely in-flight drafts (not yet persisted) survive.
        const dbSignatures = new Set(
          dbMessages.map((m) => `${m.role}\u0000${(m.content || "").trim()}`),
        );
        const drafts = current.filter(
          (m) =>
            !dbIds.has(m.id) && !dbSignatures.has(`${m.role}\u0000${(m.content || "").trim()}`),
        );
        const merged = drafts.length > 0 ? [...dbMerged, ...drafts] : dbMerged;

        set({
          messages: merged,
          isLoading: false,
        });
        cacheSet(conversationId, merged);
      } catch (error) {
        if (requestId !== selectConversationRequestId) return;
        set({ isLoading: false, error: toErrorMessage(error) });
        throw error;
      }
    },

    async createConversation(title, options) {
      const state = get();
      const cur = state.currentConversation;
      // Anything on screen counts as content — including optimistic drafts and a
      // run that failed before persisting. Those are invisible to the server's
      // blank-conversation check, so the current conversation is excluded from
      // reuse whenever it holds any of them; otherwise "新会话" would silently
      // wipe what the user is looking at instead of opening a new one.
      const curHasContent = cur ? state.messages.some((m) => m.conversationId === cur.id) : false;
      if (cur && !curHasContent) {
        // 当前已是空会话，复用它而不是再建一个空会话
        return cur;
      }

      const conversation = await adapter.createConversation({
        title,
        channelId: options?.channelId,
        modelId: options?.modelId,
        defaultMode: options?.defaultMode,
        forceWebSearch: options?.forceWebSearch,
        excludeConversationId: curHasContent ? cur?.id : undefined,
      });

      // Park the outgoing conversation's messages in the cache before switching
      // away. Unpersisted content (an optimistic send, a run that failed before
      // it was written) only lives in `messages`, so without this it would be
      // gone for good the moment the new conversation takes over.
      const outgoing = get().currentConversation;
      if (outgoing && outgoing.id !== conversation.id) {
        const outgoingMessages = get().messages.filter((m) => m.conversationId === outgoing.id);
        if (outgoingMessages.length > 0) cacheSet(outgoing.id, outgoingMessages);
      }

      set((state) => {
        // The server reuses an existing blank conversation instead of piling up
        // duplicates (空会话不重复创建), so the returned row may already be in the
        // list — replace it in place rather than prepending a second copy.
        const known = state.conversations.some((item) => item.id === conversation.id);
        // Clearing messages is only right when moving to a *different*
        // conversation. Landing back on the current one means these messages
        // still belong to it.
        const isSameConversation = state.currentConversation?.id === conversation.id;
        return {
          conversations: known
            ? state.conversations.map((item) => (item.id === conversation.id ? conversation : item))
            : [conversation, ...state.conversations],
          currentConversation: conversation,
          messages: isSameConversation ? state.messages : [],
          composerMode: conversation.lastMode,
          selectedChannelId: conversation.channelId || state.selectedChannelId,
        };
      });

      return conversation;
    },

    startNewConversation() {
      const outgoing = get().currentConversation;
      if (!outgoing) return;
      // Same hazard as createConversation: unpersisted content lives only in
      // `messages`, so park it before the welcome screen takes over.
      const outgoingMessages = get().messages.filter((m) => m.conversationId === outgoing.id);
      if (outgoingMessages.length > 0) cacheSet(outgoing.id, outgoingMessages);
      set({ currentConversation: null, messages: [], error: null });
    },

    async updateConversation(conversationId, updates) {
      const state = get();
      const previous =
        state.conversations.find((conversation) => conversation.id === conversationId) || null;

      set((nextState) => ({
        conversations: nextState.conversations.map((conversation) =>
          conversation.id === conversationId ? { ...conversation, ...updates } : conversation,
        ),
        currentConversation:
          nextState.currentConversation?.id === conversationId
            ? { ...nextState.currentConversation, ...updates }
            : nextState.currentConversation,
        selectedChannelId:
          nextState.currentConversation?.id === conversationId && updates.channelId !== undefined
            ? updates.channelId || null
            : nextState.selectedChannelId,
      }));

      try {
        await adapter.updateConversation(conversationId, {
          title: updates.title,
          channelId: updates.channelId,
          modelId: updates.modelId,
          systemPrompt: updates.systemPrompt,
          contextLength: updates.contextLength,
          isPinned: updates.isPinned,
          forceWebSearch: updates.forceWebSearch,
        });
      } catch (error) {
        if (previous) {
          set((nextState) => ({
            conversations: nextState.conversations.map((conversation) =>
              conversation.id === conversationId ? previous : conversation,
            ),
            currentConversation:
              nextState.currentConversation?.id === conversationId
                ? previous
                : nextState.currentConversation,
            selectedChannelId:
              nextState.currentConversation?.id === conversationId
                ? previous.channelId || null
                : nextState.selectedChannelId,
            error: toErrorMessage(error),
          }));
        } else {
          set({ error: toErrorMessage(error) });
        }
        throw error;
      }
    },

    async deleteConversation(conversationId) {
      await adapter.deleteConversation(conversationId);
      set((state) => ({
        conversations: state.conversations.filter(
          (conversation) => conversation.id !== conversationId,
        ),
        currentConversation:
          state.currentConversation?.id === conversationId ? null : state.currentConversation,
        messages: state.currentConversation?.id === conversationId ? [] : state.messages,
      }));
    },

    async autoTitleConversation(conversationId, prompt) {
      const result = await adapter.autoTitleConversation(conversationId, prompt);
      if (!result.success || !result.title) {
        return result;
      }

      // Captured before the callback: the guard above narrows `result.title` to a
      // string, but that narrowing does not survive into a closure, which is why
      // both uses previously needed a non-null assertion.
      const nextTitle = result.title;
      const nextUpdatedAt = new Date();
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, title: nextTitle, updatedAt: nextUpdatedAt }
            : conversation,
        ),
        currentConversation:
          state.currentConversation?.id === conversationId
            ? { ...state.currentConversation, title: nextTitle, updatedAt: nextUpdatedAt }
            : state.currentConversation,
      }));

      return result;
    },

    async loadMessages(conversationId) {
      set({ isLoading: true, error: null });
      try {
        const messages = await adapter.loadMessages(conversationId);
        // The user may have switched conversations while this awaited. Only
        // apply the result (and clear the loading flag) if it's still current,
        // otherwise we'd clobber the newly selected conversation's state/cache.
        if (get().currentConversation?.id !== conversationId) return;
        set({ messages, isLoading: false });
      } catch (error) {
        set({ isLoading: false, error: toErrorMessage(error) });
        throw error;
      }
    },

    async sendMessage(input) {
      const state = get();
      if (!state.currentConversation) {
        throw new Error("No conversation selected");
      }

      const mode = input.mode || state.composerMode;
      const userMessageId =
        input.existingMessageIds?.userMessageId || `draft-user-${crypto.randomUUID()}`;
      const assistantMessageId =
        input.existingMessageIds?.assistantMessageId || `draft-assistant-${crypto.randomUUID()}`;
      const nextMessages = input.existingMessageIds
        ? state.messages
        : [
            ...state.messages,
            createDraftMessage({
              id: userMessageId,
              conversationId: state.currentConversation.id,
              role: "user",
              content: input.content,
              mode,
              attachments: input.attachments,
              attachmentsMeta: input.attachmentsMeta,
            }),
            createDraftMessage({
              id: assistantMessageId,
              conversationId: state.currentConversation.id,
              role: "assistant",
              content: "",
              mode,
            }),
          ];

      set({
        messages: nextMessages,
        isStreaming: true,
        error: null,
      });

      try {
        const response = await adapter.sendMessage({
          conversationId: state.currentConversation.id,
          content: input.content,
          attachments: input.attachments,
          mode,
        });

        return { userMessageId, assistantMessageId, response };
      } catch (error) {
        if (input.existingMessageIds) {
          set({
            isStreaming: false,
            error: toErrorMessage(error),
          });
        } else {
          set({
            messages: state.messages,
            isStreaming: false,
            error: toErrorMessage(error),
          });
        }
        throw error;
      }
    },

    addMessage(message) {
      set((state) => ({
        messages: [...state.messages, message],
      }));
    },

    async deleteMessage(messageId) {
      await adapter.deleteMessage(messageId);
      set((state) => ({
        messages: state.messages.filter((message) => message.id !== messageId),
      }));
    },

    async regenerateMessage(messageId, data) {
      return adapter.regenerateMessage(messageId, data);
    },

    async editUserMessage(messageId, content) {
      return adapter.editUserMessage(messageId, content);
    },

    abortStreaming() {
      adapter.abortActiveStream();
      set({ isStreaming: false });
    },

    applyStreamEvent(messageId, event) {
      if (event.type === "delta") {
        get().appendMessageDelta(messageId, event.content || "");
        return;
      }

      if (event.type === "live_status") {
        get().updateMessage(messageId, {
          liveStatus: event.status,
          liveRoute: event.route,
          liveLabel: event.label,
        });
        return;
      }

      if (event.type === "citations") {
        get().updateMessage(messageId, {
          citations: event.citations as ApiCitation[],
        });
        return;
      }

      if (event.type === "agent_event") {
        const found = get().messages.some((m) => m.id === messageId);
        if (found) {
          set((state) => ({
            messages: state.messages.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    agentRun: applyAgentEventToRun(message.agentRun, event.event),
                  }
                : message,
            ),
          }));
        } else {
          updateCachedMessage(messageId, (msg) => ({
            ...msg,
            agentRun: applyAgentEventToRun(msg.agentRun, event.event),
          }));
        }
        return;
      }

      if (event.type === "done") {
        // Look the message up anywhere (current view OR the background cache): if
        // the user navigated to another conversation while this run was streaming,
        // the message — and its accumulated agentRun steps — live only in the
        // cache. Using get().messages.find() here would miss it, so existingRun
        // would be undefined and the whole tool-call process panel gets wiped.
        const currentMsg = get().findMessageAnywhere(messageId);
        const existingRun = currentMsg?.agentRun;
        const doneRun = event.agentRun ?? completeAgentRun(existingRun);
        get().updateMessage(messageId, {
          id: event.messageId || messageId,
          model: event.model,
          agentRun: doneRun,
          // The bubble reveals its timestamp only once the answer is finished, so
          // stamp it here instead of waiting for the next reload to carry the
          // server's value. Regenerating replaces it with the new time.
          updatedAt: new Date(),
        });
        get().completeStreamingMessage(event.messageId || messageId);
        return;
      }

      if (event.type === "error") {
        get().failStreamingMessage(messageId, event.message || "Stream error");
      }
    },

    completeStreamingMessage(_messageId) {
      set({ isStreaming: false });
    },

    failStreamingMessage(messageId, error) {
      const found = get().messages.some((m) => m.id === messageId);
      if (found) {
        set((state) => ({
          isStreaming: false,
          error,
          messages: state.messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  content: message.content || error,
                  agentRun: message.agentRun
                    ? {
                        ...message.agentRun,
                        status: "failed",
                        summary: "Error",
                        error,
                      }
                    : message.agentRun,
                }
              : message,
          ),
        }));
      } else {
        set({ isStreaming: false, error });
        updateCachedMessage(messageId, (msg) => ({
          ...msg,
          content: msg.content || error,
          agentRun: msg.agentRun
            ? { ...msg.agentRun, status: "failed", summary: "Error", error }
            : msg.agentRun,
        }));
      }
    },

    updateMessage(messageId, updates) {
      const found = get().messages.some((m) => m.id === messageId);
      if (found) {
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === messageId ? { ...message, ...updates } : message,
          ),
        }));
      } else {
        updateCachedMessage(messageId, (msg) => ({ ...msg, ...updates }));
      }
    },

    appendMessageDelta(messageId, delta, updates) {
      const found = get().messages.some((m) => m.id === messageId);
      if (found) {
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === messageId ? applyStreamDelta(message, delta, updates) : message,
          ),
        }));
      } else {
        updateCachedMessage(messageId, (msg) => applyStreamDelta(msg, delta, updates));
      }
    },

    findMessageAnywhere(messageId) {
      const inStore = get().messages.find((m) => m.id === messageId);
      if (inStore) return inStore;
      for (const msgs of messageCache.values()) {
        const found = msgs.find((m) => m.id === messageId);
        if (found) return found;
      }
      return undefined;
    },

    markMessagesActive(ids) {
      for (const id of ids) {
        if (id) activeRunMessageIds.add(id);
      }
    },

    unmarkMessagesActive(ids) {
      for (const id of ids) {
        activeRunMessageIds.delete(id);
      }
    },

    reconcileSidecarMessageIds({
      conversationId,
      assistantDraftId,
      userMessageId,
      assistantMessageId,
    }) {
      // After a sidecar run is persisted, the optimistic draft ids (draft-*)
      // must be swapped for the server-assigned ids. Otherwise a later
      // selectConversation() sees the draft ids as "not in the DB" and renders
      // the exchange twice. Remap the assistant message and its prompt (the
      // nearest preceding user message) in both the live state and the cache.
      const remap = (msgs: Message[]): Message[] | null => {
        const assistantIdx = msgs.findIndex((m) => m.id === assistantDraftId);
        if (assistantIdx === -1) return null;
        const next = [...msgs];
        next[assistantIdx] = { ...next[assistantIdx], id: assistantMessageId };
        for (let i = assistantIdx - 1; i >= 0; i--) {
          if (next[i].role === "user") {
            if (next[i].id !== userMessageId) {
              next[i] = { ...next[i], id: userMessageId };
            }
            break;
          }
        }
        return next;
      };

      const remappedLive = remap(get().messages);
      if (remappedLive) {
        set({ messages: remappedLive });
        cacheSet(conversationId, remappedLive);
        return;
      }

      const cached = messageCache.get(conversationId);
      if (cached) {
        const remappedCache = remap(cached);
        if (remappedCache) cacheSet(conversationId, remappedCache);
      }
    },

    replaceMessages(messages) {
      set({ messages });
    },

    setComposerMode(mode) {
      set({ composerMode: mode });
    },

    setSelectedChannelId(channelId) {
      set({ selectedChannelId: channelId });
    },

    setLoading(loading) {
      set({ isLoading: loading });
    },

    setStreaming(streaming) {
      set({ isStreaming: streaming });
    },

    setError(error) {
      set({ error });
    },

    reset() {
      messageCache.clear();
      set({ ...INITIAL_STATE });
    },
  }));
}

export const useChatStore = createDesktopChatStore();
