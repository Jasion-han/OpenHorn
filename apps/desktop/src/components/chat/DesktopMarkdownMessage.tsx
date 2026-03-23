import { useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { normalizeExternalUrl } from "../../lib/normalizeExternalUrl";
import styles from "./desktop-markdown.module.css";

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
  const normalized = (content || "").replace(/\r\n/g, "\n").trim();

  type CodeProps = React.ComponentPropsWithoutRef<"code"> & { inline?: boolean; node?: unknown };
  type PreProps = React.ComponentPropsWithoutRef<"pre"> & { node?: unknown };
  type LinkProps = React.ComponentPropsWithoutRef<"a"> & { node?: unknown };

  const components: Components = {
    a({ href, children, ...props }: LinkProps) {
      return (
        <a href={normalizeExternalUrl(href)} target="_blank" rel="noreferrer" {...props}>
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
