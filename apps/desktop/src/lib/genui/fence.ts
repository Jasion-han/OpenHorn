import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";

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

/**
 * Tokenize with the same CommonMark + GFM grammar as ReactMarkdown. Container
 * prefixes, HTML blocks, footnotes and fence lengths must have one meaning in
 * both rendering and streaming detection. A fenced token contains its opening
 * `codeFencedFence` and, only when explicitly closed, a second fence token.
 */
export function endsInsideOpenFence(content: string): boolean {
  const events = postprocess(
    parse({ extensions: [gfm()] })
      .document()
      .write(preprocess()(content, undefined, true)),
  );
  let fences = 0;
  for (const [event, token] of events) {
    if (event === "enter" && token.type === "codeFenced") fences = 0;
    else if (event === "enter" && token.type === "codeFencedFence") fences += 1;
    else if (
      event === "exit" &&
      token.type === "codeFenced" &&
      token.end.offset >= content.trimEnd().length &&
      fences === 1
    ) {
      return true;
    }
  }
  return false;
}
