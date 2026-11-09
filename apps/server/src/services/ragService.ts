import { decisionEnhancements } from "./decisionEnhancements";
/**
 * RAG orchestration service — coordinates chunking, embedding, and vector
 * storage to enable retrieval-augmented generation over attached documents.
 */

import { attachments, conversations } from "db";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { chunkText } from "./chunkingService";
import { generateEmbeddings } from "./embeddingService";
import {
  addChunks,
  type DocumentChunk,
  deleteChunksByAttachment,
  deleteChunksByConversation,
  hasChunksForUser,
  searchChunks,
} from "./vectorStore";

const EMBEDDING_BATCH_SIZE = 100;

/** SQL source rows, not best-effort vectors, own document visibility. */
async function liveSources(userId: string, attachmentIds?: string[]) {
  if (attachmentIds?.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: attachments.id, conversationId: conversations.id })
    .from(attachments)
    .innerJoin(conversations, eq(conversations.id, attachments.conversationId))
    .where(
      and(
        eq(conversations.userId, userId),
        ...(attachmentIds ? [inArray(attachments.id, [...new Set(attachmentIds)])] : []),
      ),
    )
    .limit(attachmentIds ? attachmentIds.length : 1);
  return new Map(rows.map((row) => [row.id, row.conversationId]));
}

/**
 * Index an attachment's text content into the vector store.
 * Chunks the text, generates embeddings in batches, and persists.
 */
export async function indexAttachment(
  attachmentId: string,
  userId: string,
  conversationId: string,
  fileName: string,
  textContent: string,
  apiKey: string,
  baseUrl?: string,
): Promise<void> {
  const exists = async () =>
    (await liveSources(userId, [attachmentId])).get(attachmentId) === conversationId;
  if (!(await exists())) return;
  const chunks = chunkText(textContent, fileName);
  if (chunks.length === 0) return;

  const texts = chunks.map((c) => c.text);

  // Batch embedding calls in groups of 100
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchVectors = await generateEmbeddings(batch, apiKey, baseUrl);
    // Stop subsequent paid batches if deletion won this embedding await.
    if (!(await exists())) return;
    vectors.push(...batchVectors);
  }

  const records: DocumentChunk[] = chunks.map((chunk, i) => ({
    id: `${attachmentId}-${chunk.index}`,
    userId,
    conversationId,
    attachmentId,
    chunkIndex: chunk.index,
    text: chunk.text,
    vector: vectors[i] ?? [],
    fileName,
    createdAt: Date.now(),
  }));

  await addChunks(records);
  // Vector writes cannot share SQL's transaction. Remove a late write when
  // deletion won the write await; retrieval independently checks live sources.
  if (!(await exists())) await deleteChunksByAttachment(attachmentId);
}

/**
 * Retrieve the most relevant chunks for a given query from the vector store.
 * Returns a formatted context string suitable for injection into a system prompt.
 */
export async function retrieveContext(
  query: string,
  userId: string,
  apiKey: string,
  baseUrl?: string,
  limit = 5,
  rerank: (
    userId: string,
    query: string,
    items: DocumentChunk[],
    text: (item: DocumentChunk) => string,
  ) => Promise<DocumentChunk[]> = decisionEnhancements.rerank,
): Promise<string> {
  // Skip the (paid) embedding API call when the user has no indexed documents.
  const hasDocuments = await hasChunksForUser(userId);
  if (!hasDocuments) return "";
  if ((await liveSources(userId)).size === 0) return "";

  const [queryVector] = await generateEmbeddings([query], apiKey, baseUrl);
  if (!queryVector) return "";

  const results = await searchChunks(queryVector, userId, limit);
  if (results.length === 0) return "";
  const live = await liveSources(
    userId,
    results.map((row) => row.attachmentId),
  );

  const owned = results.filter(
    (row) => row.userId === userId && live.get(row.attachmentId) === row.conversationId,
  );
  const ranked = await rerank(userId, query, owned, (row) => row.text.slice(0, 800));
  // Ownership/existence may change while the external judgment is pending.
  const stillLive = await liveSources(
    userId,
    ranked.map((row) => row.attachmentId),
  );
  return ranked
    .filter((row) => stillLive.get(row.attachmentId) === row.conversationId)
    .map(
      (r, i) =>
        `[${i + 1}] From "${r.fileName}" (chunk ${r.chunkIndex + 1}): ${r.text.slice(0, 800)}`,
    )
    .join("\n\n");
}

export { deleteChunksByAttachment, deleteChunksByConversation };
