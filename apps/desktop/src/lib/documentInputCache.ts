import type { AttachmentPart } from "shared/types";
import { DocumentInputError } from "./documentInput";

type Snapshot = {
  key: string;
  scope: string;
  createdAt: number;
  parts: AttachmentPart[];
  bytes: number;
};
const MAX_BYTES = 8 * 1024 * 1024,
  OWNER_BYTES = 50 * 1024 * 1024,
  TTL = 7 * 24 * 60 * 60 * 1000;
const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
async function open() {
  if (typeof indexedDB === "undefined") throw new DocumentInputError("document_cache");
  const task = indexedDB.open("openhorn-document-input", 1);
  task.onupgradeneeded = () => task.result.createObjectStore("snapshots", { keyPath: "key" });
  return request(task);
}
const completed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
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
  try {
    const tx = db.transaction("snapshots", "readwrite"),
      done = completed(tx),
      table = tx.objectStore("snapshots");
    const all = (await request(table.getAll())) as Snapshot[];
    let total = 0;
    for (const row of all)
      if (row.scope === scope) {
        if (Date.now() - row.createdAt >= TTL) table.delete(row.key);
        else total += row.bytes;
      }
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
    throw new DocumentInputError("document_cache");
  } finally {
    db.close();
  }
}
export async function readDocumentInput(scope: string, key: string): Promise<AttachmentPart[]> {
  const db = await open();
  try {
    const tx = db.transaction("snapshots", "readonly"),
      done = completed(tx);
    const value = (await request(tx.objectStore("snapshots").get(key))) as Snapshot | undefined;
    await done;
    if (
      !value ||
      value.scope !== scope ||
      Date.now() - value.createdAt >= TTL ||
      !validDocumentParts(value.parts) ||
      value.bytes > MAX_BYTES ||
      !Number.isFinite(value.createdAt) ||
      value.createdAt > Date.now() ||
      new TextEncoder().encode(JSON.stringify(value.parts)).length !== value.bytes
    )
      throw new DocumentInputError("document_cache");
    return value.parts;
  } finally {
    db.close();
  }
}
