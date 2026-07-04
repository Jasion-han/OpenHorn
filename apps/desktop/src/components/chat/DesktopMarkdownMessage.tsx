import { Check, Copy } from "lucide-react";
import { Fragment, memo, startTransition, useEffect, useMemo, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { normalizeExternalUrl } from "../../lib/normalizeExternalUrl";
import { THEME_MODE_CHANGE_EVENT } from "../../lib/theme";
import styles from "./desktop-markdown.module.css";

// Micromark fails to recognise **…** as bold when a CJK character sits
// directly before the opening ** (CommonMark left-flanking delimiter rule).
// Inserting a hair space (U+200A) before the opening ** fixes this without
// a visible layout change.
const CJK_BOLD_PAIR_RE =
  /(?<=[⺀-鿿豈-﫿\u{20000}-\u{2FA1F}\u{3000}-\u{303F}\u{2018}-\u{201F}！-｠])\*\*([^*\n]+?)\*\*/gu;

function fixCjkBold(text: string): string {
  return text.replace(CJK_BOLD_PAIR_RE, " **$1**");
}

const LANGUAGE_META: Record<string, { label: string; syntax: string; accent: string }> = {
  bash: { label: "Bash", syntax: "bash", accent: "#16a34a" },
  css: { label: "CSS", syntax: "css", accent: "#2563eb" },
  html: { label: "HTML", syntax: "html", accent: "#ea580c" },
  javascript: { label: "JavaScript", syntax: "javascript", accent: "#ca8a04" },
  js: { label: "JavaScript", syntax: "javascript", accent: "#ca8a04" },
  json: { label: "JSON", syntax: "json", accent: "#7c3aed" },
  jsx: { label: "React JSX", syntax: "jsx", accent: "#0891b2" },
  markdown: { label: "Markdown", syntax: "markdown", accent: "#475569" },
  md: { label: "Markdown", syntax: "markdown", accent: "#475569" },
  python: { label: "Python", syntax: "python", accent: "#2563eb" },
  py: { label: "Python", syntax: "python", accent: "#2563eb" },
  sh: { label: "Shell", syntax: "bash", accent: "#16a34a" },
  shell: { label: "Shell", syntax: "bash", accent: "#16a34a" },
  ts: { label: "TypeScript", syntax: "typescript", accent: "#2563eb" },
  tsx: { label: "React TSX", syntax: "tsx", accent: "#0891b2" },
  typescript: { label: "TypeScript", syntax: "typescript", accent: "#2563eb" },
  yaml: { label: "YAML", syntax: "yaml", accent: "#db2777" },
  yml: { label: "YAML", syntax: "yaml", accent: "#db2777" },
};

export function getLanguageMeta(language: string | undefined) {
  const normalized = (language || "text").trim().toLowerCase();
  return (
    LANGUAGE_META[normalized] || {
      label: normalized === "text" ? "Plain text" : normalized,
      syntax: normalized,
      accent: "#64748b",
    }
  );
}

// Shared so the plain-text placeholder and the highlighted version keep an
// identical mono font — any drift here would shift text when highlight lands.
const CODE_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

// The gutter width (minWidth + paddingRight) must match the highlighted line
// numbers exactly so switching from placeholder to highlight causes no
// horizontal jump. `display`/`textAlign` mirror react-syntax-highlighter's own
// default line-number styles.
const LINE_NUMBER_STYLE: React.CSSProperties = {
  minWidth: "1.65rem",
  paddingRight: "0.55rem",
  color: "hsl(var(--muted-foreground) / 0.48)",
  fontVariantNumeric: "tabular-nums",
  userSelect: "none",
};

const PLACEHOLDER_LINE_NUMBER_STYLE: React.CSSProperties = {
  display: "inline-block",
  textAlign: "right",
  ...LINE_NUMBER_STYLE,
};

const CODE_CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: 0,
  background: "transparent",
  // Pin the line-height so the placeholder and the highlighted output stay
  // vertically identical. SyntaxHighlighter puts the prism theme's inline
  // `line-height: 1.5` on its scroll container (inline style beats the
  // `.codeScroll` class), so the plain-text placeholder must match it or the
  // block shrinks the moment highlight lands.
  lineHeight: 1.5,
};

// Small blocks highlight synchronously on the first frame: their Prism
// tokenize cost is negligible, so deferring them only produces a visible
// plain-text -> colored flash. Only large blocks keep the "placeholder then
// idle highlight" path that keeps conversation switching smooth. Line count is
// the primary gate; the char cap guards against a single absurdly long line
// (few lines but expensive to tokenize).
const EAGER_HIGHLIGHT_MAX_LINES = 12;
const EAGER_HIGHLIGHT_MAX_CHARS = 2000;

export function shouldHighlightEagerly(codeString: string, lineCount: number): boolean {
  return lineCount <= EAGER_HIGHLIGHT_MAX_LINES && codeString.length <= EAGER_HIGHLIGHT_MAX_CHARS;
}

type IdleWindow = typeof window & {
  requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

// The idle callback is bounded by a timeout so a busy main thread (e.g.
// mounting a whole message list on conversation switch) cannot starve the
// highlight for ~1s. 200ms keeps the large-block plain-text window short
// enough to be barely perceptible while still yielding the first paint.
const IDLE_HIGHLIGHT_TIMEOUT_MS = 200;

// Defer the highlight work until the browser is idle so switching into a
// conversation with many long code blocks paints the plain text immediately.
function scheduleIdle(run: () => void): () => void {
  const w = window as IdleWindow;
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(run, { timeout: IDLE_HIGHLIGHT_TIMEOUT_MS });
    return () => {
      if (typeof w.cancelIdleCallback === "function") {
        w.cancelIdleCallback(id);
      }
    };
  }
  // Fall back to the same bounded delay rather than 0 so we do not contend
  // with the synchronous first paint while still capping the wait.
  const id = window.setTimeout(run, IDLE_HIGHLIGHT_TIMEOUT_MS);
  return () => window.clearTimeout(id);
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button type="button" onClick={handleCopy} className={styles.copyButton} title="Copy code">
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

type CodeBlockProps = {
  codeString: string;
  className?: string;
  language: string;
  accent: string;
  label: string;
  lineCount: number;
  isDark: boolean;
  syntaxTheme: Record<string, React.CSSProperties>;
  codeProps: React.ComponentPropsWithoutRef<"code">;
};

function CodeBlockImpl({
  codeString,
  className,
  language,
  accent,
  label,
  lineCount,
  syntaxTheme,
  codeProps,
}: CodeBlockProps) {
  const showLineNumbers = lineCount > 1;
  // Small blocks highlight on the first frame (no flash); large blocks render
  // the lightweight plain-text placeholder first and schedule the heavy Prism
  // tokenize for the next idle slice via startTransition. The props that decide
  // this (codeString/lineCount) are stable for a given block, so the lazy
  // initializer runs once and switching isDark never resets a highlighted block.
  const [highlighted, setHighlighted] = useState(() =>
    shouldHighlightEagerly(codeString, lineCount),
  );

  useEffect(() => {
    // Eager blocks are already highlighted from the first frame — nothing to
    // schedule, so skip the idle work entirely.
    if (highlighted) return;
    return scheduleIdle(() => {
      startTransition(() => setHighlighted(true));
    });
  }, [highlighted]);

  return (
    <div className={styles.codeBlock} style={{ "--code-accent": accent } as React.CSSProperties}>
      <div className={styles.codeHeader}>
        <div className={styles.codeTitle}>
          <span className={styles.codeLang}>{label}</span>
          <span className={styles.codeMeta}>
            {lineCount} {lineCount === 1 ? "line" : "lines"}
          </span>
        </div>
        <CopyButton code={codeString} />
      </div>
      {highlighted ? (
        <SyntaxHighlighter
          className={styles.codeScroll}
          style={syntaxTheme}
          language={language}
          PreTag="div"
          showLineNumbers={showLineNumbers}
          wrapLongLines={false}
          customStyle={CODE_CUSTOM_STYLE}
          lineNumberStyle={LINE_NUMBER_STYLE}
          codeTagProps={{
            className,
            style: { fontFamily: CODE_FONT_FAMILY },
            ...codeProps,
          }}
        >
          {codeString}
        </SyntaxHighlighter>
      ) : (
        <div className={styles.codeScroll} style={CODE_CUSTOM_STYLE}>
          <code className={className} style={{ fontFamily: CODE_FONT_FAMILY }} {...codeProps}>
            {showLineNumbers
              ? codeString.split("\n").map((line, index, lines) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: line order is stable
                  <Fragment key={index}>
                    <span>
                      <span
                        className="comment linenumber react-syntax-highlighter-line-number"
                        style={PLACEHOLDER_LINE_NUMBER_STYLE}
                      >
                        {index + 1}
                      </span>
                      {line}
                    </span>
                    {index < lines.length - 1 ? "\n" : null}
                  </Fragment>
                ))
              : codeString}
          </code>
        </div>
      )}
    </div>
  );
}

const CodeBlock = memo(
  CodeBlockImpl,
  (prev, next) =>
    prev.codeString === next.codeString &&
    prev.className === next.className &&
    prev.language === next.language &&
    prev.isDark === next.isDark,
);

function DesktopMarkdownMessageImpl({ content }: { content: string }) {
  const normalized = fixCjkBold((content || "").replace(/\r\n/g, "\n").trim());
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const compute = () => {
      setIsDark(document.documentElement.classList.contains("dark"));
    };
    compute();
    window.addEventListener(THEME_MODE_CHANGE_EVENT, compute);
    return () => {
      window.removeEventListener(THEME_MODE_CHANGE_EVENT, compute);
    };
  }, []);

  const syntaxTheme = useMemo(
    () => (isDark ? oneDark : oneLight) as unknown as Record<string, React.CSSProperties>,
    [isDark],
  );

  type CodeProps = React.ComponentPropsWithoutRef<"code"> & { inline?: boolean; node?: unknown };
  type PreProps = React.ComponentPropsWithoutRef<"pre"> & { node?: unknown };
  type LinkProps = React.ComponentPropsWithoutRef<"a"> & { node?: unknown };

  const components: Components = {
    a({ href, children, ...props }: LinkProps) {
      const normalizedHref = normalizeExternalUrl(href);
      let domain = "";
      try {
        domain = new URL(normalizedHref).hostname;
      } catch {}
      const faviconUrl = domain ? `https://www.google.com/s2/favicons?sz=16&domain=${domain}` : "";
      const handleClick = (e: React.MouseEvent) => {
        e.preventDefault();
        // Stop here so App.tsx's global click interceptor does not also fire
        // and open the same URL a second time.
        e.stopPropagation();
        if (normalizedHref && normalizedHref !== "#") {
          import("@tauri-apps/plugin-shell")
            .then((mod) => mod.open(normalizedHref))
            .catch(() => window.open(normalizedHref, "_blank"));
        }
      };
      return (
        <a href={normalizedHref} onClick={handleClick} className={styles.richLink} {...props}>
          {faviconUrl ? (
            <img
              src={faviconUrl}
              alt=""
              width={16}
              height={16}
              className={styles.linkFavicon}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <span className={styles.linkFaviconFallback}>🌐</span>
          )}
          {children}
        </a>
      );
    },
    code({ className, children, ...props }: CodeProps) {
      const match = /language-([\w-]+)/.exec(className || "");
      const lang = match?.[1];
      const langMeta = getLanguageMeta(lang);
      const codeString = String(children).replace(/\n$/, "");
      const isBlock = codeString.includes("\n") || Boolean(match);
      if (isBlock) {
        const lineCount = codeString.split("\n").length;
        return (
          <CodeBlock
            codeString={codeString}
            className={className}
            language={langMeta.syntax}
            accent={langMeta.accent}
            label={langMeta.label}
            lineCount={lineCount}
            isDark={isDark}
            syntaxTheme={syntaxTheme}
            codeProps={props}
          />
        );
      }

      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    pre({ children }: PreProps) {
      return <>{children}</>;
    },
  };

  return (
    <div className={styles.root}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {normalized}
      </ReactMarkdown>
    </div>
  );
}

export const DesktopMarkdownMessage = memo(
  DesktopMarkdownMessageImpl,
  (prev, next) => prev.content === next.content,
);
