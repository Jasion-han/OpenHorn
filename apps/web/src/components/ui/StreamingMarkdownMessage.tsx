'use client';

import { WRAP_TEXT } from '@/components/ui/wrapText';
import { MarkdownMessage } from '@/components/ui/MarkdownMessage';

export function StreamingMarkdownMessage({
  content,
  tailLength,
  pulseKey,
}: {
  content: string;
  tailLength: number;
  pulseKey: number;
}) {
  void tailLength;
  void pulseKey;

  return (
    <div style={WRAP_TEXT}>
      <MarkdownMessage content={content} />
    </div>
  );
}
