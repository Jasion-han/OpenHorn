import { defineFunction } from "@openuidev/react-lang";
import { z } from "zod";

/**
 * Generic @functions next to the OpenUI 1.0 built-ins (@Count, @Sum, @Round,
 * @Filter, @Each, ...), so an answer can compute with its own $variables
 * instead of asking the model again. Shapes follow thesysdev/open-intelligent-ui
 * (MIT) so prompts written for it carry over. A thrown error makes the call
 * evaluate to null, as with the built-ins.
 */

const MAX_ITEMS = 10000;
const list = () => z.array(z.any());

/** Equality by value; a number matches its string form (ids from inputs are often strings). */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    (typeof a === "number" && typeof b === "string") ||
    (typeof a === "string" && typeof b === "number")
  ) {
    return String(a) === String(b);
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((x, i) => same(x, other[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) =>
        Object.hasOwn(b, k) &&
        same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error("result is not a finite number");
  return value;
}

export const Append = defineFunction({
  name: "Append",
  description: "Copy of the list with item added at the end",
  params: z.object({ list: list(), item: z.any() }),
  returns: list(),
  fn: ({ list, item }) => {
    if (list.length >= MAX_ITEMS) throw new Error(`more than ${MAX_ITEMS} items`);
    return [...list, item];
  },
});

export const Remove = defineFunction({
  name: "Remove",
  description:
    'Copy without the items whose field equals value; field "" compares the items themselves',
  params: z.object({ list: list(), field: z.string(), value: z.any() }),
  returns: list(),
  fn: ({ list, field, value }) =>
    list.filter((item) => {
      const read = field ? (item as Record<string, unknown> | null)?.[field] : item;
      return !same(read, value);
    }),
});

export const Toggle = defineFunction({
  name: "Toggle",
  description: "Adds item if missing, removes it if present (a set of strings or numbers)",
  params: z.object({ list: list(), item: z.any() }),
  returns: list(),
  fn: ({ list, item }) =>
    list.some((x) => same(x, item)) ? list.filter((x) => !same(x, item)) : [...list, item],
});

export const Includes = defineFunction({
  name: "Includes",
  description: "True if the list has item, or the text contains it",
  params: z.object({ list: z.union([list(), z.string()]), item: z.any() }),
  returns: z.boolean(),
  fn: ({ list, item }) =>
    typeof list === "string"
      ? item != null && list.includes(String(item))
      : list.some((x) => same(x, item)),
});

export const Range = defineFunction({
  name: "Range",
  description:
    "Numbers from start up to end (not included) by step (default 1), e.g. @Range(0, 3) is [0, 1, 2]",
  params: z.object({ start: z.number(), end: z.number(), step: z.number().optional() }),
  returns: z.array(z.number()),
  fn: ({ start, end, step = 1 }) => {
    if (step === 0 || !Number.isFinite(step)) throw new Error("step must be a non-zero number");
    const count = Math.max(0, Math.ceil((end - start) / step));
    if (count > MAX_ITEMS) throw new Error(`more than ${MAX_ITEMS} items`);
    const whole = Number.isInteger(start) && Number.isInteger(step);
    return Array.from({ length: count }, (_, i) =>
      whole ? start + i * step : Number((start + i * step).toPrecision(12)),
    );
  },
});

export const Clamp = defineFunction({
  name: "Clamp",
  description: "value limited to the range min..max",
  params: z.object({ value: z.number(), min: z.number(), max: z.number() }),
  returns: z.number(),
  fn: ({ value, min, max }) => finite(Math.min(Math.max(value, min), max)),
});

export const Pow = defineFunction({
  name: "Pow",
  description: "base raised to exponent, e.g. compound growth @Pow(1 + $rate / 100, $years)",
  params: z.object({ base: z.number(), exponent: z.number() }),
  returns: z.number(),
  fn: ({ base, exponent }) => finite(base ** exponent),
});

export const Percent = defineFunction({
  name: "Percent",
  description: "part as a percentage of whole (0-100), rounded to decimals (default 0)",
  params: z.object({ part: z.number(), whole: z.number(), decimals: z.number().optional() }),
  returns: z.number(),
  fn: ({ part, whole, decimals = 0 }) => {
    if (whole === 0) throw new Error("whole is zero");
    const factor = 10 ** Math.min(Math.max(Math.trunc(decimals), 0), 6);
    return finite(Math.round((part / whole) * 100 * factor) / factor);
  },
});

export const Payment = defineFunction({
  name: "Payment",
  description:
    "Fixed periodic payment of a loan: principal, annual rate in percent, number of periods per year times years",
  params: z.object({
    principal: z.number(),
    annualRatePercent: z.number(),
    periods: z.number(),
    periodsPerYear: z.number().optional(),
  }),
  returns: z.number(),
  fn: ({ principal, annualRatePercent, periods, periodsPerYear = 12 }) => {
    if (periods <= 0) throw new Error("periods must be positive");
    const r = annualRatePercent / 100 / periodsPerYear;
    if (r === 0) return finite(principal / periods);
    return finite((principal * r) / (1 - (1 + r) ** -periods));
  },
});

function currencyCode(code: string | undefined): string {
  const upper = (code ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : "CNY";
}

export const Format = defineFunction({
  name: "Format",
  description:
    'Number as text: "number" 12,345.6, "currency" ¥12,345.68 (currency is a code like "USD", default CNY), "percent" 45 -> 45%, "compact" 1.2万',
  params: z.object({
    value: z.number(),
    kind: z.enum(["number", "currency", "percent", "compact"]).optional(),
    decimals: z.number().optional(),
    currency: z.string().optional(),
  }),
  returns: z.string(),
  fn: ({ value, kind = "number", decimals, currency }) => {
    if (!Number.isFinite(value)) throw new Error("value is not a finite number");
    const d = decimals === undefined ? undefined : Math.min(Math.max(Math.trunc(decimals), 0), 10);
    const digits = (max: number, min = 0) =>
      d === undefined
        ? { minimumFractionDigits: min, maximumFractionDigits: max }
        : { minimumFractionDigits: Math.min(min, d), maximumFractionDigits: d };
    const format = (n: number, options: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("zh-CN", options).format(n);
    switch (kind) {
      case "currency":
        return format(value, {
          style: "currency",
          currency: currencyCode(currency),
          ...digits(2, 2),
        });
      case "percent":
        return `${format(value, digits(1))}%`;
      case "compact":
        return format(value, { notation: "compact", ...digits(1) });
      default:
        return format(value, digits(2));
    }
  },
});

export const Join = defineFunction({
  name: "Join",
  description: 'Joins the items into text with sep (default ", "), skipping nulls',
  params: z.object({ list: list(), sep: z.string().optional() }),
  returns: z.string(),
  fn: ({ list, sep = ", " }) =>
    list
      .filter((x) => x != null && x !== "")
      .map(String)
      .join(sep),
});

export const genUiFunctions = [
  Append,
  Remove,
  Toggle,
  Includes,
  Range,
  Clamp,
  Pow,
  Percent,
  Payment,
  Format,
  Join,
];
