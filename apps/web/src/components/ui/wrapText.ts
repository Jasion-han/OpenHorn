import type { CSSProperties } from "react";

// Ensure long tokens/URLs/JSON never stretch the layout horizontally.
export const WRAP_TEXT: CSSProperties = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  maxWidth: "100%",
};
