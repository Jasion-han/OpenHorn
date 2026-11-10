import pdf from "pdf-parse";
import { LIBRARY_LIMITS, utf8Bytes } from "shared/library";

export class LibraryParseError extends Error {
  constructor(
    readonly code:
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
  let text: string;
  if (fileType === "application/pdf") {
    text = await pdfSlot(async () => {
      let length = 0;
      let pages = 0;
      const result = await pdf(bytes, {
        max: LIBRARY_LIMITS.pdfPages + 1,
        pagerender: async (page: {
          getTextContent(options: object): Promise<{ items: Array<{ str?: string }> }>;
        }) => {
          if (++pages > LIBRARY_LIMITS.pdfPages) throw new LibraryParseError("library_pdf_limit");
          const content = await page.getTextContent({ normalizeWhitespace: true });
          const value = content.items.map((item) => item.str ?? "").join(" ");
          length += utf8Bytes(value);
          if (length > LIBRARY_LIMITS.textBytes) throw new LibraryParseError("library_text_limit");
          return value;
        },
      });
      if (result.numpages > LIBRARY_LIMITS.pdfPages)
        throw new LibraryParseError("library_pdf_limit");
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
