'use client';

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import styles from './markdown.module.css';
import { THEME_MODE_CHANGE_EVENT } from '@/components/theme/theme';

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button onClick={handleCopy} className={styles.copyButton} title="复制代码">
      {copied ? '已复制' : '复制'}
    </button>
  );
}

export function MarkdownMessage({ content }: { content: string }) {
  const normalized = (content || '').replace(/\r\n/g, '\n').trim();
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const compute = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    compute();
    window.addEventListener(THEME_MODE_CHANGE_EVENT, compute);
    return () => {
      window.removeEventListener(THEME_MODE_CHANGE_EVENT, compute);
    };
  }, []);

  const syntaxTheme = useMemo(() => (isDark ? (oneDark as any) : (oneLight as any)), [isDark]);

  return (
    <div className={styles.root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          code({ className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');
            const isBlock = codeString.includes('\n') || !!match;
            if (isBlock) {
              return (
                <div className={styles.codeBlock}>
                  <div className={styles.codeHeader}>
                    <span className={styles.codeLang}>{match ? match[1] : ''}</span>
                    <CopyButton code={codeString} />
                  </div>
                  <SyntaxHighlighter
                    style={syntaxTheme}
                    language={match ? match[1] : 'text'}
                    PreTag="div"
                    customStyle={{ margin: 0, padding: '0.75em 1em', background: 'transparent', fontSize: '0.875em', lineHeight: '1.5' }}
                    codeTagProps={{ style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' } }}
                  >
                    {codeString}
                  </SyntaxHighlighter>
                </div>
              );
            }
            return <code className={className} {...props}>{children}</code>;
          },
          pre({ children }: any) { return <>{children}</>; },
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
