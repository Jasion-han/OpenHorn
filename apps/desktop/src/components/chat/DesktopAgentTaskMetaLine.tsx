import { cn } from "ui";
import type { StreamTone } from "../../lib/agentTaskStreamBuilder";
import { toneClassName, getActiveMetaTextStyle } from "../../lib/agentTaskPresenter";

export function DesktopAgentTaskMetaLine({
  text,
  tone = "default",
  active = false,
  subtext,
}: {
  text: string;
  tone?: StreamTone;
  active?: boolean;
  subtext?: string | null;
}) {
  return (
    <div
      className={cn(
        "py-0.5 text-sm leading-6",
        toneClassName(tone),
      )}
    >
      {active && (
        <style>{`
          @keyframes agentMetaTextShimmer {
            0% { background-position: 130% 50%; }
            100% { background-position: -30% 50%; }
          }
          @keyframes agentMetaDotPulse {
            0%, 100% { transform: scale(0.9); opacity: 0.35; }
            50% { transform: scale(1.05); opacity: 0.78; }
          }
        `}</style>
      )}
      <span className="relative flex items-start gap-2">
        <span
          aria-hidden="true"
          className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-current"
          style={{
            opacity: active ? 0.56 : 0.2,
            animation: active ? "agentMetaDotPulse 1.35s ease-in-out infinite" : undefined,
          }}
        />
        <span className="min-w-0">
          <span className="mr-0" />
          <span style={active ? getActiveMetaTextStyle() : undefined}>
            {text}
          </span>
          {subtext ? <span className="text-foreground opacity-32"> · {subtext}</span> : null}
          {null}
        </span>
      </span>
    </div>
  );
}
