import { useEffect, useState } from "react";
import { cn } from "ui";
import chatgptLogo from "../../../public/provider-logos/chatgpt.svg";
import claudeLogo from "../../../public/provider-logos/claude.png";
import deepseekLogo from "../../../public/provider-logos/deepseek.ico";
import doubaoLogo from "../../../public/provider-logos/doubao.png";
import geminiLogo from "../../../public/provider-logos/gemini.png";
import qwenLogo from "../../../public/provider-logos/qwen.png";

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
  openai: { src: chatgptLogo, label: "GPT", className: "dark:invert" },
  anthropic: { src: claudeLogo, label: "Claude" },
  deepseek: { src: deepseekLogo, label: "DeepSeek" },
  google: { src: geminiLogo, label: "Gemini" },
  qwen: { src: qwenLogo, label: "Qwen" },
  doubao: { src: doubaoLogo, label: "豆包" },
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

export function DesktopProviderLogo({ provider, className, title }: ProviderLogoProps) {
  const normalized = provider ? normalizeProvider(provider) : "";
  const spec = normalized ? PROVIDER_LOGOS[normalized] : undefined;
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [spec?.src]);

  const fallbackTitle = title || provider || "Unknown provider";
  const initial = normalized ? normalized.slice(0, 1).toUpperCase() : "?";

  if (spec && !imageFailed) {
    return (
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
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={fallbackTitle}
      title={fallbackTitle}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted text-[10px] font-medium text-muted-foreground",
        className,
      )}
    >
      {initial}
    </span>
  );
}
