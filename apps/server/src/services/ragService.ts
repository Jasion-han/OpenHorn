/**
 * RAG orchestration service — coordinates chunking, embedding, and vector
 * storage to enable retrieval-augmented generation over attached documents.
 */

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
  const chunks = chunkText(textContent, fileName);
  if (chunks.length === 0) return;

  const texts = chunks.map((c) => c.text);

  // Batch embedding calls in groups of 100
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchVectors = await generateEmbeddings(batch, apiKey, baseUrl);
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
): Promise<string> {
  // Skip the (paid) embedding API call when the user has no indexed documents.
  const hasDocuments = await hasChunksForUser(userId);
  if (!hasDocuments) return "";

  const [queryVector] = await generateEmbeddings([query], apiKey, baseUrl);
  if (!queryVector) return "";

  const results = await searchChunks(queryVector, userId, limit);
  if (results.length === 0) return "";

  return results
    .map(
      (r, i) =>
        `[${i + 1}] From "${r.fileName}" (chunk ${r.chunkIndex + 1}): ${r.text.slice(0, 800)}`,
    )
    .join("\n\n");
}

export { deleteChunksByAttachment, deleteChunksByConversation };
