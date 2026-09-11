/**
 * Classifies the `href` of a markdown link inside an assistant reply so the
 * chat can decide whether it is a workspace file reference (open in the
 * preview panel's code view), a web page (open in the embedded browser), an
 * in-document anchor (ignored) or some other scheme (hand to the OS).
 *
 * Pure functions only — no store access — so every href shape the model has
 * actually produced can be pinned by unit tests.
 */

export type ReferenceLink =
  | { kind: "web"; url: string }
  | { kind: "file"; path: string; line?: number; endLine?: number }
  | { kind: "anchor" }
  | { kind: "external"; url: string };

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
// Schemes that legitimately have no `//` and must go to the OS.
const OPAQUE_EXTERNAL_SCHEME_RE = /^(mailto|tel|sms|callto):/i;

// Bare domains the model writes without a scheme ("example.com/docs").
const WEB_TLDS = new Set([
  "com",
  "org",
  "net",
  "io",
  "dev",
  "ai",
  "cn",
  "co",
  "app",
  "edu",
  "gov",
  "me",
  "info",
  "xyz",
]);
const HOST_LABEL_RE = /^[a-z0-9-]+$/i;

// `path:39`, `path:39-69`, `path:39:12` (column ignored), `path:39-69:12`.
const COLON_RANGE_RE = /:(\d+)(?:-(\d+))?(?::\d+)?$/;
// `path#L39`, `path#L39-L69`, `path#L39-69`.
const HASH_RANGE_RE = /#L(\d+)(?:-L?(\d+))?$/i;

interface ParsedFileRef {
  path: string;
  line?: number;
  endLine?: number;
}

function toLine(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Splits `path:12-20` / `path#L12-L20` into a path and an optional range. */
export function parseFileReference(raw: string): ParsedFileRef {
  const value = raw.trim();
  const hash = HASH_RANGE_RE.exec(value);
  if (hash) {
    const line = toLine(hash[1]);
    const endLine = toLine(hash[2]);
    return normalizeRange({ path: value.slice(0, hash.index), line, endLine });
  }
  const colon = COLON_RANGE_RE.exec(value);
  if (colon) {
    const line = toLine(colon[1]);
    const endLine = toLine(colon[2]);
    return normalizeRange({ path: value.slice(0, colon.index), line, endLine });
  }
  return { path: value };
}

function normalizeRange(ref: ParsedFileRef): ParsedFileRef {
  if (ref.line === undefined) return { path: ref.path };
  if (ref.endLine === undefined || ref.endLine < ref.line) {
    return { path: ref.path, line: ref.line };
  }
  return ref;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * True for scheme-less hrefs whose first segment is a bare hostname
 * (`www.example.com`, `example.com/docs`, `docs.foo.io:8080/x`). A trailing
 * segment that is really a file extension (`README.md`, `route.ts`) is not a
 * host because its "TLD" is not in the allow-list.
 */
function looksLikeBareHost(value: string): boolean {
  const firstSegment = value.split(/[/?#]/, 1)[0] ?? "";
  if (!firstSegment) return false;
  if (/^www\./i.test(firstSegment)) return true;
  const host = firstSegment.split(":", 1)[0] ?? "";
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => label.length > 0 && HOST_LABEL_RE.test(label))) return false;
  const tld = (labels[labels.length - 1] ?? "").toLowerCase();
  return WEB_TLDS.has(tld);
}

function stripWorkspaceRoot(path: string, workspaceRoot: string | null | undefined): string {
  if (!workspaceRoot || !path.startsWith("/")) return path;
  const root = workspaceRoot.replace(/\/+$/, "");
  if (!root) return path;
  if (path === root) return "";
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

function normalizeRelativePath(path: string): string {
  let out = path;
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

/**
 * Merges the range found in the link text into the href's own range. The
 * model routinely writes `[route.ts:144-149](path/route.ts:144)` — the href
 * carries only the start line while the text has the full span — so the text
 * wins whenever it names the same file and is at least as specific.
 */
function mergeTextRange(fromHref: ParsedFileRef, linkText: string | undefined): ParsedFileRef {
  if (!linkText) return fromHref;
  const fromText = parseFileReference(linkText);
  if (fromText.line === undefined) return fromHref;
  if (basename(fromText.path) !== basename(fromHref.path)) return fromHref;
  if (fromHref.line === undefined) {
    return normalizeRange({ path: fromHref.path, line: fromText.line, endLine: fromText.endLine });
  }
  if (fromHref.endLine === undefined && fromText.line === fromHref.line) {
    return normalizeRange({ path: fromHref.path, line: fromHref.line, endLine: fromText.endLine });
  }
  return fromHref;
}

export function classifyReferenceHref(
  href: string | null | undefined,
  linkText?: string | null,
  workspaceRoot?: string | null,
): ReferenceLink {
  let value = (href ?? "").trim();
  const text = (linkText ?? "").trim();

  // react-markdown blanks hrefs it considers unsafe (a bare `route.ts:144` is
  // read as an unknown `route.ts:` scheme). The link text is then the only
  // copy of the reference left.
  if (!value && text) value = text;
  if (!value) return { kind: "anchor" };
  if (value.startsWith("#")) return { kind: "anchor" };

  const scheme = SCHEME_RE.exec(value);
  if (scheme) {
    const name = (scheme[1] ?? "").toLowerCase();
    if (name === "http" || name === "https") return { kind: "web", url: value };
    if (name === "file") {
      const withoutScheme = safeDecode(value.slice(scheme[0].length));
      const parsed = mergeTextRange(parseFileReference(withoutScheme), text);
      return toFileLink(parsed, workspaceRoot);
    }
    return { kind: "external", url: value };
  }
  if (OPAQUE_EXTERNAL_SCHEME_RE.test(value)) return { kind: "external", url: value };

  if (looksLikeBareHost(value)) return { kind: "web", url: `https://${value}` };

  const parsed = mergeTextRange(parseFileReference(safeDecode(value)), text);
  return toFileLink(parsed, workspaceRoot);
}

function toFileLink(
  parsed: ParsedFileRef,
  workspaceRoot: string | null | undefined,
): ReferenceLink {
  const path = normalizeRelativePath(stripWorkspaceRoot(parsed.path, workspaceRoot));
  const out: ReferenceLink = { kind: "file", path };
  if (parsed.line !== undefined) out.line = parsed.line;
  if (parsed.endLine !== undefined) out.endLine = parsed.endLine;
  return out;
}

const DEFAULT_SAFE_PROTOCOL_RE = /^(https?|ircs?|mailto|xmpp)$/i;

/**
 * Drop-in for react-markdown's `urlTransform`. The default blanks any href
 * whose first colon precedes a `/` unless the "scheme" is http/mailto/…, which
 * throws away the model's `route.ts:144` references and every `file://` link.
 * Those are kept here; everything else follows the default rules.
 */
export function referenceUrlTransform(value: string): string {
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    DEFAULT_SAFE_PROTOCOL_RE.test(value.slice(0, colon))
  ) {
    return value;
  }
  if (/^file:/i.test(value)) return value;
  if (/^(javascript|vbscript|data):/i.test(value)) return "";
  // `name.ext:12`, `path:12-20`, `path:12:4` — a file reference with a line
  // number, not a scheme. Anchored on both ends so `javascript:1;alert(1)`
  // style payloads cannot ride on a leading digit.
  if (/^[^:\s]+:\d+(?:-\d+)?(?::\d+)?$/.test(value)) return value;
  return "";
}

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
  xml: "xml",
  svg: "xml",
  graphql: "graphql",
  gql: "graphql",
  env: "bash",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
};

const FILENAME_LANGUAGE: Record<string, string> = {
  dockerfile: "docker",
  makefile: "makefile",
  ".env": "bash",
  ".gitignore": "bash",
  ".npmrc": "ini",
};

/** Prism language id for a workspace path; `text` when unknown. */
export function languageForPath(path: string): string {
  const name = basename(path).toLowerCase();
  const byName = FILENAME_LANGUAGE[name];
  if (byName) return byName;
  if (name.startsWith(".env.")) return "bash";
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "text";
  return EXTENSION_LANGUAGE[name.slice(dot + 1)] ?? "text";
}

export function fileBasename(path: string): string {
  return basename(path) || path;
}

/** Extensions that are plain text but have no Prism language of their own. */
const TEXT_EXTENSIONS = new Set([
  "txt",
  "text",
  "log",
  "csv",
  "tsv",
  "lock",
  "license",
  "gitignore",
  "gitattributes",
  "editorconfig",
  "npmrc",
  "nvmrc",
  "prettierrc",
  "eslintrc",
  "babelrc",
  "tool-versions",
  "properties",
  "diff",
  "patch",
  "tf",
  "proto",
  "lua",
  "pl",
  "r",
  "ex",
  "exs",
  "erl",
  "hs",
  "scala",
  "dart",
  "vim",
  "cmake",
  "gradle",
]);

/** Extension-less files that are conventionally text. */
const TEXT_FILENAMES = new Set([
  "license",
  "licence",
  "readme",
  "changelog",
  "contributing",
  "authors",
  "codeowners",
  "notice",
  "todo",
  "procfile",
  "gemfile",
  "rakefile",
  "brewfile",
  "podfile",
  "justfile",
  "vagrantfile",
  "cmakelists.txt",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  ".prettierignore",
  ".eslintrc",
  ".eslintignore",
  ".babelrc",
  ".dockerignore",
  ".tool-versions",
]);

/**
 * True for files that make sense to open in a code editor: anything with a
 * Prism language, plus conventional text formats / config files. Images,
 * PDFs, media, archives, office documents and unknown binaries return false
 * so the caller can hand them to the OS default application instead.
 */
export function isTextLikePath(path: string): boolean {
  if (languageForPath(path) !== "text") return true;
  const name = basename(path).toLowerCase();
  if (TEXT_FILENAMES.has(name)) return true;
  if (name.startsWith(".") && name.indexOf(".", 1) === -1) {
    // Dotfiles like `.zshrc` / `.bashrc`: shell/config text.
    return name.endsWith("rc") || name.endsWith("ignore") || name.endsWith("config");
  }
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot + 1));
}
