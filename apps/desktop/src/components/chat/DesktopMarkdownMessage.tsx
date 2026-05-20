import { useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { normalizeExternalUrl } from "../../lib/normalizeExternalUrl";
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

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button type="button" onClick={handleCopy} className={styles.copyButton} title="复制代码">
      {copied ? "已复制" : "复制"}
    </button>
  );
}

export function DesktopMarkdownMessage({ content }: { content: string }) {
  const normalized = fixCjkBold((content || "").replace(/\r\n/g, "\n").trim());

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
      const faviconUrl = domain
        ? `https://www.google.com/s2/favicons?sz=16&domain=${domain}`
        : "";
      const handleClick = (e: React.MouseEvent) => {
        e.preventDefault();
        if (normalizedHref && normalizedHref !== "#") {
          import("@tauri-apps/plugin-shell")
            .then((mod) => mod.open(normalizedHref))
            .catch(() => window.open(normalizedHref, "_blank"));
        }
      };
      return (
        <a
          href={normalizedHref}
          onClick={handleClick}
          className={styles.richLink}
          {...props}
        >
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
      const match = /language-(\w+)/.exec(className || "");
      const codeString = String(children).replace(/\n$/, "");
      const isBlock = codeString.includes("\n") || Boolean(match);
      if (isBlock) {
        return (
          <div className={styles.codeBlock}>
            <div className={styles.codeHeader}>
              <span className={styles.codeLang}>{match ? match[1] : ""}</span>
              <CopyButton code={codeString} />
            </div>
            <pre className={styles.codeScroll}>
              <code className={className} {...props}>
                {codeString}
              </code>
            </pre>
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
