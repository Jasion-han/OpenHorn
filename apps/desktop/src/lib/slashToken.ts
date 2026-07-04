// Shared slash-command token rules. A `/name` token only counts when the `/`
// sits at a token boundary: start of text or right after whitespace (including
// newlines). This keeps paths (`a/b`) and URLs (`https://…`) from being treated
// as commands. Send-time resolution, the bubble chip, and the input highlight
// all go through these helpers so the three views can never disagree.

export type SlashCommandType = "skill" | "mcp" | "command";

export type KnownSlashToken = {
  /** Index of the `/` in the text. */
  start: number;
  /** Exclusive end index of the token. */
  end: number;
  /** Token name as written (without the `/`), original casing preserved. */
  name: string;
  type: SlashCommandType;
};

/**
 * Find the first token-boundary `/name` whose lowercased name is a known
 * command. Token characters run to the next whitespace.
 */
export function findKnownSlashToken(
  text: string,
  known: Map<string, SlashCommandType>,
): KnownSlashToken | null {
  const re = /\/(\S+)/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const start = match.index;
    const before = start > 0 ? text[start - 1] : undefined;
    if (before !== undefined && !/\s/.test(before)) continue;
    const name = match[1] ?? "";
    const type = known.get(name.toLowerCase());
    if (type) return { start, end: start + match[0].length, name, type };
  }
  return null;
}

/**
 * Find the (possibly partial) `/token` the cursor currently sits in, used to
 * open/filter the slash panel while typing. The token must start at a token
 * boundary, and the query (chars between `/` and the cursor) must not contain
 * whitespace or another `/` — so absolute paths stop triggering at `/usr/…`.
 */
export function findSlashTokenAtCursor(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const bounded = Math.max(0, Math.min(cursor, text.length));
  let start = bounded;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;
  if (text[start] !== "/") return null;
  const query = text.slice(start + 1, bounded);
  if (query.includes("/")) return null;
  return { start, query };
}

/** Remove a matched token (plus the single space the panel inserts) from text. */
export function stripSlashToken(text: string, token: KnownSlashToken): string {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end).replace(/^[ \t]/, "");
  return `${before}${after}`.trim();
}
