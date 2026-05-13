import type { CSSProperties } from "react";

export type StreamTone = "default" | "success" | "warning" | "danger";

export function toneClassName(tone: StreamTone = "default") {
  switch (tone) {
    case "success":
      return "text-foreground/60";
    case "warning":
      return "text-foreground/50";
    case "danger":
      return "text-destructive/70";
    default:
      return "text-foreground/42";
  }
}

export function getActiveMetaTextStyle(): CSSProperties {
  // Shimmer effect using the theme's foreground HSL variable so it works
  // in both light and dark modes.
  const fg = "hsl(var(--foreground))";
  const fgDim = "hsl(var(--foreground) / 0.3)";
  return {
    backgroundImage: `linear-gradient(90deg, ${fgDim} 0%, ${fg} 45%, ${fg} 55%, ${fgDim} 100%)`,
    backgroundSize: "250% 100%",
    backgroundClip: "text",
    WebkitBackgroundClip: "text",
    color: "transparent",
    WebkitTextFillColor: "transparent",
    animation: "agentMetaTextShimmer 2.2s linear infinite",
  };
}
