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
  const paragraphs = text.split(/\n\n+/);
  const chunks: TextChunk[] = [];
  let buffer = "";

  for (const para of paragraphs) {
    if (buffer.length + para.length + 2 > MAX_CHUNK_CHARS && buffer.length > 0) {
      chunks.push({ index: chunks.length, text: buffer.trim() });
      // Overlap: keep tail of previous chunk
      buffer = `${buffer.slice(-OVERLAP_CHARS)}\n\n${para}`;
    } else {
      buffer += (buffer ? "\n\n" : "") + para;
    }
  }

  if (buffer.trim()) {
    chunks.push({ index: chunks.length, text: buffer.trim() });
  }

  return chunks;
}
