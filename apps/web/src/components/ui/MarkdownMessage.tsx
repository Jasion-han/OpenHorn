'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import styles from './markdown.module.css';

// Render assistant content as Markdown so users don't see raw **/**/``` tokens.
// HTML is not allowed by default in react-markdown, which keeps this safe.
export function MarkdownMessage({ content }: { content: string }) {
  // Tight mode: collapse blank lines and render single newlines as line breaks.
  // This avoids the "paragraph gap" look when models emit lots of blank lines.
  const normalized = (content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  return (
    <div className={styles.root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
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
