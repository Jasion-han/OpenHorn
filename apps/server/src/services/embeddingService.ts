/**
 * Embedding service — calls an OpenAI-compatible `/v1/embeddings` endpoint to
 * produce vector representations of text chunks.
 *
 * The default model is `text-embedding-3-small` (1 536 dimensions).
 */

export const EMBEDDING_DIMENSIONS = 1536;

export async function generateEmbeddings(
  texts: string[],
  apiKey: string,
  baseUrl?: string,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const url = `${(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/embeddings`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Embedding API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return data.data.map((d) => d.embedding);
}
