"use client";

import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { WRAP_TEXT } from "@/components/ui/wrapText";
import type { ApiCitation } from "@/lib/api";

export function StreamingMarkdownMessage({
  content,
  tailLength,
  pulseKey,
  citations,
}: {
  content: string;
  tailLength: number;
  pulseKey: number;
  citations?: ApiCitation[];
}) {
  void tailLength;
  void pulseKey;

  return (
    <div style={WRAP_TEXT}>
      <MarkdownMessage content={content} citations={citations} />
    </div>
  );
}
