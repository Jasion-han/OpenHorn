import { LIBRARY_LIMITS, utf8Bytes } from "shared/library";
import { LibraryParseError } from "./libraryParser";

const OCR_ENDPOINT = "https://api.deepseek.com/v1/tools/ocr";
// Bound the wire body too: JSON escapes and localization markers can exceed plain text size.
const RESPONSE_BYTES = LIBRARY_LIMITS.textBytes * 8;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

function providerError(payload: unknown, status: number): LibraryParseError {
  const error = object(object(payload)?.error);
  const code = error?.code ?? error?.type;
  if (status === 408 || status === 504 || code === "gateway_timeout_error")
    return new LibraryParseError("library_ocr_timeout");
  if (status === 401 || status === 403) return new LibraryParseError("library_ocr_key_invalid");
  if (status === 402) return new LibraryParseError("library_ocr_balance");
  if (status === 429) return new LibraryParseError("library_ocr_busy");
  if (status === 503) return new LibraryParseError("library_ocr_unavailable");
  // These documented failures have no distinct provider error code.
  if (
    error?.message ===
    "The file is password-protected and cannot be processed. Remove the password and upload it again."
  )
    return new LibraryParseError("library_ocr_password");
  return new LibraryParseError("library_ocr_failed");
}

/** Remove coordinates and marker wrappers only. Keep all text inside ref tags. */
export function cleanLibraryOcrText(text: string): string {
  return text
    .replace(
      /<｜box｜>\s*\[\[\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*\]\]\s*<｜\/box｜>/gu,
      "",
    )
    .replace(/<｜\/?(?:ref|box)｜>/gu, "");
}

export function parseLibraryOcrResult(payload: unknown, expectedPages?: number): string {
  const value = object(payload);
  if (!value || "error" in value) throw providerError(payload, 200);
  const count = value.page_count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1)
    throw new LibraryParseError("library_ocr_incomplete");
  if (count > LIBRARY_LIMITS.pdfPages) throw new LibraryParseError("library_pdf_limit");
  if (expectedPages !== undefined && count !== expectedPages)
    throw new LibraryParseError("library_ocr_incomplete");
  if (
    value.object !== "ocr.result" ||
    value.purpose !== "text_recognition" ||
    !Array.isArray(value.pages) ||
    value.pages.length !== count
  )
    throw new LibraryParseError("library_ocr_incomplete");
  const pages = new Map<number, string>();
  let bytes = 0;
  for (const item of value.pages) {
    const page = object(item);
    if (
      !page ||
      typeof page.index !== "number" ||
      !Number.isSafeInteger(page.index) ||
      page.index < 0 ||
      page.index >= count ||
      pages.has(page.index) ||
      page.finish_reason !== "stop" ||
      typeof page.text !== "string"
    )
      throw new LibraryParseError("library_ocr_incomplete");
    // Count raw page text as well as separators; cleanup cannot bypass the output budget.
    bytes += utf8Bytes(page.text) + (pages.size ? 2 : 0);
    if (bytes > LIBRARY_LIMITS.textBytes) throw new LibraryParseError("library_text_limit");
    pages.set(page.index, cleanLibraryOcrText(page.text));
  }
  const text = Array.from({ length: count }, (_, index) => pages.get(index)).join("\n\n");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: match the local library text contract
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw new LibraryParseError("library_invalid_text");
  if (!text.trim()) throw new LibraryParseError("library_empty_text");
  return text;
}

/** One request, one deadline including response streaming; never automatically retry billing. */
export async function requestLibraryOcr(
  bytes: Buffer,
  fileName: string,
  fileType: string,
  apiKey: string,
  expectedPages?: number,
): Promise<string> {
  const signal = AbortSignal.timeout(LIBRARY_LIMITS.ocrTimeoutMs);
  let reader:
    | Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock">
    | undefined;
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new LibraryParseError("library_ocr_timeout"));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    return await Promise.race([
      aborted,
      (async () => {
        const form = new FormData();
        form.set("purpose", "text_recognition");
        form.set("file", new File([new Uint8Array(bytes)], fileName, { type: fileType }));
        const response = await fetch(OCR_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal,
          redirect: "error",
        });
        if (signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new LibraryParseError("library_ocr_timeout");
        }
        if (!response.body) throw providerError(null, response.status);
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > RESPONSE_BYTES) throw new LibraryParseError("library_text_limit");
          chunks.push(chunk.value);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
          );
        } catch {
          throw providerError(null, response.status);
        }
        if (!response.ok) throw providerError(payload, response.status);
        return parseLibraryOcrResult(payload, expectedPages);
      })(),
    ]);
  } catch (error) {
    if (signal.aborted) throw new LibraryParseError("library_ocr_timeout");
    if (error instanceof LibraryParseError) throw error;
    throw new LibraryParseError("library_ocr_failed");
  } finally {
    signal.removeEventListener("abort", rejectAbort);
    const completedReader = reader;
    void completedReader
      ?.cancel()
      .catch(() => {})
      .finally(() => completedReader.releaseLock());
  }
}
