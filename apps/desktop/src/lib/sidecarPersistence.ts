import type { SidecarSaveResult } from "shared/types";
import type { StoreApi } from "zustand";
import { useAuthStore } from "../stores/authStore";
import { useBackendStatusStore } from "../stores/backendStatusStore";
import { type ChatState, useChatStore } from "../stores/chatStore";
import { getDesktopBackendBase } from "./backendBase";
import { getChatLabel } from "./i18n/agent";
import { hideNotification, notifyError } from "./notify";
import { createServerApi, SidecarSaveConflict } from "./serverApi";
import {
  type OutboxRecord,
  outboxMessage,
  type SaveScope,
  type SidecarOutbox,
  type SidecarSavePayload,
  sameSaveScope,
  sidecarOutbox,
  validOutboxRecord,
} from "./sidecarOutbox";

type Payload = SidecarSavePayload;
type Result = SidecarSaveResult;

/** Generation and saving are separate; only final payloads enter the durable outbox. */
export function createSidecarPersistence(options: {
  store: Pick<StoreApi<ChatState>, "getState" | "subscribe">;
  sync: (payload: Payload) => Promise<Result>;
  failed: (
    id: string,
    retry: () => Promise<void>,
    reason?: "storage" | "sync" | "conflict",
  ) => void;
  saved: (id: string) => void;
  outbox?: SidecarOutbox;
  scope?: () => SaveScope | null;
  recoveryFailed?: () => void;
}) {
  const sessionId = crypto.randomUUID();
  let sequence = 0;
  let disposed = false;
  let recovering: Promise<void> | null = null;
  let lifecycle = 0;
  type Entry = {
    token: symbol;
    payload: Payload;
    userId: string;
    assistantId: string;
    record: OutboxRecord | null;
    recovered: boolean;
    ownsRun: () => boolean;
    inFlight: Promise<boolean> | null;
    deferred: boolean;
  };
  const entries = new Map<string, Entry>();
  options.store.getState().setSidecarSaveInvalidator(async (filter) => {
    lifecycle++;
    const scope = options.scope?.();
    if (scope) await options.outbox?.invalidate(scope, filter);
  });
  const current = (entry: Entry) =>
    !disposed &&
    entries.get(entry.assistantId) === entry &&
    (!options.scope || sameSaveScope(entry.record?.scope ?? null, options.scope())) &&
    options.store.getState().isSidecarTurnRetained(entry.assistantId, entry.token);
  const removeDurable = async (entry: Entry) => {
    if (entry.record) await options.outbox?.remove(entry.record);
  };
  const unsubscribe = options.store.subscribe((state, previous) => {
    if (state.sidecarSaveInvalidation !== previous.sidecarSaveInvalidation) {
      lifecycle++;
      const scope = options.scope?.();
      if (scope && options.outbox && state.sidecarSaveInvalidation) {
        void options.outbox
          .invalidate(scope, state.sidecarSaveInvalidation)
          .catch(() => options.recoveryFailed?.());
      }
    }
    for (const [id, entry] of entries) {
      if (!current(entry)) {
        entries.delete(id);
        options.saved(id);
        void removeDurable(entry).catch(() => options.recoveryFailed?.());
      } else if (entry.deferred && !options.store.getState().isMessageActive(id)) {
        queueMicrotask(() => {
          void attempt(entry);
        });
      }
    }
  });
  const attempt = (entry: Entry): Promise<boolean> => {
    if (!current(entry)) return Promise.resolve(false);
    if (!entry.ownsRun() && options.store.getState().isMessageActive(entry.assistantId)) {
      entry.deferred = true;
      return Promise.resolve(false);
    }
    if (entry.inFlight) return entry.inFlight;
    entry.deferred = false;
    entry.inFlight = (async () => {
      options.store
        .getState()
        .setSidecarSavePending([entry.userId, entry.assistantId], entry.token, true);
      let storageFailed = false;
      try {
        if (options.outbox) {
          try {
            if (!entry.record) throw new Error("No authenticated save scope");
            await options.outbox.put(entry.record);
          } catch {
            // Still try the server. A full/disabled local store must not prevent an online save.
            storageFailed = true;
          }
          if (!current(entry)) return false;
        }
        const result = await options.sync(
          entry.recovered ? { ...entry.payload, recovery: true } : entry.payload,
        );
        if (!current(entry)) return false;
        // A late ACK cannot release protection for a newer, still-running edit.
        if (!entry.ownsRun() && options.store.getState().isMessageActive(entry.assistantId)) {
          entry.deferred = true;
          return false;
        }
        if (
          result.userMessageId !== entry.userId ||
          result.assistantMessageId !== entry.assistantId
        )
          throw new Error("Unexpected saved message identities");
        // A failed cleanup can be replayed idempotently; the server ACK already made the result safe.
        await removeDurable(entry).catch(() => {});
        if (!current(entry)) return false;
        if (result.saveTokens) {
          options.store
            .getState()
            .updateMessage(entry.userId, { saveToken: result.saveTokens.user });
          options.store
            .getState()
            .updateMessage(entry.assistantId, { saveToken: result.saveTokens.assistant });
        }
        entries.delete(entry.assistantId);
        options.store.getState().releaseSidecarTurn(entry.assistantId, entry.token);
        options.saved(entry.assistantId);
        if (result.replayed) {
          await options.store
            .getState()
            .refreshConversationMessages(entry.payload.conversationId)
            .catch(() => options.recoveryFailed?.());
        }
        return true;
      } catch (error) {
        if (
          current(entry) &&
          (entry.ownsRun() || !options.store.getState().isMessageActive(entry.assistantId))
        ) {
          options.failed(
            entry.assistantId,
            async () => {
              await attempt(entry);
            },
            error instanceof SidecarSaveConflict ? "conflict" : storageFailed ? "storage" : "sync",
          );
        } else if (current(entry)) {
          entry.deferred = true;
        }
        return false;
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
      if (!pair || disposed) return null;
      const previousUser = options.store.getState().findMessageAnywhere(pair.userMessageId);
      const previousAssistant = options.store
        .getState()
        .findMessageAnywhere(pair.assistantMessageId);
      const userId = payload.userMessageId ?? crypto.randomUUID();
      const assistantId = payload.assistantMessageId ?? crypto.randomUUID();
      const finalPayload: Payload = {
        ...structuredClone(payload),
        userMessageId: userId,
        ...(payload.userMessageId && !payload.assistantMessageId
          ? { newAssistantMessageId: assistantId }
          : { assistantMessageId: assistantId }),
        syncRevision: { sessionId, sequence: ++sequence },
        expectedUserToken:
          payload.expectedUserToken === undefined
            ? (previousUser?.saveToken ?? null)
            : payload.expectedUserToken,
        expectedAssistantToken:
          payload.expectedAssistantToken === undefined
            ? (previousAssistant?.saveToken ?? null)
            : payload.expectedAssistantToken,
      };
      options.store.getState().reconcileSidecarMessageIds({
        conversationId: payload.conversationId,
        assistantDraftId,
        userMessageId: userId,
        assistantMessageId: assistantId,
      });
      const user = options.store.getState().findMessageAnywhere(userId);
      const assistant = options.store.getState().findMessageAnywhere(assistantId);
      const scope = options.scope?.();
      const entry: Entry = {
        token,
        userId,
        assistantId,
        ownsRun,
        inFlight: null,
        deferred: false,
        recovered: false,
        payload: finalPayload,
        record:
          scope && user && assistant
            ? {
                version: 1,
                scope: { ...scope },
                payload: structuredClone(finalPayload),
                user: outboxMessage(user),
                assistant: outboxMessage(assistant),
                queuedAt: Date.now(),
              }
            : null,
      };
      entries.set(assistantId, entry);
      return { assistantMessageId: assistantId, userMessageId: userId, completion: attempt(entry) };
    },
    recover(): Promise<void> {
      if (recovering) return recovering;
      const scope = options.scope?.();
      if (!scope || !options.outbox || disposed) return Promise.resolve();
      const epoch = lifecycle;
      recovering = (async () => {
        try {
          const records = (await options.outbox?.list(scope)) ?? [];
          if (disposed || epoch !== lifecycle || !sameSaveScope(scope, options.scope?.() ?? null))
            return;
          for (const record of records) {
            if (disposed || epoch !== lifecycle || !sameSaveScope(scope, options.scope?.() ?? null))
              return;
            if (!validOutboxRecord(record) || !sameSaveScope(record.scope, scope))
              throw new Error("Invalid save outbox");
            const assistantId = record.assistant.id;
            if (entries.has(assistantId)) continue;
            const token = Symbol("recovered-sidecar-turn");
            const entry: Entry = {
              token,
              record,
              payload: record.payload,
              userId: record.user.id,
              assistantId,
              ownsRun: () => !options.store.getState().isMessageActive(assistantId),
              inFlight: null,
              deferred: false,
              recovered: true,
            };
            // A currently executing replacement keeps its newer snapshots and will save itself.
            if (!options.store.getState().restoreSidecarTurn(record.user, record.assistant, token))
              continue;
            entries.set(assistantId, entry);
          }
          for (const entry of entries.values()) {
            if (disposed || epoch !== lifecycle) return;
            if (current(entry)) await attempt(entry);
          }
        } catch {
          options.recoveryFailed?.();
        }
      })().finally(() => {
        recovering = null;
      });
      return recovering;
    },
    async forgetScope(scope: SaveScope): Promise<void> {
      lifecycle++;
      for (const [id, entry] of entries) {
        if (!sameSaveScope(entry.record?.scope ?? null, scope)) continue;
        entries.delete(id);
        options.store.getState().releaseSidecarTurn(id, entry.token);
        options.saved(id);
      }
      await options.outbox?.clear(scope);
    },
    async discard(assistantId: string): Promise<void> {
      const entry = entries.get(assistantId);
      if (!entry || entry.inFlight) return;
      await removeDurable(entry);
      if (!current(entry)) return;
      entries.delete(assistantId);
      options.store.getState().releaseSidecarTurn(assistantId, entry.token);
      options.saved(assistantId);
      await options.store.getState().refreshConversationMessages(entry.payload.conversationId);
    },
    dispose() {
      disposed = true;
      lifecycle++;
      unsubscribe();
      options.store.getState().setSidecarSaveInvalidator(null);
      entries.clear();
    },
  };
}

const api = createServerApi();
export function getSidecarSaveScope(): SaveScope | null {
  const userId = useAuthStore.getState().user?.id;
  return userId ? { backend: getDesktopBackendBase().replace(/\/+$/, ""), userId } : null;
}
export const sidecarPersistence = createSidecarPersistence({
  store: useChatStore,
  sync: (payload) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    return api.messages
      .syncSidecar(payload, { signal: controller.signal })
      .catch((error) => {
        if (controller.signal.aborted)
          useBackendStatusStore.getState().markDown("Save request timed out");
        throw error;
      })
      .finally(() => clearTimeout(timer));
  },
  outbox: sidecarOutbox,
  scope: getSidecarSaveScope,
  failed: (id, retry, reason) =>
    notifyError(
      getChatLabel("chat.save.failedTitle"),
      getChatLabel(
        reason === "conflict"
          ? "chat.save.conflictBody"
          : reason === "storage"
            ? "chat.save.localFailedBody"
            : "chat.save.failedBody",
      ),
      {
        id: `sidecar-save:${id}`,
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: getChatLabel(reason === "conflict" ? "chat.save.copyLocal" : "chat.save.retry"),
          onClick: () => {
            if (reason === "conflict") {
              const content = useChatStore.getState().findMessageAnywhere(id)?.content;
              if (content !== undefined)
                void navigator.clipboard.writeText(content).catch(() => {});
            } else void retry();
          },
        },
        ...(reason === "conflict"
          ? {
              cancel: {
                label: getChatLabel("chat.save.discardLocal"),
                onClick: () => {
                  void sidecarPersistence
                    .discard(id)
                    .catch(() =>
                      notifyError(
                        getChatLabel("chat.save.failedTitle"),
                        getChatLabel("chat.save.recoveryFailedBody"),
                      ),
                    );
                },
              },
            }
          : {}),
      },
    ),
  saved: (id) => hideNotification(`sidecar-save:${id}`),
  recoveryFailed: () =>
    notifyError(
      getChatLabel("chat.save.failedTitle"),
      getChatLabel("chat.save.recoveryFailedBody"),
      { id: "sidecar-save-recovery", duration: Number.POSITIVE_INFINITY },
    ),
});

useAuthStore.subscribe((state, previous) => {
  if (!previous.user || previous.user.id === state.user?.id) return;
  const scope = { backend: getDesktopBackendBase().replace(/\/+$/, ""), userId: previous.user.id };
  void sidecarPersistence.forgetScope(scope).catch(() => {
    notifyError(
      getChatLabel("chat.save.failedTitle"),
      getChatLabel("chat.save.recoveryFailedBody"),
    );
  });
  void useChatStore
    .getState()
    .reset({ preserveSaveOutbox: true })
    .catch(() => {});
});
