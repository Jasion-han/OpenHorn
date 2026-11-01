import { describe, expect, test } from "bun:test";
import { evaluate, parseExpression, split, tokenize } from "@openuidev/lang-core";
import { createParser } from "@openuidev/react-lang";
import { genUiLibrary } from "../../components/chat/genui/library";
import { MORTGAGE_EXAMPLE } from "./mortgageExample";
import { computedStateNames } from "./stateCheck";

const schema = genUiLibrary.toJSONSchema();
const parsed = createParser(schema, "Col").parse(MORTGAGE_EXAMPLE);
const expressions = new Map(
  split(tokenize(MORTGAGE_EXAMPLE)).map((statement) => [
    statement.id,
    parseExpression(statement.tokens),
  ]),
);
const functions = Object.fromEntries(
  Object.entries(genUiLibrary.functions ?? {}).map(([name, fn]) => {
    const signature = schema.functions?.[name];
    if (!signature) throw new Error(`missing function schema ${name}`);
    return [name, { ...signature, fn: fn.fn }];
  }),
);

function calculate(amount: number, rate: number, years: number, mode: string) {
  const state = {
    ...parsed.stateDeclarations,
    $amount: amount,
    $rate: rate,
    $years: years,
    $mode: mode,
  };
  const errors: string[] = [];
  const ctx: Parameters<typeof evaluate>[1] = {
    getState: (name) => state[name as keyof typeof state],
    resolveRef: (name) => {
      const expression = expressions.get(name);
      if (!expression) throw new Error(`missing expression ${name}`);
      return evaluate(expression, ctx);
    },
    functions,
    reportError: (error) => errors.push(error),
  };
  const number = (name: string) => {
    const value = ctx.resolveRef(name);
    expect(typeof value).toBe("number");
    expect(Number.isFinite(value)).toBe(true);
    return value as number;
  };
  const result = {
    first: number("monthly"),
    last: number("lastPayment"),
    decrease: number("monthlyDecrease"),
    interest: number("interest"),
    total: number("total"),
  };
  expect(errors).toEqual([]);
  expect(state).toMatchObject({ $amount: amount, $rate: rate, $years: years, $mode: mode });
  return result;
}

/** Independent oracle: amortize each balance; solve fixed payment by bisection. */
function schedule(amount: number, annualRate: number, years: number, principalMode: boolean) {
  const n = years * 12;
  const rate = annualRate / 1200;
  const endingBalance = (payment: number) => {
    let balance = amount;
    for (let period = 0; period < n; period++) balance += balance * rate - payment;
    return balance;
  };
  let low = 0;
  let high = amount * (1 + rate);
  for (let iteration = 0; iteration < 100; iteration++) {
    const middle = (low + high) / 2;
    if (endingBalance(middle) > 0) low = middle;
    else high = middle;
  }
  const fixed = (low + high) / 2;
  let balance = amount;
  let interest = 0;
  let total = 0;
  const payments = [];
  for (let period = 0; period < n; period++) {
    const charged = balance * rate;
    const repaid = principalMode ? amount / n : fixed - charged;
    const payment = repaid + charged;
    payments.push(payment);
    interest += charged;
    total += payment;
    balance -= repaid;
  }
  expect(Math.abs(balance) < 0.00001).toBe(true);
  return {
    first: payments[0],
    last: payments.at(-1),
    decrease: principalMode ? payments[0] - payments[1] : 0,
    interest,
    total,
  };
}

describe("complete local mortgage calculator example", () => {
  test("parses completely with literal editable defaults and explicit local mode", () => {
    expect(parsed.meta.errors).toEqual([]);
    expect(parsed.meta.unresolved).toEqual([]);
    expect(parsed.meta.orphaned).toEqual([]);
    expect(parsed.meta.incomplete).toBe(false);
    expect(parsed.root !== null).toBe(true);
    expect(computedStateNames(MORTGAGE_EXAMPLE)).toEqual([]);
    expect(parsed.stateDeclarations).toEqual({
      $mode: "等额本息",
      $amount: 1000000,
      $rate: 3.5,
      $years: 30,
    });
  });

  for (const [amount, rate, years] of [
    [1000000, 3.5, 30],
    [100000, 0, 1],
    [100000, 0, 7],
    [100000, 3.5, 1],
    [5000000, 8, 40],
  ]) {
    for (const mode of ["等额本息", "等额本金"]) {
      test(`${amount}/${rate}%/${years} years ${mode} agrees with independent schedule`, () => {
        const actual = calculate(amount, rate, years, mode);
        const expected = schedule(amount, rate, years, mode === "等额本金");
        for (const key of ["first", "last", "decrease", "interest", "total"] as const) {
          expect(Math.abs(actual[key] - (expected[key] as number)) < 0.00001).toBe(true);
        }
        expect(Math.abs(actual.total - amount - actual.interest) < 0.000001).toBe(true);
        if (rate === 0) {
          expect(actual.interest).toBe(0);
          expect(actual.decrease).toBe(0);
          expect(actual.first).toBe(amount / (years * 12));
          expect(actual.last).toBe(actual.first);
        }
      });
    }
  }

  test("default visible results distinguish fixed monthly and declining first/last payments", () => {
    const fixed = calculate(1000000, 3.5, 30, "等额本息");
    const declining = calculate(1000000, 3.5, 30, "等额本金");
    expect(Math.round(fixed.first)).toBe(4490);
    expect(Math.round(fixed.interest)).toBe(616561);
    expect(Math.round(declining.first)).toBe(5694);
    expect(Math.round(declining.interest)).toBe(526458);
    expect(Math.round(declining.total)).toBe(1526458);
    expect(Math.abs(declining.last - 2785.87962962963) < 0.000001).toBe(true);
    expect(Math.abs(declining.decrease - 8.10185185185) < 0.000001).toBe(true);
    expect(MORTGAGE_EXAMPLE.includes('byPrincipal ? "首月还款" : "每月还款"')).toBe(true);
    expect(MORTGAGE_EXAMPLE.includes('Stat("末月还款"')).toBe(true);
    expect(MORTGAGE_EXAMPLE.includes('Stat("每月递减"')).toBe(true);
  });
});
