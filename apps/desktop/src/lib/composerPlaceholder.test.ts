import { describe, expect, test } from "bun:test";
import { pickPlaceholder } from "./composerPlaceholder";

const POOL = ["a", "b", "c"];

describe("pickPlaceholder", () => {
  test("an empty pool yields an empty string rather than undefined", () => {
    expect(pickPlaceholder([])).toBe("");
  });

  test("a single-entry pool always yields that entry, even when it is the one to avoid", () => {
    expect(pickPlaceholder(["only"], "only")).toBe("only");
  });

  test("every draw comes from the pool", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(POOL.includes(pickPlaceholder(POOL))).toBe(true);
    }
  });

  test("draws move away from the previous value", () => {
    // Not "never repeats" — the retry is bounded, so a repeat is possible. What
    // must hold is that avoiding actually happens rather than being a no-op.
    let differed = 0;
    for (let i = 0; i < 50; i += 1) {
      if (pickPlaceholder(POOL, "a") !== "a") differed += 1;
    }
    expect(differed > 0).toBe(true);
  });
});
