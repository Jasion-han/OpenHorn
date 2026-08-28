/**
 * Vector store — thin wrapper around LanceDB for document chunk storage and
 * retrieval. Uses a local on-disk database under `data/vectors/`.
 */

import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { EMBEDDING_DIMENSIONS } from "./embeddingService";

let dbInstance: lancedb.Connection | null = null;

async function getDb(): Promise<lancedb.Connection> {
  if (!dbInstance) {
    const dbPath = path.join(process.cwd(), "data", "vectors");
    dbInstance = await lancedb.connect(dbPath);
  }
  return dbInstance;
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

async function ensureTable(db: lancedb.Connection): Promise<lancedb.Table> {
  const tables = await db.tableNames();
  if (!tables.includes(TABLE_NAME)) {
    // LanceDB needs initial data to infer schema — insert a dummy then delete it.
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
    const table = await db.createTable(TABLE_NAME, [dummy] as unknown as Record<string, unknown>[]);
    await table.delete("id = '__init__'");
    return table;
  }
  return db.openTable(TABLE_NAME);
}

export async function addChunks(chunks: DocumentChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  const db = await getDb();
  const table = await ensureTable(db);
  await table.add(chunks as unknown as Record<string, unknown>[]);
}

export async function searchChunks(
  queryVector: number[],
  userId: string,
  limit = 5,
): Promise<DocumentChunk[]> {
  const db = await getDb();
  try {
    const table = await db.openTable(TABLE_NAME);
    const results = await table
      .search(queryVector)
      .where(`userId = '${userId}'`)
      .limit(limit)
      .toArray();
    return results as unknown as DocumentChunk[];
  } catch {
    // Table may not exist yet (first run, no documents indexed)
    return [];
  }
}

export async function deleteChunksByAttachment(attachmentId: string): Promise<void> {
  const db = await getDb();
  try {
    const table = await db.openTable(TABLE_NAME);
    await table.delete(`attachmentId = '${attachmentId}'`);
  } catch {
    // Table might not exist yet
  }
}

export async function deleteChunksByConversation(conversationId: string): Promise<void> {
  const db = await getDb();
  try {
    const table = await db.openTable(TABLE_NAME);
    await table.delete(`conversationId = '${conversationId}'`);
  } catch {
    // Table might not exist yet
  }
}
