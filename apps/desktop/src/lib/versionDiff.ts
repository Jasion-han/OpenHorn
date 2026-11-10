export interface DiffLine {
  key: string;
  kind: "same" | "added" | "removed";
  text: string;
}
export type VersionDiff =
  | { same: true }
  | { same: false; mode: "lines"; lines: DiffLine[] }
  | { same: false; mode: "separate"; before: string; after: string; truncated: boolean };
const MAX_CHARS = 100_000;
/** Bounded LCS for ordinary edits; large changes remain inspectable as plain text. */
export function compareVersions(before: string, after: string): VersionDiff {
  if (before === after) return { same: true };
  if (before.length > MAX_CHARS || after.length > MAX_CHARS)
    return {
      same: false,
      mode: "separate",
      before: before.slice(0, MAX_CHARS),
      after: after.slice(0, MAX_CHARS),
      truncated: true,
    };
  const oldLines = before.split("\n"),
    newLines = after.split("\n");
  if (
    before.length > MAX_CHARS ||
    after.length > MAX_CHARS ||
    oldLines.length > 2000 ||
    newLines.length > 2000 ||
    (oldLines.length + 1) * (newLines.length + 1) > 250_000
  ) {
    return {
      same: false,
      mode: "separate",
      before: before.slice(0, MAX_CHARS),
      after: after.slice(0, MAX_CHARS),
      truncated: before.length > MAX_CHARS || after.length > MAX_CHARS,
    };
  }
  const width = newLines.length + 1,
    lcs = new Uint16Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i--)
    for (let j = newLines.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        oldLines[i] === newLines[j]
          ? 1 + lcs[(i + 1) * width + j + 1]
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  const lines: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      lines.push({ key: `same:${i}:${j}`, kind: "same", text: oldLines[i++] });
      j++;
    } else if (
      i < oldLines.length &&
      (j === newLines.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])
    )
      lines.push({ key: `old:${i}`, kind: "removed", text: oldLines[i++] });
    else lines.push({ key: `new:${j}`, kind: "added", text: newLines[j++] });
  }
  return { same: false, mode: "lines", lines };
}
