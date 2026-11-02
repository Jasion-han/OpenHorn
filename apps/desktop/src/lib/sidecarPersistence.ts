import type { StoreApi } from "zustand";
import { type ChatState, useChatStore } from "../stores/chatStore";
import { getChatLabel } from "./i18n/agent";
import { hideNotification, notifyError } from "./notify";
import { createServerApi } from "./serverApi";

type Payload = Parameters<ReturnType<typeof createServerApi>["messages"]["syncSidecar"]>[0];
type Result = { userMessageId: string; assistantMessageId: string };

/** Session memory only: generation and retrying a failed save are separate operations. */
export function createSidecarPersistence(options: {
  store: Pick<StoreApi<ChatState>, "getState" | "subscribe">;
  sync: (payload: Payload) => Promise<Result>;
  failed: (id: string, retry: () => Promise<void>) => void;
  saved: (id: string) => void;
}) {
  const sessionId = crypto.randomUUID();
  let sequence = 0;
  type Entry = {
    token: symbol;
    payload: Payload;
    userId: string;
    assistantId: string;
    ownsRun: () => boolean;
    inFlight: Promise<void> | null;
    deferred: boolean;
  };
  const entries = new Map<string, Entry>();
  const current = (entry: Entry) =>
    entries.get(entry.assistantId) === entry &&
    options.store.getState().isSidecarTurnRetained(entry.assistantId, entry.token);
  const unsubscribe = options.store.subscribe(() => {
    for (const [id, entry] of entries) {
      if (!current(entry)) {
        entries.delete(id);
        options.saved(id);
      } else if (entry.deferred && !options.store.getState().isMessageActive(id)) {
        queueMicrotask(() => {
          void attempt(entry);
        });
      }
    }
  });
  const attempt = (entry: Entry): Promise<void> => {
    if (!current(entry)) return Promise.resolve();
    if (!entry.ownsRun() && options.store.getState().isMessageActive(entry.assistantId)) {
      entry.deferred = true;
      return Promise.resolve();
    }
    if (entry.inFlight) return entry.inFlight;
    entry.deferred = false;
    entry.inFlight = (async () => {
      options.store
        .getState()
        .setSidecarSavePending([entry.userId, entry.assistantId], entry.token, true);
      try {
        const result = await options.sync(entry.payload);
        if (!current(entry)) return;
        // A late ACK cannot release protection for a newer, still-running edit.
        if (!entry.ownsRun() && options.store.getState().isMessageActive(entry.assistantId)) {
          entry.deferred = true;
          return;
        }
        if (
          result.userMessageId !== entry.userId ||
          result.assistantMessageId !== entry.assistantId
        ) {
          throw new Error("Unexpected saved message identities");
        }
        options.store.getState().releaseSidecarTurn(entry.assistantId, entry.token);
        entries.delete(entry.assistantId);
        options.saved(entry.assistantId);
      } catch {
        if (
          current(entry) &&
          (entry.ownsRun() || !options.store.getState().isMessageActive(entry.assistantId))
        ) {
          options.failed(entry.assistantId, () => attempt(entry));
        } else if (current(entry)) {
          entry.deferred = true;
        }
      } finally {
        entry.inFlight = null;
        options.store
          .getState()
          .setSidecarSavePending([entry.userId, entry.assistantId], entry.token, false);
      }
    })();
    return entry.inFlight;
  };
  return {
    save(assistantDraftId: string, payload: Payload, ownsRun: () => boolean) {
      const token = Symbol("unsaved-sidecar-turn");
      const pair = options.store.getState().retainSidecarTurn(assistantDraftId, token);
      // A deleted/reset turn must never be recreated by a late terminal callback.
      if (!pair) return null;
      const userId = payload.userMessageId ?? crypto.randomUUID();
      const assistantId = payload.assistantMessageId ?? crypto.randomUUID();
      const entry: Entry = {
        token,
        userId,
        assistantId,
        ownsRun,
        inFlight: null,
        deferred: false,
        payload: {
          ...structuredClone(payload),
          userMessageId: userId,
          ...(payload.userMessageId && !payload.assistantMessageId
            ? { newAssistantMessageId: assistantId }
            : { assistantMessageId: assistantId }),
          syncRevision: { sessionId, sequence: ++sequence },
        },
      };
      options.store.getState().reconcileSidecarMessageIds({
        conversationId: payload.conversationId,
        assistantDraftId,
        userMessageId: userId,
        assistantMessageId: assistantId,
      });
      entries.set(assistantId, entry);
      return { assistantMessageId: assistantId, userMessageId: userId, completion: attempt(entry) };
    },
    dispose() {
      unsubscribe();
      entries.clear();
    },
  };
}

const api = createServerApi();
export const sidecarPersistence = createSidecarPersistence({
  store: useChatStore,
  sync: (payload) => api.messages.syncSidecar(payload),
  failed: (id, retry) =>
    notifyError(getChatLabel("chat.save.failedTitle"), getChatLabel("chat.save.failedBody"), {
      id: `sidecar-save:${id}`,
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: getChatLabel("chat.save.retry"),
        onClick: () => {
          void retry();
        },
      },
    }),
  saved: (id) => hideNotification(`sidecar-save:${id}`),
});
