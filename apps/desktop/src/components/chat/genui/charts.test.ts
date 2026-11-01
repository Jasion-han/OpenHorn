import { describe, expect, test } from "bun:test";
import { niceTicks } from "./charts";

describe("finite chart domains", () => {
  for (const [min, max] of [
    [-42, 86],
    [-1e308, 1e308],
    [0, Number.MAX_VALUE],
    [-Number.MAX_VALUE, 0],
    [0, Number.MIN_VALUE],
    [-Number.MIN_VALUE, Number.MIN_VALUE],
  ]) {
    test(`ticks cover ${min}..${max} without overflowing or underflowing`, () => {
      const ticks = niceTicks(min, max);
      expect(ticks.length > 1).toBe(true);
      expect(ticks.length < 20).toBe(true);
      expect(ticks.every(Number.isFinite)).toBe(true);
      expect(ticks[0] <= Math.min(0, min)).toBe(true);
      expect(ticks[ticks.length - 1] >= Math.max(0, max)).toBe(true);
      expect(ticks.includes(0)).toBe(true);
      expect(ticks.every((tick, index) => index === 0 || tick > ticks[index - 1])).toBe(true);
    });
  }
  test("a zero-only chart has a finite baseline", () => {
    expect(niceTicks(0, 0)).toEqual([0]);
  });
});
