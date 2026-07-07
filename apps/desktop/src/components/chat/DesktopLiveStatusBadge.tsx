import { cn } from "ui";
import { getChatLabel } from "../../lib/i18n/agent";
import type { Message } from "../../types/chat";

export function LiveStatusBadge({
  status,
  route,
  label,
}: {
  status?: Message["liveStatus"];
  route?: Message["liveRoute"];
  label?: string;
}) {
  if (!label) return null;

  const routeLabel = (() => {
    switch (route) {
      case "local":
        return getChatLabel("chat.liveRoute.local");
      case "structured_live":
        return getChatLabel("chat.liveRoute.structuredLive");
      case "web_search":
        return getChatLabel("chat.liveRoute.webSearch");
      case "research":
        return getChatLabel("chat.liveRoute.research");
      default:
        return getChatLabel("chat.liveRoute.direct");
    }
  })();

  return (
    <div
      className={cn(
        "mb-2 inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        status === "live"
          ? "border-emerald-300/60 bg-emerald-50 text-emerald-700"
          : "border-amber-300/60 bg-amber-50 text-amber-700",
      )}
    >
      <span className="rounded-full bg-black/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
        {routeLabel}
      </span>
      <span>{label}</span>
    </div>
  );
}
