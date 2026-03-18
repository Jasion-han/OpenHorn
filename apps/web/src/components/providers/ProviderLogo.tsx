"use client";

import { cn } from "@/lib/utils";

type ProviderLogoProps = {
  provider: string | null | undefined;
  className?: string;
  title?: string;
};

type ProviderLogoSpec = {
  src: string;
  label: string;
  className?: string;
};

const PROVIDER_LOGOS: Record<string, ProviderLogoSpec> = {
  // Use "model brand" icons rather than vendor marks (per UI requirement).
  openai: { src: "/provider-logos/chatgpt.svg", label: "GPT", className: "dark:invert" },
  anthropic: { src: "/provider-logos/claude.png", label: "Claude" },
  deepseek: { src: "/provider-logos/deepseek.ico", label: "DeepSeek" },
  google: { src: "/provider-logos/gemini.png", label: "Gemini" },
  qwen: { src: "/provider-logos/qwen.png", label: "Qwen" },
  doubao: { src: "/provider-logos/doubao.png", label: "豆包" },
};

function normalizeProvider(provider: string) {
  const value = provider.trim().toLowerCase();
  if (!value) return value;

  if (
    value === "dashscope" ||
    value === "aliyun" ||
    value === "alibaba" ||
    value === "tongyi" ||
    value === "qianwen"
  ) {
    return "qwen";
  }

  if (value === "bytedance" || value === "volcengine" || value === "ark") {
    return "doubao";
  }

  return value;
}

export function ProviderLogo({ provider, className, title }: ProviderLogoProps) {
  const normalized = provider ? normalizeProvider(provider) : "";
  const spec = normalized ? PROVIDER_LOGOS[normalized] : undefined;

  if (spec) {
    return (
      // biome-ignore lint/performance/noImgElement: local icon in /public; Next Image not required for tiny UI glyph
      <img
        src={spec.src}
        alt={spec.label}
        title={title || spec.label}
        className={cn(
          "inline-block size-4 shrink-0 rounded-sm object-contain",
          spec.className,
          className,
        )}
        draggable={false}
      />
    );
  }

  const initial = normalized ? normalized.slice(0, 1).toUpperCase() : "?";
  return (
    <span
      role="img"
      aria-label={provider || "Unknown provider"}
      title={title || provider || "Unknown provider"}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted text-[10px] font-medium text-muted-foreground",
        className,
      )}
    >
      {initial}
    </span>
  );
}
