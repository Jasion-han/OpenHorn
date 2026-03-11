'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './markdown.module.css';

// Render assistant content as Markdown so users don't see raw **/**/``` tokens.
// HTML is not allowed by default in react-markdown, which keeps this safe.
export function MarkdownMessage({ content }: { content: string }) {
  // Compact consecutive blank lines (common in model outputs) to reduce excessive vertical gaps.
  // Keep at most one blank line so Markdown structure still works.
  const normalized = (content || '').replace(/\n{3,}/g, '\n\n');

  return (
    <div className={styles.root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children, ...props }) => <pre {...props}>{children}</pre>,
          code: ({ children, ...props }) => <code {...props}>{children}</code>,
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
