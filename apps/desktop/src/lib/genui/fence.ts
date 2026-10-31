/**
 * Generative UI rides inside ordinary Markdown fenced code blocks, so the same
 * text stream works for every runtime (server chat, Claude / direct agents,
 * Codex, ACP) without a protocol change:
 *
 * - ```openui-lang (or ```openui): an OpenUI Lang 1.0 program rendered with the
 *   desktop component library.
 * - ```html-ui: an HTML fragment (style + markup + script) run in a sandboxed
 *   iframe, for what the components cannot express.
 */
export type GenUiKind = "openui" | "html";

const OPENUI_LANGS = new Set(["openui", "openui-lang"]);
const HTML_LANGS = new Set(["html-ui"]);

export function genUiKindOf(language: string | undefined): GenUiKind | null {
  const normalized = (language || "").trim().toLowerCase();
  if (OPENUI_LANGS.has(normalized)) return "openui";
  if (HTML_LANGS.has(normalized)) return "html";
  return null;
}

const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Whether `content` ends inside a fenced code block that has not been closed
 * yet — i.e. the last block is still streaming. Follows CommonMark: a closing
 * fence uses the same character, is at least as long and carries no info string.
 */
export function endsInsideOpenFence(content: string): boolean {
  let open: { char: string; length: number } | null = null;
  for (const line of content.split("\n")) {
    const match = FENCE_LINE_RE.exec(line);
    if (!match) continue;
    const fence = match[1] ?? "";
    const rest = (match[2] ?? "").trim();
    if (!open) {
      // Backtick fences may not carry a backtick in their info string.
      if (fence[0] === "`" && rest.includes("`")) continue;
      open = { char: fence[0] ?? "`", length: fence.length };
    } else if (fence[0] === open.char && fence.length >= open.length && rest === "") {
      open = null;
    }
  }
  return open !== null;
}
