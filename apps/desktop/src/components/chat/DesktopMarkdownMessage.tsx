import { useEffect, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
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
  return text.replace(CJK_BOLD_PAIR_RE, " **$1**");
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

function getLanguageMeta(language: string | undefined) {
  const normalized = (language || "text").trim().toLowerCase();
  return (
    LANGUAGE_META[normalized] || {
      label: normalized === "text" ? "Plain text" : normalized,
      syntax: normalized,
      accent: "#64748b",
    }
  );
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

export function DesktopMarkdownMessage({ content }: { content: string }) {
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
          <div
            className={styles.codeBlock}
            style={{ "--code-accent": langMeta.accent } as React.CSSProperties}
          >
            <div className={styles.codeHeader}>
              <div className={styles.codeTitle}>
                <span className={styles.codeLang}>{langMeta.label}</span>
                <span className={styles.codeMeta}>
                  {lineCount} {lineCount === 1 ? "line" : "lines"}
                </span>
              </div>
              <CopyButton code={codeString} />
            </div>
            <SyntaxHighlighter
              className={styles.codeScroll}
              style={syntaxTheme}
              language={langMeta.syntax}
              PreTag="div"
              showLineNumbers={lineCount > 1}
              wrapLongLines={false}
              customStyle={{
                margin: 0,
                padding: 0,
                background: "transparent",
              }}
              lineNumberStyle={{
                minWidth: "1.65rem",
                paddingRight: "0.55rem",
                color: "hsl(var(--muted-foreground) / 0.48)",
                fontVariantNumeric: "tabular-nums",
                userSelect: "none",
              }}
              codeTagProps={{
                className,
                style: {
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                },
                ...props,
              }}
            >
              {codeString}
            </SyntaxHighlighter>
          </div>
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
