import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "ui";
import { type StreamTone, toneClassName } from "../../lib/agentTaskPresenter";

// Inline collapsible step. Instead of `-webkit-line-clamp` + a gradient mask (which
// lets the More button overlap and hide the tail of the third line), we measure with
// JS and binary-search the longest detail prefix that fits in `maxLines` rows *with a
// trailing reserve slot*. The third line's text is truncated so it ends before the
// More/Less button — the overflow text moves into the hidden (expandable) part, and a
// ~56px end-of-line spacer keeps the button from covering any glyphs. Body text of 1-2
// lines still uses the full width (no per-line padding/compression).
const CLAMP_LINE_HEIGHT = 24; // matches leading-6
const CLAMP_RESERVE = 64; // px reserved at the end of the last line for More/Less

export function InlineClampStep({
  label,
  detail,
  isResult,
  tone,
  maxLines = 3,
}: {
  label: string;
  detail: string | null;
  isResult: boolean;
  tone: StreamTone;
  maxLines?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const [clampedDetail, setClampedDetail] = useState<string | null>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const measure = measureRef.current;
    const content = contentRef.current;
    if (!measure || !content) return;

    // Pin the offscreen clone to the exact content-box width of the visible block so
    // the binary search wraps identically to the real render (no stray reserve span
    // spilling onto a 4th line). Both carry pl-3.5/text-sm/leading-6, so matching the
    // border-box width (clientWidth includes padding) aligns the wrap point exactly.
    measure.style.boxSizing = "border-box";
    measure.style.width = `${content.clientWidth}px`;

    const labelText = `${label}${isResult ? " done" : ""}`;
    // Build/reuse the offscreen measurement children so we only mutate text content
    // (no React re-render churn) while binary searching.
    let labelSpan = measure.querySelector<HTMLSpanElement>("[data-m='label']");
    let detailSpan = measure.querySelector<HTMLSpanElement>("[data-m='detail']");
    let reserveSpan = measure.querySelector<HTMLSpanElement>("[data-m='reserve']");
    if (!labelSpan || !detailSpan || !reserveSpan) {
      measure.textContent = "";
      labelSpan = document.createElement("span");
      labelSpan.dataset.m = "label";
      detailSpan = document.createElement("span");
      detailSpan.dataset.m = "detail";
      reserveSpan = document.createElement("span");
      reserveSpan.dataset.m = "reserve";
      reserveSpan.setAttribute("aria-hidden", "true");
      reserveSpan.style.display = "inline-block";
      reserveSpan.style.width = `${CLAMP_RESERVE}px`;
      measure.append(labelSpan, detailSpan, reserveSpan);
    }
    labelSpan.textContent = labelText;
    const detailNode = detailSpan;
    const reserveNode = reserveSpan;

    const threshold = CLAMP_LINE_HEIGHT * maxLines + 2;
    const heightFor = (text: string, withReserve: boolean): number => {
      detailNode.textContent = text ? ` · ${text}` : "";
      reserveNode.style.display = withReserve ? "inline-block" : "none";
      return measure.scrollHeight;
    };

    const run = () => {
      if (!detail) {
        setNeedsCollapse(false);
        setClampedDetail(null);
        return;
      }
      // Natural height with the full detail (no reserve) decides whether we clamp.
      if (heightFor(detail, false) <= threshold) {
        setNeedsCollapse(false);
        setClampedDetail(null);
        return;
      }
      // Longest prefix that still fits in `maxLines` once the ellipsis + reserve slot
      // are appended to the last line.
      let lo = 0;
      let hi = detail.length;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const candidate = `${detail.slice(0, mid).trimEnd()}…`;
        if (heightFor(candidate, true) <= threshold) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      setNeedsCollapse(true);
      setClampedDetail(`${detail.slice(0, best).trimEnd()}…`);
    };

    run();

    // Observe the visible block (not the clone — the clone has an explicit pinned
    // width and would not react to container resizes). Re-pin the clone width and
    // re-run the binary search only when the real content width actually changes.
    let prevWidth = content.clientWidth;
    const ro = new ResizeObserver(() => {
      const width = content.clientWidth;
      if (width !== prevWidth) {
        prevWidth = width;
        measure.style.width = `${width}px`;
        run();
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [label, detail, isResult, maxLines]);

  const collapsed = needsCollapse && !expanded;

  return (
    <div className={cn("relative py-0.5 text-sm leading-6", toneClassName(tone))}>
      <span
        aria-hidden="true"
        className="absolute left-0 top-[8px] h-1.5 w-1.5 rounded-full bg-current opacity-20"
      />
      {/* Offscreen measurement clone: same width (pl-3.5, full-width block) and text
          metrics (text-sm leading-6) as the visible content below. */}
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pl-3.5 text-sm leading-6"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          visibility: "hidden",
          pointerEvents: "none",
        }}
      />
      <div
        ref={contentRef}
        className="pl-3.5"
        // Hard cap the collapsed block at `maxLines` rows so that even if the inline
        // reserve span wraps, the overflow (a would-be 4th line) is clipped and the
        // absolutely-positioned More/Less button stays anchored to the 3rd line.
        style={
          collapsed ? { maxHeight: maxLines * CLAMP_LINE_HEIGHT, overflow: "hidden" } : undefined
        }
      >
        <span>
          {label}
          {isResult ? " done" : ""}
        </span>
        {detail ? (
          <span className="text-foreground opacity-32">
            {" · "}
            {collapsed ? clampedDetail : detail}
            {collapsed ? (
              <span aria-hidden="true" style={{ display: "inline-block", width: CLAMP_RESERVE }} />
            ) : null}
          </span>
        ) : null}
      </div>
      {needsCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="absolute right-0 bottom-0.5 pr-5 text-sm text-foreground/60 leading-6 transition-colors hover:text-foreground/80"
        >
          {expanded ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}
