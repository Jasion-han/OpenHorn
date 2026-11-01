import {
  action,
  defineAction,
  defineComponent,
  reactive,
  tagSchemaId,
  useFormName,
  useIsStreaming,
  useStateField,
  useTriggerAction,
} from "@openuidev/react-lang";
import type { LucideIcon } from "lucide-react";
import * as lucide from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { cn } from "ui";
import { z } from "zod";
import { BarLineChart, PieChart } from "./charts";
import styles from "./genui.module.css";

/**
 * The primitives a model arranges in a ```openui-lang block. Layout is never
 * fixed here; the model composes it. Argument order is the language's call
 * signature (positional), so names and order are part of the prompt contract:
 * changing them changes what models must write.
 */

// Shared prop schemas, printed under these names in the prompt.
const node = z.any();
tagSchemaId(node, "Node");
const children = z.array(node);

const tone = z.enum(["default", "muted", "info", "success", "warning", "danger"]);
tagSchemaId(tone, "Tone");
type Tone = z.infer<typeof tone>;

const TONE_CLASS: Record<Tone, string | undefined> = {
  default: undefined,
  muted: styles.toneMuted,
  info: styles.toneInfo,
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
};

const toneClass = (value: unknown) => TONE_CLASS[(value as Tone) ?? "default"];

// gap counts 4px steps, like Tailwind.
const gapPx = (gap: unknown, fallback: number) =>
  `${(typeof gap === "number" && Number.isFinite(gap) ? Math.min(Math.max(gap, 0), 16) : fallback) * 4}px`;

const ALIGN: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  between: "space-between",
};

const isElement = (value: unknown) =>
  !!value && typeof value === "object" && (value as { type?: unknown }).type === "element";

/**
 * A model value as display text. Only scalars print (booleans too: Table cells
 * and List items accept any value); an object (e.g. a derived `$x = ...` the
 * model left unevaluated) would otherwise show as "[object Object]", so it and
 * other non-scalars render empty.
 */
export const numberText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  }
  return "";
};

/** The state key of a control: its label, its statement name, or a generated id. */
function useFieldName(label: unknown, statementId?: string) {
  const id = useId();
  return (typeof label === "string" && label) || statementId || id;
}

function Field({ label, children: content }: { label?: string; children: ReactNode }) {
  if (!label) return <>{content}</>;
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child
    <label className={styles.field}>
      <span className={styles.label}>{numberText(label)}</span>
      {content}
    </label>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────

export const Col = defineComponent({
  name: "Col",
  props: z.object({
    children,
    gap: z.number().optional(),
    align: z.enum(["start", "center", "end", "stretch"]).optional(),
  }),
  description: "Vertical stack. gap counts 4px steps (default 3).",
  component: ({ props, renderNode }) => (
    <div
      className={styles.col}
      style={{ gap: gapPx(props.gap, 3), alignItems: props.align ? ALIGN[props.align] : undefined }}
    >
      {renderNode(props.children)}
    </div>
  ),
});

export const Row = defineComponent({
  name: "Row",
  props: z.object({
    children,
    gap: z.number().optional(),
    align: z.enum(["start", "center", "end", "stretch"]).optional(),
    justify: z.enum(["start", "center", "end", "between"]).optional(),
    wrap: z.boolean().optional(),
  }),
  description:
    "Horizontal row; items are vertically centered. Use wrap for chips that may not fit.",
  component: ({ props, renderNode }) => (
    <div
      className={styles.row}
      style={{
        gap: gapPx(props.gap, 2),
        alignItems: props.align ? ALIGN[props.align] : undefined,
        justifyContent: props.justify ? ALIGN[props.justify] : undefined,
        flexWrap: props.wrap ? "wrap" : undefined,
      }}
    >
      {renderNode(props.children)}
    </div>
  ),
});

export const Card = defineComponent({
  name: "Card",
  props: z.object({
    children,
    variant: z.enum(["outline", "soft"]).optional(),
    gap: z.number().optional(),
  }),
  description: "Panel with a border; soft is a filled panel for summaries and totals.",
  component: ({ props, renderNode }) => (
    <div
      className={cn(styles.card, props.variant === "soft" && styles.cardSoft)}
      style={{ gap: gapPx(props.gap, 3) }}
    >
      {renderNode(props.children)}
    </div>
  ),
});

export const Grid = defineComponent({
  name: "Grid",
  props: z.object({
    children,
    columns: z.number().optional(),
    minChildWidth: z.number().optional(),
    gap: z.number().optional(),
  }),
  description: "Equal columns (default 2). With minChildWidth (px), columns drop on narrow widths.",
  component: ({ props, renderNode }) => {
    const columns = Math.min(Math.max(Math.trunc(props.columns ?? 2), 1), 6);
    const min =
      props.minChildWidth && props.minChildWidth > 0 ? Math.min(props.minChildWidth, 600) : 0;
    return (
      <div
        className={styles.grid}
        style={{
          gap: gapPx(props.gap, 3),
          gridTemplateColumns: min
            ? `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`
            : `repeat(${columns}, minmax(0, 1fr))`,
        }}
      >
        {renderNode(props.children)}
      </div>
    );
  },
});

export const Divider = defineComponent({
  name: "Divider",
  props: z.object({}),
  description: "Horizontal rule.",
  component: () => <div className={styles.divider} />,
});

export const Spacer = defineComponent({
  name: "Spacer",
  props: z.object({}),
  description: "Fills the free space in a Row (pushes later items to the end).",
  component: () => <div className={styles.spacer} />,
});

// ── Text ──────────────────────────────────────────────────────────────────

const TITLE_SIZE: Record<string, string | undefined> = {
  sm: styles.titleSm,
  md: styles.titleMd,
  lg: styles.titleLg,
  xl: styles.titleXl,
};

export const Title = defineComponent({
  name: "Title",
  props: z.object({ text: z.string(), size: z.enum(["sm", "md", "lg", "xl"]).optional() }),
  description: "Heading; md for a card title, xl for the answer's headline.",
  component: ({ props }) => (
    <h3 className={cn(styles.title, TITLE_SIZE[props.size ?? "md"])}>{numberText(props.text)}</h3>
  ),
});

const TEXT_SIZE: Record<string, string | undefined> = {
  xs: styles.textXs,
  sm: styles.textSm,
  md: styles.textMd,
};

export const Text = defineComponent({
  name: "Text",
  props: z.object({
    text: z.union([z.string(), z.number()]),
    size: z.enum(["xs", "sm", "md"]).optional(),
    tone: tone.optional(),
    weight: z.enum(["normal", "medium", "semibold"]).optional(),
    lineThrough: z.boolean().optional(),
  }),
  description: "Paragraph or inline value.",
  component: ({ props }) => (
    <p
      className={cn(
        styles.text,
        TEXT_SIZE[props.size ?? "md"],
        toneClass(props.tone),
        props.lineThrough && styles.lineThrough,
      )}
      style={{
        fontWeight: props.weight === "semibold" ? 600 : props.weight === "medium" ? 500 : undefined,
      }}
    >
      {numberText(props.text)}
    </p>
  ),
});

export const Caption = defineComponent({
  name: "Caption",
  props: z.object({ text: z.string() }),
  description: "Small secondary text: units, sources, footnotes.",
  component: ({ props }) => <span className={styles.caption}>{numberText(props.text)}</span>,
});

export const Badge = defineComponent({
  name: "Badge",
  props: z.object({ text: z.string(), tone: tone.optional() }),
  description: "Short status chip.",
  component: ({ props }) => (
    <span className={cn(styles.badge, toneClass(props.tone))}>{numberText(props.text)}</span>
  ),
});

export const List = defineComponent({
  name: "List",
  props: z.object({ items: z.array(node), ordered: z.boolean().optional() }),
  description: "Bulleted (or numbered) list; items are strings or components.",
  component: ({ props, renderNode }) => {
    const items = Array.isArray(props.items) ? props.items : [];
    const Tag = props.ordered ? "ol" : "ul";
    return (
      <Tag className={styles.list} style={{ listStyleType: props.ordered ? "decimal" : "disc" }}>
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: model-written lists have no ids
          <li key={index}>{isElement(item) ? renderNode(item) : numberText(item)}</li>
        ))}
      </Tag>
    );
  },
});

export const Stat = defineComponent({
  name: "Stat",
  props: z.object({
    label: z.string(),
    value: z.union([z.string(), z.number()]),
    hint: z.string().optional(),
    tone: tone.optional(),
  }),
  description: "A headline number with its label, e.g. a result a calculator computes.",
  component: ({ props }) => (
    <div className={styles.stat}>
      <span className={styles.label}>{numberText(props.label)}</span>
      <span className={cn(styles.statValue, toneClass(props.tone))}>{numberText(props.value)}</span>
      {props.hint ? <span className={styles.caption}>{numberText(props.hint)}</span> : null}
    </div>
  ),
});

export const Progress = defineComponent({
  name: "Progress",
  props: z.object({
    value: z.number(),
    max: z.number().optional(),
    label: z.string().optional(),
  }),
  description: "Progress bar from 0 to max (default 100).",
  component: ({ props }) => {
    const max = props.max && props.max > 0 ? props.max : 100;
    const ratio = Number.isFinite(props.value) ? Math.min(Math.max(props.value / max, 0), 1) : 0;
    return (
      <Field label={props.label}>
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${ratio * 100}%` }} />
        </div>
      </Field>
    );
  },
});

// The module namespace, not `icons`: `icons` holds canonical names only, and
// models often write the older aliases ("check-circle" is now "circle-check").
const lucideExports = lucide as unknown as Record<string, unknown>;

/** A lucide icon by kebab-case name (canonical or alias), or null. Exported for tests. */
export function iconFor(name: unknown): LucideIcon | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const pascal = name
    .trim()
    .split(/[-_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const found = lucideExports[`${pascal}Icon`] ?? lucideExports[pascal];
  return found && typeof found === "object" && "$$typeof" in found ? (found as LucideIcon) : null;
}

export const Icon = defineComponent({
  name: "Icon",
  props: z.object({
    name: z.string(),
    size: z.enum(["sm", "md", "lg"]).optional(),
    tone: tone.optional(),
  }),
  description: 'A lucide icon by kebab-case name, e.g. "check-circle", "map-pin".',
  component: ({ props }) => {
    const Glyph = iconFor(props.name);
    if (!Glyph) return null;
    const px = props.size === "sm" ? 14 : props.size === "lg" ? 22 : 18;
    return <Glyph size={px} className={toneClass(props.tone)} aria-hidden />;
  },
});

// ── Inputs ────────────────────────────────────────────────────────────────

type Plan = Parameters<ReturnType<typeof useTriggerAction>>[2];

export const Button = defineComponent({
  name: "Button",
  props: z.object({
    label: z.string(),
    action: action().optional(),
    variant: z.enum(["solid", "outline", "ghost"]).optional(),
    icon: z.string().optional(),
    disabled: z.boolean().optional(),
  }),
  description:
    "Runs its action. Without an action it offers its label to the assistant as the user's next message.",
  component: ({ props }) => {
    const trigger = useTriggerAction();
    const formName = useFormName();
    const streaming = useIsStreaming();
    const label = String(props.label ?? "");
    const Glyph = iconFor(props.icon);
    return (
      <button
        type="button"
        className={cn(
          styles.button,
          props.variant === "outline"
            ? styles.buttonOutline
            : props.variant === "ghost"
              ? styles.buttonGhost
              : styles.buttonSolid,
        )}
        disabled={!!props.disabled || streaming}
        onClick={() => {
          if (props.action) void trigger(label, formName, props.action as Plan);
          else void trigger(label, formName);
        }}
      >
        {Glyph ? <Glyph size={14} aria-hidden /> : null}
        {label}
      </button>
    );
  },
});

export const Slider = defineComponent({
  name: "Slider",
  props: z.object({
    value: reactive(z.number()),
    min: z.number(),
    max: z.number(),
    step: z.number().optional(),
    label: z.string().optional(),
    unit: z.string().optional(),
  }),
  description: 'Shows label and current value; unit like "%" or "¥" formats the value.',
  component: function SliderView({ props, statementId }) {
    const field = useStateField(useFieldName(props.label, statementId), props.value);
    const streaming = useIsStreaming();
    const min = Number.isFinite(props.min) ? props.min : 0;
    const max = Number.isFinite(props.max) && props.max > min ? props.max : min + 100;
    const step =
      typeof props.step === "number" && Number.isFinite(props.step) && props.step > 0
        ? props.step
        : 1;
    const raw = typeof field.value === "number" ? field.value : Number(field.value);
    const clamped = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : min;
    const steps = Math.min(
      Math.floor((max - min) / step + 1e-10),
      Math.round((clamped - min) / step),
    );
    const snapped = min + steps * step;
    const value = Number.isFinite(snapped)
      ? Math.min(max, Math.max(min, Number(snapped.toPrecision(15))))
      : clamped;
    useEffect(() => {
      // Wait for Renderer to initialize the binding; then normalize the value
      // calculations actually read, including restored values and changing bounds.
      if (!streaming && field.value !== undefined && !Object.is(field.value, value)) {
        field.setValue(value);
      }
    }, [field, value, streaming]);
    const unit = props.unit ?? "";
    const readout = /^[$€£¥₹]/.test(unit)
      ? `${unit}${numberText(value)}`
      : `${numberText(value)}${unit}`;
    const id = useId();
    return (
      <div className={styles.field}>
        {props.label || props.unit ? (
          <div className={styles.sliderHead}>
            <label htmlFor={id} className={styles.label}>
              {numberText(props.label)}
            </label>
            <output htmlFor={id} className={styles.sliderValue}>
              {readout}
            </output>
          </div>
        ) : null}
        <input
          id={id}
          className={styles.range}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={streaming}
          aria-valuetext={readout}
          onChange={(event) => field.setValue(Number(event.target.value))}
        />
      </div>
    );
  },
});

export const Input = defineComponent({
  name: "Input",
  props: z.object({
    value: reactive(z.union([z.string(), z.number()])),
    label: z.string().optional(),
    type: z.enum(["text", "number"]).optional(),
    placeholder: z.string().optional(),
  }),
  description: "Text or number field; a number field stores numbers.",
  component: function InputView({ props, statementId }) {
    const field = useStateField(useFieldName(props.label, statementId), props.value);
    const streaming = useIsStreaming();
    const numeric = props.type === "number";
    // A number field shows what is typed ("1." or "-") until it parses.
    const [draft, setDraft] = useState<string | null>(null);
    const shown = draft ?? String(field.value ?? "");
    return (
      <Field label={props.label}>
        <input
          className={styles.input}
          type="text"
          inputMode={numeric ? "decimal" : undefined}
          value={shown}
          placeholder={props.placeholder}
          disabled={streaming}
          onChange={(event) => {
            const text = event.target.value;
            if (!numeric) {
              field.setValue(text);
              return;
            }
            setDraft(text);
            const parsed = Number(text.replace(/,/g, ""));
            if (text.trim() === "") field.setValue(null as unknown as number);
            else if (Number.isFinite(parsed)) field.setValue(parsed);
          }}
          onBlur={() => setDraft(null)}
        />
      </Field>
    );
  },
});

const choice = z.union([z.string(), z.object({ value: z.string(), label: z.string() })]);
type Choice = { value: string; label: string };
const choiceList = (value: unknown): Choice[] =>
  Array.isArray(value)
    ? (value as (string | Choice | null)[])
        .filter((o): o is string | Choice => o != null)
        .map((o) => (typeof o === "string" ? { value: o, label: o } : o))
    : [];

export const Select = defineComponent({
  name: "Select",
  props: z.object({
    value: reactive(z.string()),
    options: z.array(choice),
    label: z.string().optional(),
  }),
  description: "Dropdown, for long option lists.",
  component: ({ props, statementId }) => {
    const field = useStateField(useFieldName(props.label, statementId), props.value);
    const streaming = useIsStreaming();
    const choices = choiceList(props.options);
    const value = field.value == null ? "" : String(field.value);
    return (
      <Field label={props.label}>
        <select
          className={styles.input}
          value={value}
          disabled={streaming}
          onChange={(event) => field.setValue(event.target.value)}
        >
          {choices.some((o) => o.value === value) ? null : <option value="" disabled />}
          {choices.map((o, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: model-written values may repeat
            <option key={`${o.value}-${i}`} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    );
  },
});

export const SegmentedControl = defineComponent({
  name: "SegmentedControl",
  props: z.object({
    value: reactive(z.string()),
    options: z.array(choice),
    label: z.string().optional(),
  }),
  description: "2-5 short mutually exclusive choices: a view switch, a mode.",
  component: ({ props, statementId }) => {
    const field = useStateField(useFieldName(props.label, statementId), props.value);
    const streaming = useIsStreaming();
    const choices = choiceList(props.options);
    const value = field.value == null ? "" : String(field.value);
    return (
      <Field label={props.label}>
        <div className={styles.segmented}>
          {choices.map((o, i) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: model-written values may repeat
              key={`${o.value}-${i}`}
              type="button"
              aria-pressed={o.value === value}
              disabled={streaming}
              className={cn(styles.segment, o.value === value && styles.segmentActive)}
              onClick={() => field.setValue(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </Field>
    );
  },
});

export const Checkbox = defineComponent({
  name: "Checkbox",
  props: z.object({
    checked: reactive(z.boolean()),
    label: z.string(),
    lineThrough: z.boolean().optional(),
  }),
  description: "lineThrough strikes the label when checked, for to-do and shopping lists.",
  component: ({ props, statementId }) => {
    const field = useStateField(useFieldName(props.label, statementId), props.checked);
    const streaming = useIsStreaming();
    const checked = field.value === true;
    return (
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={checked}
          disabled={streaming}
          onChange={(event) => field.setValue(event.target.checked)}
        />
        <span className={cn(checked && props.lineThrough && styles.lineThrough)}>
          {numberText(props.label)}
        </span>
      </label>
    );
  },
});

// ── Data ──────────────────────────────────────────────────────────────────

const NUMERIC = /^[-+−]?[$€£¥₹]?\s?\d[\d,]*(\.\d+)?\s?(%|[kKmMbB]|万|亿)?$/;

export const Table = defineComponent({
  name: "Table",
  props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.any())) }),
  description:
    "Each row lists its cells in column order; a cell may be a component. Number columns align right.",
  component: ({ props, renderNode }) => {
    const columns = Array.isArray(props.columns) ? props.columns.map((c) => numberText(c)) : [];
    const rows = (Array.isArray(props.rows) ? props.rows : []).filter(Array.isArray) as unknown[][];
    const numeric = columns.map((_, c) => {
      const cells = rows.map((r) => r[c]).filter((v) => v != null && v !== "");
      return (
        cells.length > 0 &&
        cells.every(
          (v) => typeof v === "number" || (typeof v === "string" && NUMERIC.test(v.trim())),
        )
      );
    });
    return (
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <th key={i} className={cn(numeric[i] && styles.numeric)}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
              <tr key={r}>
                {columns.map((_, c) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                  <td key={c} className={cn(numeric[c] && styles.numeric)}>
                    {isElement(row[c]) ? renderNode(row[c]) : numberText(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
});

const series = z.object({ name: z.string(), values: z.array(z.number()) });

export const Chart = defineComponent({
  name: "Chart",
  props: z.object({
    type: z.enum(["bar", "line", "pie"]),
    labels: z.array(z.string()),
    series: z.array(series),
    unit: z.string().optional(),
    height: z.number().optional(),
  }),
  description:
    "bar compares categories, line shows change over ordered labels, pie shows parts of one total (uses the first series). Each series has one value per label.",
  component: ({ props }) => {
    const labels = Array.isArray(props.labels) ? props.labels.map((l) => String(l ?? "")) : [];
    const data = (Array.isArray(props.series) ? props.series : [])
      .filter((s) => s && Array.isArray(s.values))
      .map((s) => ({
        name: String(s.name ?? ""),
        values: labels.map((_, i) => (Number.isFinite(s.values[i]) ? (s.values[i] as number) : 0)),
      }));
    if (labels.length === 0 || data.length === 0) return null;
    const height = props.height && props.height > 80 ? Math.min(props.height, 480) : 220;
    return props.type === "pie" ? (
      <PieChart labels={labels} values={data[0]?.values ?? []} unit={props.unit} />
    ) : (
      <BarLineChart
        kind={props.type}
        labels={labels}
        series={data}
        unit={props.unit}
        height={height}
      />
    );
  },
});

// ── Actions ───────────────────────────────────────────────────────────────

export const CopyToClipboard = defineAction({
  name: "CopyToClipboard",
  description: "Copy text to the clipboard, e.g. a list built with @Join",
  params: z.object({ text: z.string() }),
});

export const genUiComponents = [
  Col,
  Row,
  Card,
  Grid,
  Divider,
  Spacer,
  Title,
  Text,
  Caption,
  Badge,
  List,
  Stat,
  Progress,
  Icon,
  Button,
  Slider,
  Input,
  Select,
  SegmentedControl,
  Checkbox,
  Table,
  Chart,
];

export const genUiComponentGroups = [
  { name: "Layout", components: ["Col", "Row", "Card", "Grid", "Divider", "Spacer"] },
  {
    name: "Text",
    components: ["Title", "Text", "Caption", "Badge", "List", "Stat", "Progress", "Icon"],
  },
  {
    name: "Inputs",
    components: ["Button", "Slider", "Input", "Select", "SegmentedControl", "Checkbox"],
    notes: [
      "- An input's first argument is its value, usually a $variable other statements read: Slider($amount, 0, 100). Everything shown is computed from those $variables, so the answer works without another message.",
      "- No dead inputs: every input changes something shown.",
    ],
  },
  { name: "Data", components: ["Table", "Chart"] },
];
