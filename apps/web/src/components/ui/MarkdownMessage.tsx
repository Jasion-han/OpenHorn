'use client';

import { TypographyStylesProvider } from '@mantine/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Render assistant content as Markdown so users don't see raw **/**/``` tokens.
// HTML is not allowed by default in react-markdown, which keeps this safe.
export function MarkdownMessage({ content }: { content: string }) {
  return (
    <TypographyStylesProvider
      style={{
        maxWidth: '100%',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children, ...props }) => (
            <pre
              {...props}
              style={{
                margin: 0,
                maxWidth: '100%',
                overflowX: 'auto',
              }}
            >
              {children}
            </pre>
          ),
          code: ({ children, ...props }) => (
            <code
              {...props}
              style={{
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
              }}
            >
              {children}
            </code>
          ),
        }}
      >
        {content || ''}
      </ReactMarkdown>
    </TypographyStylesProvider>
  );
}

