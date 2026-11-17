/** OpenAI-compatible embeddings used by the fixed-dimension RAG index. */
export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_TIMEOUT_MS = 15_000;

interface EmbeddingRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function parseVectors(payload: unknown, count: number): number[][] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows) || rows.length !== count) {
    throw new Error("Invalid embedding response: input count mismatch");
  }
  const indexed = rows.some((row) => row?.index !== undefined);
  const vectors: number[][] = new Array(count);
  for (let position = 0; position < rows.length; position++) {
    const row = rows[position];
    const index = indexed ? row?.index : position;
    if (!Number.isInteger(index) || index < 0 || index >= count || vectors[index]) {
      throw new Error("Invalid embedding response: invalid or duplicate index");
    }
    const vector = row?.embedding;
    if (
      !Array.isArray(vector) ||
      vector.length !== EMBEDDING_DIMENSIONS ||
      !vector.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new Error("Invalid embedding response: expected 1536 finite numbers per vector");
    }
    vectors[index] = vector;
  }
  return vectors;
}

export async function generateEmbeddings(
  texts: string[],
  apiKey: string,
  baseUrl?: string,
  options: EmbeddingRequestOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Embedding request timed out", "TimeoutError")),
    options.timeoutMs ?? EMBEDDING_TIMEOUT_MS,
  );
  try {
    controller.signal.throwIfAborted();
    const url = `${(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/embeddings`;
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Do not copy arbitrary upstream bodies (which can contain credentials) to logs.
      void response.body?.cancel().catch(() => {});
      throw new Error(`Embedding API error ${response.status}`);
    }
    const payload: unknown = await response.json();
    controller.signal.throwIfAborted();
    return parseVectors(payload, texts.length);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
