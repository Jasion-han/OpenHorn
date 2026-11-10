/**
 * Text chunking service — splits documents into overlapping chunks suitable
 * for embedding and vector search.
 *
 * Two strategies:
 * 1. Markdown files: split by headings (h1-h3), with over-long sections
 *    falling back to paragraph splitting.
 * 2. Default: split by double-newline paragraphs with a sliding overlap.
 */

export interface TextChunk {
  index: number;
  text: string;
  heading?: string;
}

const MAX_CHUNK_CHARS = 2800; // ~800 tokens
const OVERLAP_CHARS = 200;

export function chunkText(text: string, fileName?: string): TextChunk[] {
  if (!text || text.trim().length === 0) return [];

  // Markdown: split by headings
  if (fileName?.endsWith(".md") || text.match(/^#{1,3}\s/m)) {
    return chunkByHeadings(text);
  }

  // Default: split by paragraphs with overlap
  return chunkByParagraphs(text);
}

function chunkByHeadings(text: string): TextChunk[] {
  const sections = text.split(/(?=^#{1,3}\s)/m);
  const chunks: TextChunk[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
    const heading = headingMatch?.[2] || undefined;

    if (trimmed.length <= MAX_CHUNK_CHARS) {
      chunks.push({ index: chunks.length, text: trimmed, heading });
    } else {
      // Section too long — sub-chunk by paragraphs
      const subChunks = chunkByParagraphs(trimmed);
      for (const sub of subChunks) {
        chunks.push({
          index: chunks.length,
          text: sub.text,
          heading: heading || sub.heading,
        });
      }
    }
  }

  return chunks;
}

function chunkByParagraphs(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      // Prefer a paragraph boundary in the latter half; otherwise use a line or
      // word boundary. A hard cut still bounds single-line/minified documents.
      const minimum = MAX_CHUNK_CHARS / 2;
      const paragraph = window.lastIndexOf("\n\n");
      const line = window.lastIndexOf("\n");
      if (paragraph >= minimum) end = start + paragraph + 2;
      else if (line >= minimum) end = start + line + 1;
      else {
        const space = window.lastIndexOf(" ");
        if (space >= minimum) end = start + space + 1;
      }
      // JS counts UTF-16 code units; never cut an astral character in half.
      if (isLowSurrogate(text.charCodeAt(end))) end--;
    }
    const value = text.slice(start, end).trim();
    if (value) chunks.push({ index: chunks.length, text: value });
    if (end === text.length) break;
    const next = end - OVERLAP_CHARS;
    start = isLowSurrogate(text.charCodeAt(next)) ? next - 1 : next;
  }
  return chunks;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
