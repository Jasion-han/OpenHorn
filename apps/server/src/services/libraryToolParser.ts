import { LIBRARY_LIMITS, utf8Bytes } from "shared/library";
import {
  openRouterMessage,
  requestToolJson,
  type ToolRequestOptions,
  toolObject,
} from "shared/search";
import type { ToolConnection } from "shared/tool-connection";
import { requestLibraryOcr } from "./libraryOcr";
import { LibraryParseError } from "./libraryParser";

/** PDF parser annotations are source text; a model's reply is never indexed as OCR. */
export function parseOpenRouterDocument(payload: unknown, fileName: string): string {
  let message: Record<string, unknown>;
  try {
    message = openRouterMessage(payload);
  } catch {
    throw new LibraryParseError("library_ocr_incomplete");
  }
  const files = (Array.isArray(message.annotations) ? message.annotations : [])
    .map(toolObject)
    .filter((entry) => entry?.type === "file");
  if (files.length !== 1) throw new LibraryParseError("library_ocr_incomplete");
  const file = toolObject(files[0]?.file);
  if (
    !file ||
    typeof file.hash !== "string" ||
    !file.hash ||
    (file.name && file.name !== fileName) ||
    !Array.isArray(file.content)
  )
    throw new LibraryParseError("library_ocr_incomplete");
  const texts: string[] = [];
  let size = 0;
  for (const value of file.content) {
    const part = toolObject(value);
    if (part?.type !== "text" || typeof part.text !== "string")
      throw new LibraryParseError("library_ocr_incomplete");
    size += utf8Bytes(part.text) + (texts.length ? 2 : 0);
    if (size > LIBRARY_LIMITS.textBytes) throw new LibraryParseError("library_text_limit");
    texts.push(part.text);
  }
  const text = texts.join("\n\n");
  if (!text.trim()) throw new LibraryParseError("library_empty_text");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject binary control text
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw new LibraryParseError("library_invalid_text");
  return text;
}

export async function requestLibraryToolParse(
  bytes: Buffer,
  fileName: string,
  fileType: string,
  connection: ToolConnection,
  expectedPages?: number,
  options: Omit<ToolRequestOptions, "connection"> = {},
): Promise<string> {
  if (connection.kind === "deepseek") {
    return requestLibraryOcr(bytes, fileName, fileType, connection.apiKey, expectedPages, {
      ...options,
      baseUrl: connection.baseUrl,
    });
  }
  if (fileType !== "application/pdf") throw new LibraryParseError("library_ocr_format");
  try {
    const result = await requestToolJson(
      "/chat/completions",
      {
        model: connection.model,
        stream: false,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Parse this PDF using the file parser. Reply only OK. Do not summarize, infer or add missing text.",
              },
              {
                type: "file",
                file: {
                  filename: fileName,
                  file_data: `data:application/pdf;base64,${bytes.toString("base64")}`,
                },
              },
            ],
          },
        ],
        plugins: [{ id: "file-parser", pdf: { engine: "mistral-ocr" } }],
      },
      { ...options, connection, timeoutMs: options.timeoutMs ?? LIBRARY_LIMITS.ocrTimeoutMs },
    );
    return parseOpenRouterDocument(result, fileName);
  } catch (error) {
    if (error instanceof LibraryParseError) throw error;
    const message = error instanceof Error ? error.message : "";
    throw new LibraryParseError(
      message === "timeout"
        ? "library_ocr_timeout"
        : /^HTTP (401|403)$/.test(message)
          ? "library_ocr_key_invalid"
          : message === "HTTP 402"
            ? "library_ocr_balance"
            : "library_ocr_failed",
    );
  }
}
