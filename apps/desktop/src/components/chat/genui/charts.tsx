import styles from "./genui.module.css";

/**
 * Small SVG charts for ```openui-lang answers. Hand-rolled instead of a chart
 * library: three shapes cover what answers need, and the desktop bundle stays
 * free of a charting dependency. Colors are fixed hues that read on both
 * themes; text uses currentColor (the muted foreground).
 */

export const SERIES_COLORS = [
  "hsl(214 82% 56%)",
  "hsl(152 55% 44%)",
  "hsl(35 92% 52%)",
  "hsl(280 60% 60%)",
  "hsl(350 75% 58%)",
  "hsl(190 70% 45%)",
];

const colorAt = (index: number) => SERIES_COLORS[index % SERIES_COLORS.length];

function compact(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

/** About five round tick values covering 0..max (or min..max when negative). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return [lo];
  const rough = (hi - lo) / count;
  const endpoints = () => [...new Set([lo, 0, hi])];
  // Finite endpoints can still overflow their span, or underflow its division.
  if (!Number.isFinite(rough) || rough <= 0) return endpoints();
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude;
  if (!Number.isFinite(step) || step <= 0) return endpoints();
  const first = Math.floor(lo / step);
  const last = Math.ceil(hi / step);
  const ticks: number[] = [];
  for (let i = first; i <= last; i++) {
    const tick = Number((i * step).toPrecision(12));
    if (Number.isFinite(tick)) ticks.push(tick);
  }
  // Rounding outwards near Number.MAX_VALUE can overflow an otherwise valid tick.
  if (ticks.length === 0) return endpoints();
  if (ticks[0] > lo) ticks.unshift(lo);
  if (ticks[ticks.length - 1] < hi) ticks.push(hi);
  return ticks;
}

function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  return (
    <div className={styles.chartLegend}>
      {names.map((name, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat; order is fixed
        <span key={`${name}-${i}`}>
          <span className={styles.legendSwatch} style={{ background: colorAt(i) }} />
          {name}
        </span>
      ))}
    </div>
  );
}

export function BarLineChart({
  kind,
  labels,
  series,
  unit,
  height,
}: {
  kind: "bar" | "line";
  labels: string[];
  series: { name: string; values: number[] }[];
  unit?: string;
  height: number;
}) {
  const width = 600;
  const pad = { top: 12, right: 12, bottom: 28, left: 44 };
  // A dense series must not be passed as function arguments (Chromium has a
  // much lower argument limit than the number of values arrays can contain).
  let min = 0;
  let max = 0;
  for (const item of series) {
    for (const value of item.values) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  const ticks = niceTicks(min, max);
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const scale = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
  const scaledLo = lo / scale;
  const span = hi / scale - scaledLo || 1;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const y = (v: number) => pad.top + plotH - ((v / scale - scaledLo) / span) * plotH;
  const band = plotW / labels.length;
  const xCenter = (i: number) => pad.left + band * (i + 0.5);
  const barGroup = band * 0.72;
  const barW = barGroup / series.length;
  const labelEvery = Math.max(1, Math.ceil(labels.length / 10));

  return (
    <div className={styles.col} style={{ gap: 8 }}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={series.map((s) => s.name).join(", ")}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(t)}
              y2={y(t)}
              stroke="currentColor"
              strokeOpacity={t === 0 ? 0.35 : 0.12}
            />
            <text
              x={pad.left - 6}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              fontSize={11}
              fill="currentColor"
            >
              {compact(t)}
              {unit && t === hi ? unit : ""}
            </text>
          </g>
        ))}
        {labels.map((label, i) =>
          i % labelEvery === 0 ? (
            <text
              // biome-ignore lint/suspicious/noArrayIndexKey: labels are positional
              key={i}
              x={xCenter(i)}
              y={height - 8}
              textAnchor="middle"
              fontSize={11}
              fill="currentColor"
            >
              {label.length > 10 ? `${label.slice(0, 9)}…` : label}
            </text>
          ) : null,
        )}
        {kind === "bar"
          ? series.map((s, si) =>
              s.values.map((v, i) => {
                const top = y(Math.max(v, 0));
                const bottom = y(Math.min(v, 0));
                return (
                  <rect
                    // biome-ignore lint/suspicious/noArrayIndexKey: values are positional
                    key={`${si}-${i}`}
                    x={xCenter(i) - barGroup / 2 + barW * si + 1}
                    y={top}
                    width={Math.max(barW - 2, 1)}
                    height={Math.max(bottom - top, 0)}
                    rx={2}
                    fill={colorAt(si)}
                  >
                    <title>{`${labels[i]} · ${s.name}: ${v}${unit ?? ""}`}</title>
                  </rect>
                );
              }),
            )
          : series.map((s, si) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat; order is fixed
              <g key={`${s.name}-${si}`}>
                <polyline
                  points={s.values.map((v, i) => `${xCenter(i)},${y(v)}`).join(" ")}
                  fill="none"
                  stroke={colorAt(si)}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
                {s.values.map((v, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: values are positional
                  <circle key={i} cx={xCenter(i)} cy={y(v)} r={3} fill={colorAt(si)}>
                    <title>{`${labels[i]} · ${s.name}: ${v}${unit ?? ""}`}</title>
                  </circle>
                ))}
              </g>
            ))}
      </svg>
      <Legend names={series.map((s) => s.name)} />
    </div>
  );
}

export function PieChart({
  labels,
  values,
  unit,
}: {
  labels: string[];
  values: number[];
  unit?: string;
}) {
  let scale = 0;
  for (const value of values) scale = Math.max(scale, value);
  if (scale <= 0) return null;
  const positive = values.map((v) => (v > 0 ? v / scale : 0));
  const total = positive.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const r = 80;
  const inner = 46;
  let angle = -Math.PI / 2;
  const point = (radius: number, a: number) =>
    `${100 + radius * Math.cos(a)},${100 + radius * Math.sin(a)}`;
  const slices = positive.map((v, i) => {
    const sweep = (v / total) * Math.PI * 2;
    const start = angle;
    angle += sweep;
    if (v <= 0) return null;
    // A full circle cannot be one arc; split it in two.
    const end = sweep >= Math.PI * 2 - 1e-6 ? start + Math.PI * 2 - 1e-4 : angle;
    const large = end - start > Math.PI ? 1 : 0;
    const d = `M${point(r, start)} A${r},${r} 0 ${large} 1 ${point(r, end)} L${point(inner, end)} A${inner},${inner} 0 ${large} 0 ${point(inner, start)} Z`;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: slices are positional
      <path key={i} d={d} fill={colorAt(i)}>
        <title>{`${labels[i]}: ${values[i]}${unit ?? ""} (${Math.round((v / total) * 100)}%)`}</title>
      </path>
    );
  });
  return (
    <div className={styles.row} style={{ gap: 16, flexWrap: "wrap" }}>
      <svg viewBox="0 0 200 200" width={180} height={180} role="img" aria-label={labels.join(", ")}>
        {slices}
      </svg>
      <div className={styles.col} style={{ gap: 4, fontSize: 12 }}>
        {labels.map((label, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat; order is fixed
          <span key={`${label}-${i}`}>
            <span className={styles.legendSwatch} style={{ background: colorAt(i) }} />
            {label} · {Math.round(((positive[i] ?? 0) / total) * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}
