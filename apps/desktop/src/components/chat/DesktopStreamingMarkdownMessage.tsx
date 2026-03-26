import { DesktopMarkdownMessage } from "./DesktopMarkdownMessage";

export function DesktopStreamingMarkdownMessage({
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

  return <DesktopMarkdownMessage content={content} />;
}
