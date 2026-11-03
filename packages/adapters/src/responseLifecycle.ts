// Bun and DOM expose different concrete reader classes. The adapter owns only
// the standard byte-reader operations, not Bun-only extensions such as readMany.
type ResponseChunk = { done: true; value?: Uint8Array } | { done: false; value: Uint8Array };
type ResponseReader = {
  read(): Promise<ResponseChunk>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
};

const ERROR_BODY_MAX_BYTES = 64 * 1024;
const ERROR_BODY_TIMEOUT_MS = 5_000;

/** Reader ownership ends with its consumer, including generator return/error. */
export function disposeResponseReader(reader: ResponseReader): void {
  try {
    // A broken source may never settle cancel. Cleanup must not mask or delay
    // the original terminal result; cancellation still starts synchronously.
    void reader.cancel().catch(() => {});
  } catch {}
  try {
    reader.releaseLock();
  } catch {}
}

export async function readResponseChunk(
  reader: ResponseReader,
  signal: AbortSignal,
): Promise<ResponseChunk> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function readResponseText(
  response: Response,
  signal: AbortSignal,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const next = await readResponseChunk(reader, signal);
      if (next.done) break;
      const take = Math.min(next.value.length, maxBytes - bytes);
      text += decoder.decode(next.value.subarray(0, take), { stream: true });
      bytes += take;
    }
    return text + decoder.decode();
  } finally {
    disposeResponseReader(reader);
  }
}

/** Diagnostics have their own bound; successful JSON uses only its request deadline. */
export async function readErrorResponseText(response: Response, signal?: AbortSignal) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error("Provider error response body timed out");
    error.name = "TimeoutError";
    controller.abort(error);
  }, ERROR_BODY_TIMEOUT_MS);
  try {
    return await readResponseText(response, controller.signal, ERROR_BODY_MAX_BYTES);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

const SSE_PREFIXES = ["data:", "event:", "id:", "retry:", ":"];

/** A TCP chunk can end anywhere, including inside `data:` or a UTF8 BOM. */
export async function sniffOpenAIStream(
  reader: ResponseReader,
  decoder: TextDecoder,
  signal: AbortSignal,
  markChunk: () => void,
): Promise<{ buffer: string; sse: boolean }> {
  // Compatible gateways can mislabel either direction. The body prefix is
  // authoritative only once enough decoded bytes distinguish its wire format.
  let buffer = "";
  while (true) {
    const next = await readResponseChunk(reader, signal);
    if (next.done) return { buffer: buffer + decoder.decode(), sse: false };
    markChunk();
    buffer = (buffer + decoder.decode(next.value, { stream: true })).trimStart();
    // Leading blank chunks are not a decision. Discarding only leading
    // whitespace keeps this undecided prefix bounded under the request timeout.
    if (!buffer) continue;
    if (SSE_PREFIXES.some((prefix) => buffer.startsWith(prefix))) return { buffer, sse: true };
    if (SSE_PREFIXES.some((prefix) => prefix.startsWith(buffer))) continue;
    return { buffer, sse: false };
  }
}
