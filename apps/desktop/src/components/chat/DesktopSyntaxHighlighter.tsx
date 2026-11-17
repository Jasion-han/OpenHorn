import type { ComponentPropsWithoutRef, CSSProperties } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import styles from "./desktop-markdown.module.css";

export function DesktopSyntaxHighlighter({
  codeString,
  className,
  language,
  isDark,
  showLineNumbers,
  customStyle,
  lineNumberStyle,
  fontFamily,
  codeProps,
}: {
  codeString: string;
  className?: string;
  language: string;
  isDark: boolean;
  showLineNumbers: boolean;
  customStyle: CSSProperties;
  lineNumberStyle: CSSProperties;
  fontFamily: string;
  codeProps: ComponentPropsWithoutRef<"code">;
}) {
  return (
    <SyntaxHighlighter
      className={styles.codeScroll}
      style={isDark ? oneDark : oneLight}
      language={language}
      PreTag="div"
      showLineNumbers={showLineNumbers}
      wrapLongLines={false}
      customStyle={customStyle}
      lineNumberStyle={lineNumberStyle}
      codeTagProps={{ className, style: { fontFamily }, ...codeProps }}
    >
      {codeString}
    </SyntaxHighlighter>
  );
}
