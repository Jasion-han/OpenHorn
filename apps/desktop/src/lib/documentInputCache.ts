import type { AttachmentPart } from "shared/types";
import { DocumentInputError } from "./documentInput";

type Snapshot = {
  key: string;
  scope: string;
  createdAt: number;
  parts: AttachmentPart[];
  bytes: number;
};
// Six 1 MiB images already exceed 8 MiB after Base64 + JSON. Leave room for
// extracted text while retaining the account-wide storage bound.
const MAX_BYTES = 12 * 1024 * 1024,
  OWNER_BYTES = 50 * 1024 * 1024,
  TTL = 7 * 24 * 60 * 60 * 1000;
const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
async function open() {
  try {
    if (typeof indexedDB === "undefined") throw new DocumentInputError("document_cache");
    const task = indexedDB.open("openhorn-document-input", 1);
    task.onupgradeneeded = () => task.result.createObjectStore("snapshots", { keyPath: "key" });
    return await request(task);
  } catch {
    throw new DocumentInputError("document_cache");
  }
}
const completed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

/** Walk one snapshot at a time; never materialize every account's image data. */
function purgeAndCount(table: IDBObjectStore, scope: string, now: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const task = table.openCursor();
    let total = 0;
    task.onerror = () => reject(task.error);
    task.onsuccess = () => {
      const cursor = task.result;
      if (!cursor) {
        resolve(total);
        return;
      }
      const row = cursor.value as Snapshot;
      if (Number.isFinite(row.createdAt) && now - row.createdAt >= TTL) cursor.delete();
      else if (row.scope === scope) {
        if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > MAX_BYTES) {
          reject(new DocumentInputError("document_cache"));
          return;
        }
        total += row.bytes;
      }
      cursor.continue();
    };
  });
}
export function validDocumentParts(parts: unknown): parts is AttachmentPart[] {
  return (
    Array.isArray(parts) &&
    parts.length > 0 &&
    parts.length <= 50 &&
    parts.every(
      (part) =>
        part &&
        typeof part === "object" &&
        typeof part.mediaType === "string" &&
        ((part.kind === "file" &&
          typeof part.fileName === "string" &&
          typeof part.text === "string") ||
          (part.kind === "image" &&
            (part.fileName === undefined || typeof part.fileName === "string") &&
            typeof part.dataBase64 === "string" &&
            part.dataBase64.length > 0 &&
            /^[A-Za-z0-9+/]*={0,2}$/.test(part.dataBase64))),
    )
  );
}
export async function saveDocumentInput(scope: string, parts: AttachmentPart[]): Promise<string> {
  if (!scope || !validDocumentParts(parts)) throw new DocumentInputError("document_cache");
  const bytes = new TextEncoder().encode(JSON.stringify(parts)).length;
  if (bytes > MAX_BYTES) throw new DocumentInputError("document_cache");
  const db = await open();
  let tx: IDBTransaction | undefined;
  try {
    tx = db.transaction("snapshots", "readwrite");
    const done = completed(tx),
      table = tx.objectStore("snapshots");
    // Request failures can reject before the transaction's terminal event.
    void done.catch(() => {});
    const total = await purgeAndCount(table, scope, Date.now());
    if (total + bytes > OWNER_BYTES) {
      tx.abort();
      await done.catch(() => {});
      throw new DocumentInputError("document_cache");
    }
    const key = crypto.randomUUID();
    table.put({ key, scope, parts, bytes, createdAt: Date.now() } satisfies Snapshot);
    await done;
    return key;
  } catch {
    try {
      tx?.abort();
    } catch {
      // A committed/aborted transaction is already closed.
    }
    throw new DocumentInputError("document_cache");
  } finally {
    db.close();
  }
}
export async function readDocumentInput(scope: string, key: string): Promise<AttachmentPart[]> {
  if (!scope || !key) throw new DocumentInputError("document_cache");
  const db = await open();
  try {
    const tx = db.transaction("snapshots", "readwrite"),
      done = completed(tx),
      table = tx.objectStore("snapshots");
    void done.catch(() => {});
    const value = (await request(table.get(key))) as Snapshot | undefined;
    const now = Date.now();
    if (value?.scope === scope && now - value.createdAt >= TTL) table.delete(key);
    await done;
    if (
      !value ||
      value.scope !== scope ||
      now - value.createdAt >= TTL ||
      !validDocumentParts(value.parts) ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      value.bytes > MAX_BYTES ||
      !Number.isFinite(value.createdAt) ||
      value.createdAt > now ||
      new TextEncoder().encode(JSON.stringify(value.parts)).length !== value.bytes
    )
      throw new DocumentInputError("document_cache");
    return value.parts;
  } catch {
    throw new DocumentInputError("document_cache");
  } finally {
    db.close();
  }
}
