import { AppWindow, Code2, FolderInput, MousePointerClick, Repeat, Terminal } from "lucide-react";
import type { ImportSource } from "shared/types";
import { cn } from "ui";
import { DesktopProviderLogo } from "../../chat/DesktopProviderLogo";

/**
 * Source glyph for a row/card. Claude Code / Claude Desktop / Codex / Gemini
 * reuse the provider logos already shipped for channels; the rest get a
 * lucide glyph so every row has the same footprint.
 */
export function ImportSourceIcon({
  source,
  className,
}: {
  source: ImportSource;
  className?: string;
}) {
  const box = cn(
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
    className,
  );
  switch (source) {
    case "claude-code":
    case "claude-desktop":
      return (
        <div className={box}>
          <DesktopProviderLogo provider="anthropic" className="h-5 w-5" />
        </div>
      );
    case "codex":
      return (
        <div className={box}>
          <DesktopProviderLogo provider="openai" className="h-5 w-5" />
        </div>
      );
    case "gemini":
      return (
        <div className={box}>
          <DesktopProviderLogo provider="google" className="h-5 w-5" />
        </div>
      );
    case "cc-switch":
      return (
        <div className={box}>
          <Repeat size={18} />
        </div>
      );
    case "opencode":
    case "continue":
      return (
        <div className={box}>
          <Terminal size={18} />
        </div>
      );
    case "cursor":
      return (
        <div className={box}>
          <MousePointerClick size={18} />
        </div>
      );
    case "vscode":
      return (
        <div className={box}>
          <Code2 size={18} />
        </div>
      );
    case "file":
      return (
        <div className={box}>
          <FolderInput size={18} />
        </div>
      );
    default:
      return (
        <div className={box}>
          <AppWindow size={18} />
        </div>
      );
  }
}
