import pdf from "pdf-parse";
import { LIBRARY_LIMITS, libraryOcrFileType, utf8Bytes } from "shared/library";

export type LibraryOcrErrorCode =
  | "library_cloud_required"
  | "library_ocr_format"
  | "library_ocr_timeout"
  | "library_ocr_incomplete"
  | "library_ocr_failed"
  | "library_ocr_key_invalid"
  | "library_ocr_balance"
  | "library_ocr_busy"
  | "library_ocr_unavailable"
  | "library_ocr_password";

export class LibraryParseError extends Error {
  constructor(
    readonly code:
      | LibraryOcrErrorCode
      | "library_invalid_text"
      | "library_pdf_limit"
      | "library_empty_text"
      | "library_text_limit"
      | "library_parse_failed",
  ) {
    super(code);
  }
}
// A bounded worker gate; original uploads are independently bounded by user quotas.
let parsing = 0;
const waiting: Array<() => void> = [];
async function pdfSlot<T>(work: () => Promise<T>): Promise<T> {
  if (parsing >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  else parsing++;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else parsing--;
  }
}
export async function parseLibraryOriginal(bytes: Buffer, fileType: string): Promise<string> {
  if (fileType !== "text/plain" && fileType !== "application/pdf")
    throw new LibraryParseError("library_cloud_required");
  let text: string;
  if (fileType === "application/pdf") {
    text = await pdfSlot(async () => {
      let length = 0;
      let pages = 0;
      let extractionFailure: LibraryParseError | undefined;
      const result = await pdf(bytes, {
        max: LIBRARY_LIMITS.pdfPages + 1,
        pagerender: async (page: {
          getTextContent(options: object): Promise<{ items: Array<{ str?: string }> }>;
        }) => {
          // pdf-parse catches per-page rejections; keep the first error outside its loop.
          if (extractionFailure) return "";
          try {
            if (pages >= LIBRARY_LIMITS.pdfPages) throw new LibraryParseError("library_pdf_limit");
            const content = await page.getTextContent({ normalizeWhitespace: true });
            const value = content.items.map((item) => item.str ?? "").join(" ");
            length += utf8Bytes(value);
            if (length > LIBRARY_LIMITS.textBytes)
              throw new LibraryParseError("library_text_limit");
            pages++;
            return value;
          } catch (error) {
            extractionFailure =
              error instanceof LibraryParseError
                ? error
                : new LibraryParseError("library_parse_failed");
            return "";
          }
        },
      });
      if (result.numpages > LIBRARY_LIMITS.pdfPages)
        throw new LibraryParseError("library_pdf_limit");
      if (extractionFailure) throw extractionFailure;
      if (pages !== result.numpages || pages === 0)
        throw new LibraryParseError("library_parse_failed");
      return result.text;
    });
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new LibraryParseError("library_invalid_text");
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject binary control bytes in imported text
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
      throw new LibraryParseError("library_invalid_text");
  }
  if (!text.trim()) throw new LibraryParseError("library_empty_text");
  if (utf8Bytes(text) > LIBRARY_LIMITS.textBytes) throw new LibraryParseError("library_text_limit");
  return text;
}

/** Cheap signature checks and a local PDF page preflight before any paid request. */
export async function validateLibraryOcrOriginal(
  bytes: Buffer,
  fileType: string,
): Promise<number | undefined> {
  if (!libraryOcrFileType(fileType)) throw new LibraryParseError("library_ocr_format");
  const starts = (hex: string) => bytes.subarray(0, hex.length / 2).toString("hex") === hex;
  let valid = false;
  let pageCount: number | undefined;
  if (fileType === "application/pdf") {
    valid = bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"));
    if (valid) {
      try {
        const result = await pdfSlot<{ numpages: number }>(() =>
          pdf(bytes, { max: 1, pagerender: async () => "" }),
        );
        if (result.numpages > LIBRARY_LIMITS.pdfPages)
          throw new LibraryParseError("library_pdf_limit");
        valid = Number.isSafeInteger(result.numpages) && result.numpages > 0;
        if (valid) pageCount = result.numpages;
      } catch (error) {
        if (error instanceof LibraryParseError) throw error;
        valid = false;
      }
    }
  } else if (fileType === "image/png") valid = starts("89504e470d0a1a0a");
  else if (fileType === "image/jpeg") valid = starts("ffd8ff");
  else if (fileType === "image/webp")
    valid = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  else if (fileType === "image/gif") valid = /GIF8[79]a/.test(bytes.toString("ascii", 0, 6));
  else if (fileType === "image/bmp") valid = starts("424d");
  else if (fileType === "image/tiff") valid = starts("49492a00") || starts("4d4d002a");
  else if (fileType.includes("openxmlformats")) valid = starts("504b0304");
  else valid = starts("d0cf11e0a1b11ae1");
  if (!valid) throw new LibraryParseError("library_ocr_format");
  return pageCount;
}
