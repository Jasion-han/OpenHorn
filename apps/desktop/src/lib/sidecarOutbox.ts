import type { Message } from "../types/chat";
import type { ServerApi } from "./serverApi";

export type SidecarSavePayload = Parameters<ServerApi["messages"]["syncSidecar"]>[0];
export interface SaveScope {
  backend: string;
  userId: string;
}
export interface OutboxRecord {
  version: 1;
  scope: SaveScope;
  payload: SidecarSavePayload;
  user: Message;
  assistant: Message;
  queuedAt: number;
}
export interface SidecarOutbox {
  put(record: OutboxRecord): Promise<void>;
  list(scope: SaveScope): Promise<OutboxRecord[]>;
  remove(record: OutboxRecord): Promise<void>;
  clear(scope: SaveScope): Promise<void>;
  invalidate(
    scope: SaveScope,
    filter: { conversationId?: string; messageId?: string },
  ): Promise<void>;
}

export function sameSaveScope(a: SaveScope | null, b: SaveScope | null): boolean {
  return a?.backend === b?.backend && a?.userId === b?.userId;
}

function key(record: OutboxRecord): string {
  return JSON.stringify([record.scope.backend, record.scope.userId, record.assistant.id]);
}

function revision(record: OutboxRecord): string {
  return JSON.stringify(record.payload.syncRevision);
}

/** Persist final messages only: never save object URLs or streaming decorations. */
export function outboxMessage(message: Message): Message {
  const { streamTail: _tail, streamPulseKey: _pulse, renderKey: _render, ...saved } = message;
  return {
    ...structuredClone(saved),
    attachments: saved.attachments?.filter((value) => !/^(blob:|data:)/i.test(value)),
    attachmentsMeta: saved.attachmentsMeta?.map(({ previewUrl: _url, ...meta }) => meta),
  };
}

export function validOutboxRecord(value: unknown): value is OutboxRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as OutboxRecord;
  const payload = record.payload;
  const nonempty = (id: unknown): id is string => typeof id === "string" && id.length > 0;
  const baseline = (token: unknown) =>
    token === undefined ||
    token === null ||
    (typeof token === "string" && /^[a-f0-9]{64}$/.test(token));
  return (
    record.version === 1 &&
    typeof record.scope?.backend === "string" &&
    typeof record.scope.userId === "string" &&
    !!record.scope.backend &&
    !!record.scope.userId &&
    !!payload &&
    nonempty(payload.conversationId) &&
    typeof payload.userContent === "string" &&
    typeof payload.assistantContent === "string" &&
    baseline(payload.expectedUserToken) &&
    baseline(payload.expectedAssistantToken) &&
    typeof payload.syncRevision?.sessionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      payload.syncRevision.sessionId,
    ) &&
    Number.isSafeInteger(payload.syncRevision.sequence) &&
    payload.syncRevision.sequence > 0 &&
    Number.isFinite(record.queuedAt) &&
    record.user?.role === "user" &&
    record.assistant?.role === "assistant" &&
    nonempty(record.user.id) &&
    nonempty(record.assistant.id) &&
    record.user.id !== record.assistant.id &&
    (payload.assistantMessageId === undefined || payload.newAssistantMessageId === undefined) &&
    (record.user.mode === "agent" || record.user.mode === "chat") &&
    (record.assistant.mode === "agent" || record.assistant.mode === "chat") &&
    !!payload.agentRun &&
    typeof payload.agentRun === "object" &&
    !Array.isArray(payload.agentRun) &&
    typeof record.user.content === "string" &&
    typeof record.assistant.content === "string" &&
    record.user.id === payload.userMessageId &&
    record.assistant.id === (payload.assistantMessageId ?? payload.newAssistantMessageId) &&
    record.user.conversationId === payload.conversationId &&
    record.assistant.conversationId === payload.conversationId &&
    record.user.createdAt instanceof Date &&
    Number.isFinite(record.user.createdAt.getTime()) &&
    record.assistant.createdAt instanceof Date &&
    Number.isFinite(record.assistant.createdAt.getTime())
  );
}

type Stored = { key: string; record: OutboxRecord };
const STORE = "pending-saves";
const MAX_RECORDS = 200;
const MAX_BYTES = 50 * 1024 * 1024;

/** IndexedDB keeps private final payloads in the app profile, scoped by backend/user. */
export function createIndexedDbOutbox(databaseName = "openhorn-save-outbox-v1"): SidecarOutbox {
  let connection: Promise<IDBDatabase> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  function database(): Promise<IDBDatabase> {
    if (connection) return connection;
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("Durable save storage is unavailable"));
        return;
      }
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          connection = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Durable save storage is blocked"));
    }).catch((error) => {
      connection = null;
      throw error;
    });
    return connection;
  }
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  }
  async function transaction<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore, done: (value: T) => void) => void,
  ): Promise<T> {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Durable save transaction aborted"));
      try {
        work(tx.objectStore(STORE), (result) => {
          value = result;
        });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }
  return {
    put(record) {
      return serial(async () => {
        if (!validOutboxRecord(record)) throw new Error("Invalid durable save record");
        const recordKey = key(record);
        // No silent eviction: a full outbox must leave the result in memory and report it.
        await transaction<void>("readwrite", (store, done) => {
          const read = store.getAll();
          read.onsuccess = () => {
            const rows = (read.result as Stored[]).filter((row) => row.key !== recordKey);
            const bytes = new TextEncoder().encode(JSON.stringify([...rows, record])).length;
            if (rows.length >= MAX_RECORDS || bytes > MAX_BYTES) {
              store.transaction.abort();
              return;
            }
            store.put({ key: recordKey, record: structuredClone(record) });
            done(undefined);
          };
        });
      });
    },
    list(scope) {
      return serial(() =>
        transaction<OutboxRecord[]>("readonly", (store, done) => {
          const read = store.getAll();
          read.onsuccess = () => {
            const records: OutboxRecord[] = [];
            for (const row of read.result as Stored[]) {
              if (!validOutboxRecord(row.record)) {
                store.transaction.abort();
                return;
              }
              if (!sameSaveScope(row.record.scope, scope)) continue;
              records.push(row.record);
            }
            done(records.sort((a, b) => a.queuedAt - b.queuedAt));
          };
        }),
      );
    },
    remove(record) {
      return serial(() =>
        transaction<void>("readwrite", (store, done) => {
          const recordKey = key(record);
          const read = store.get(recordKey);
          read.onsuccess = () => {
            const saved = read.result as Stored | undefined;
            if (saved && revision(saved.record) === revision(record)) store.delete(recordKey);
            done(undefined);
          };
        }),
      );
    },
    clear(scope) {
      return this.invalidate(scope, {});
    },
    invalidate(scope, filter) {
      return serial(() =>
        transaction<void>("readwrite", (store, done) => {
          const read = store.openCursor();
          read.onsuccess = () => {
            const cursor = read.result;
            if (!cursor) {
              done(undefined);
              return;
            }
            const record = (cursor.value as Stored).record;
            if (
              sameSaveScope(record?.scope ?? null, scope) &&
              (!filter.conversationId ||
                record.payload?.conversationId === filter.conversationId) &&
              (!filter.messageId ||
                record.user?.id === filter.messageId ||
                record.assistant?.id === filter.messageId)
            )
              cursor.delete();
            cursor.continue();
          };
        }),
      );
    },
  };
}

export const sidecarOutbox = createIndexedDbOutbox();
