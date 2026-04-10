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
          <span className={cn("mr-2", active ? "opacity-38" : "opacity-24")}>·</span>
          <span style={active ? getActiveMetaTextStyle() : undefined}>
            {text}
          </span>
          {subtext ? <span className="text-foreground opacity-32"> · {subtext}</span> : null}
          {active ? (
            <span
              aria-hidden="true"
              className="ml-2 inline-block h-[0.9em] w-px bg-current align-middle"
              style={{ animation: "agentMetaCursorPulse 1.05s ease-in-out infinite" }}
            />
          ) : null}
        </span>
      </span>
    </div>
  );
}
