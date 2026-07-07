"use client";

import { useEffect, useMemo, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { THEME_MODE_CHANGE_EVENT } from "@/components/theme/theme";
import { InlineCitationReference } from "@/components/ui/CitationReference";
import type { ApiCitation } from "@/lib/api";
import { normalizeExternalUrl } from "@/lib/normalizeExternalUrl";
import styles from "./markdown.module.css";

const CITATION_LINK_PREFIX = "/__citation__/";

type MarkdownNode = {
  type?: string;
  value?: string;
  url?: string;
  children?: Array<MarkdownNode | null | undefined>;
};

function buildCitationNodes(value: string, maxIndex: number): MarkdownNode[] | null {
  const pattern = /\[(\d+)\]/g;
  const nodes: MarkdownNode[] = [];
  let changed = false;
  let lastIndex = 0;

  for (const match of value.matchAll(pattern)) {
    const rawIndex = match[1] || "";
    const index = Number.parseInt(rawIndex, 10);
    const start = match.index ?? -1;
    const end = start + match[0].length;

    if (!Number.isFinite(index) || index < 1 || index > maxIndex || start < 0) {
      continue;
    }

    changed = true;
    if (start > lastIndex) {
      nodes.push({ type: "text", value: value.slice(lastIndex, start) });
    }
    nodes.push({
      type: "link",
      url: `${CITATION_LINK_PREFIX}${index}`,
      children: [{ type: "text", value: `[${index}]` }],
    });
    lastIndex = end;
  }

  if (!changed) return null;
  if (lastIndex < value.length) {
    nodes.push({ type: "text", value: value.slice(lastIndex) });
  }
  return nodes;
}

function createInlineCitationTransformer(citations?: ApiCitation[]) {
  return (tree: MarkdownNode | null | undefined) => {
    const maxIndex = citations?.length ?? 0;
    if (maxIndex === 0) return;

    const walk = (node: MarkdownNode | null | undefined) => {
      if (!node || !Array.isArray(node.children) || node.children.length === 0) return;
      if (
        node.type === "link" ||
        node.type === "linkReference" ||
        node.type === "code" ||
        node.type === "inlineCode" ||
        node.type === "html"
      ) {
        return;
      }

      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index];
        if (!child) continue;
        if (child?.type === "text" && typeof child.value === "string") {
          const replacement = buildCitationNodes(child.value, maxIndex);
          if (replacement) {
            node.children.splice(index, 1, ...replacement);
            index += replacement.length - 1;
            continue;
          }
        }
        walk(child);
      }
    };

    walk(tree);
  };
}

function remarkInlineCitations(citations?: ApiCitation[]) {
  return () => createInlineCitationTransformer(citations);
}

function resolveMarkdownHref(href: string | undefined) {
  if (!href) return "#";
  if (/^(https?:\/\/|www\.)/i.test(href)) {
    return normalizeExternalUrl(href);
  }
  return href;
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button type="button" onClick={handleCopy} className={styles.copyButton} title="复制代码">
      {copied ? "已复制" : "复制"}
    </button>
  );
}

export function MarkdownMessage({
  content,
  citations,
}: {
  content: string;
  citations?: ApiCitation[];
}) {
  const normalized = (content || "").replace(/\r\n/g, "\n").trim();
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
  const inlineCitationPlugin = useMemo(() => remarkInlineCitations(citations), [citations]);
  const remarkPlugins = useMemo(
    () => [remarkGfm, remarkBreaks, inlineCitationPlugin],
    [inlineCitationPlugin],
  );

  const components = useMemo<Components>(() => {
    type CodeProps = React.ComponentPropsWithoutRef<"code"> & { inline?: boolean; node?: unknown };
    type PreProps = React.ComponentPropsWithoutRef<"pre"> & { node?: unknown };
    type LinkProps = React.ComponentPropsWithoutRef<"a"> & { node?: unknown };

    return {
      a({ href, children, ...props }: LinkProps) {
        if (href?.startsWith(CITATION_LINK_PREFIX)) {
          const index = Number.parseInt(href.slice(CITATION_LINK_PREFIX.length), 10);
          const citation = citations?.[index - 1];
          if (!citation) {
            return <>{children}</>;
          }
          return <InlineCitationReference index={index} citation={citation} />;
        }

        return (
          <a href={resolveMarkdownHref(href)} target="_blank" rel="noreferrer" {...props}>
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
              <SyntaxHighlighter
                style={syntaxTheme}
                language={match ? match[1] : "text"}
                PreTag="div"
                customStyle={{
                  margin: 0,
                  padding: "0.75em 1em",
                  background: "transparent",
                  fontSize: "0.875em",
                  lineHeight: "1.5",
                }}
                codeTagProps={{
                  style: {
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  },
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
  }, [citations, syntaxTheme]);

  return (
    <div className={styles.root}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
