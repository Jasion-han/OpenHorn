/**
 * Vector store — thin wrapper around LanceDB for document chunk storage and
 * retrieval. Uses a local on-disk database under `data/vectors/`.
 */

import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { EMBEDDING_DIMENSIONS } from "./embeddingService";

function sanitizeForWhere(value: string): string {
  return value.replace(/'/g, "''");
}

export interface DocumentChunk {
  id: string;
  userId: string;
  conversationId: string;
  attachmentId: string;
  chunkIndex: number;
  text: string;
  vector: number[];
  fileName: string;
  createdAt: number;
}

const TABLE_NAME = "document_chunks";
// Separate store objects for one directory must not observe a half-created
// table while its initializer is still deleting the schema sentinel.
const tableInitializations = new Map<string, Promise<lancedb.Table>>();

/** Isolated instances also let tests use temporary directories without changing the app profile. */
export function createVectorStore(directory: string) {
  let connection: Promise<lancedb.Connection> | null = null;
  let initialization: Promise<lancedb.Table> | null = null;

  function getDb(): Promise<lancedb.Connection> {
    if (!connection) {
      const pending = lancedb.connect(directory).catch((error) => {
        if (connection === pending) connection = null;
        throw error;
      });
      connection = pending;
    }
    return connection;
  }

  function ensureTable(): Promise<lancedb.Table> {
    if (!initialization) {
      const key = path.resolve(directory);
      const shared = tableInitializations.get(key);
      const pending = (
        shared ??
        (async () => {
          const db = await getDb();
          if ((await db.tableNames()).includes(TABLE_NAME)) return db.openTable(TABLE_NAME);
          const dummy: DocumentChunk = {
            id: "__init__",
            userId: "",
            conversationId: "",
            attachmentId: "",
            chunkIndex: 0,
            text: "",
            vector: new Array(EMBEDDING_DIMENSIONS).fill(0),
            fileName: "",
            createdAt: 0,
          };
          let table: lancedb.Table;
          try {
            table = await db.createTable(TABLE_NAME, [dummy] as unknown as Record<
              string,
              unknown
            >[]);
          } catch (error) {
            // Another instance may have won creation. Open its table, never overwrite it.
            try {
              return await db.openTable(TABLE_NAME);
            } catch {
              throw error;
            }
          }
          await table.delete("id = '__init__'");
          return table;
        })()
      ).catch((error) => {
        if (initialization === pending) initialization = null;
        throw error;
      });
      initialization = pending;
      if (!shared) {
        tableInitializations.set(key, pending);
        const release = () => {
          if (tableInitializations.get(key) === pending) tableInitializations.delete(key);
        };
        void pending.then(release, release);
      }
    }
    return initialization;
  }

  async function addChunks(chunks: DocumentChunk[]): Promise<void> {
    if (!chunks.length) return;
    const table = await ensureTable();
    await table.add(chunks as unknown as Record<string, unknown>[]);
  }

  async function searchChunks(
    queryVector: number[],
    userId: string,
    limit = 5,
  ): Promise<DocumentChunk[]> {
    const db = await getDb();
    try {
      const table = await db.openTable(TABLE_NAME);
      const results = await table
        .search(queryVector)
        .where(`userId = '${sanitizeForWhere(userId)}'`)
        .limit(limit)
        .toArray();
      return results as unknown as DocumentChunk[];
    } catch {
      return [];
    }
  }

  async function hasChunksForUser(userId: string): Promise<boolean> {
    const db = await getDb();
    try {
      const table = await db.openTable(TABLE_NAME);
      return (await table.countRows(`userId = '${sanitizeForWhere(userId)}'`)) > 0;
    } catch {
      return false;
    }
  }

  async function deleteChunksByAttachment(attachmentId: string): Promise<void> {
    const db = await getDb();
    try {
      const table = await db.openTable(TABLE_NAME);
      await table.delete(`attachmentId = '${sanitizeForWhere(attachmentId)}'`);
    } catch {
      /* Table might not exist yet. */
    }
  }

  async function deleteChunksByConversation(conversationId: string): Promise<void> {
    const db = await getDb();
    try {
      const table = await db.openTable(TABLE_NAME);
      await table.delete(`conversationId = '${sanitizeForWhere(conversationId)}'`);
    } catch {
      /* Table might not exist yet. */
    }
  }

  return {
    addChunks,
    searchChunks,
    hasChunksForUser,
    deleteChunksByAttachment,
    deleteChunksByConversation,
  };
}

const store = createVectorStore(path.join(process.cwd(), "data", "vectors"));
export const {
  addChunks,
  searchChunks,
  hasChunksForUser,
  deleteChunksByAttachment,
  deleteChunksByConversation,
} = store;
