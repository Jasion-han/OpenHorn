"use client";

import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { WRAP_TEXT } from "@/components/ui/wrapText";
import type { ApiCitation } from "@/lib/api";

export function StreamingMarkdownMessage({
  content,
  citations,
}: {
  content: string;
  citations?: ApiCitation[];
}) {
  return (
    <div style={WRAP_TEXT}>
      <MarkdownMessage content={content} citations={citations} />
    </div>
  );
}
