import { describe, expect, test } from "bun:test";
import { shouldRefreshOnFocus } from "./useRefreshOnFocus";

const base = {
  now: 10_000,
  lastRefreshAt: null as number | null,
  isStreaming: false,
  authReady: true,
  minIntervalMs: 3000,
};

describe("shouldRefreshOnFocus", () => {
  test("first call (lastRefreshAt null) refreshes", () => {
    expect(shouldRefreshOnFocus(base)).toBe(true);
  });

  test("within minIntervalMs is throttled", () => {
    expect(shouldRefreshOnFocus({ ...base, lastRefreshAt: 8_000 })).toBe(false);
    expect(shouldRefreshOnFocus({ ...base, lastRefreshAt: 7_001 })).toBe(false);
  });

  test("after minIntervalMs refreshes again", () => {
    expect(shouldRefreshOnFocus({ ...base, lastRefreshAt: 7_000 })).toBe(true);
    expect(shouldRefreshOnFocus({ ...base, lastRefreshAt: 0 })).toBe(true);
  });

  test("never refreshes while streaming", () => {
    expect(shouldRefreshOnFocus({ ...base, isStreaming: true })).toBe(false);
  });

  test("skips when auth is not ready", () => {
    expect(shouldRefreshOnFocus({ ...base, authReady: false })).toBe(false);
  });
});
