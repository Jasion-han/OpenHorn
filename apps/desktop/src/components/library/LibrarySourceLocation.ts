import type { LibrarySource, LibrarySourceLocation } from "shared/types";
import { formatLibraryLabel as format } from "../../lib/i18n/agent";

export function formatLibraryLocation(location?: LibrarySourceLocation) {
  if (location?.pageStart !== undefined && location.pageEnd !== undefined) {
    return location.pageStart === location.pageEnd
      ? format("library.page", { number: location.pageStart })
      : format("library.pageRange", { start: location.pageStart, end: location.pageEnd });
  }
  if (location?.lineStart !== undefined && location.lineEnd !== undefined) {
    return location.lineStart === location.lineEnd
      ? format("library.line", { number: location.lineStart })
      : format("library.lineRange", { start: location.lineStart, end: location.lineEnd });
  }
  return "";
}

export function exactLibrarySourceRange(text: string, source: LibrarySource) {
  const start = source.location?.startOffset;
  const end = source.location?.endOffset;
  if (
    start === undefined ||
    end === undefined ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length ||
    text.slice(start, end) !== source.text
  )
    return null;
  return { start, end };
}
