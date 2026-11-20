# Library source provenance

Add page and source-position provenance to indexed Library chunks. PDF chunks carry their page range, while text chunks retain section and character offsets. Frozen question sources include the provenance and old snapshots without it remain valid.

1. Store physical PDF page ranges and exact extracted-text offsets in indexed chunks. Keep line numbers for plain text.
2. Carry locations through search, prepared questions, and restored source snapshots.
3. Open PDF previews at the matching page and highlight text matches in the extracted document. The browser fixture verifies both and opens a PDF preview from the source history.
