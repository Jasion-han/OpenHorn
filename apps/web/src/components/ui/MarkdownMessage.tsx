'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './markdown.module.css';

// Render assistant content as Markdown so users don't see raw **/**/``` tokens.
// HTML is not allowed by default in react-markdown, which keeps this safe.
export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className={styles.root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children, ...props }) => <pre {...props}>{children}</pre>,
          code: ({ children, ...props }) => <code {...props}>{children}</code>,
        }}
      >
        {content || ''}
      </ReactMarkdown>
    </div>
  );
}
