import { describe, expect, test } from "bun:test";
import { msUntilNextBoundary } from "./clockBoundary";

// Local time throughout: these boundaries are the ones a reader sees on a wall
// clock, not UTC ones.
const at = (y: number, m: number, d: number, h: number, min: number, s = 0, ms = 0) =>
  new Date(y, m - 1, d, h, min, s, ms);

describe("msUntilNextBoundary", () => {
  test("waits out the rest of the current hour", () => {
    const wait = msUntilNextBoundary(at(2026, 7, 29, 11, 10), "hour");
    expect(wait).toBe(50 * 60_000 + 1_000);
  });

  test("waits out the rest of the current day", () => {
    const wait = msUntilNextBoundary(at(2026, 7, 29, 11, 10), "day");
    expect(wait).toBe((12 * 60 + 50) * 60_000 + 1_000);
  });

  test("lands past the boundary, never exactly on it", () => {
    // Firing at :00:00.000 is the failure this guards: the recomputed reading
    // could still resolve to the old hour, and the next wake-up would be a full
    // period away.
    for (const boundary of ["hour", "day"] as const) {
      const now = at(2026, 7, 29, 23, 59, 59, 999);
      const landing = new Date(now.getTime() + msUntilNextBoundary(now, boundary));
      expect(landing.getTime() > new Date(2026, 6, 30).getTime()).toBe(true);
    }
  });

  test("never schedules a timer in the past or at zero", () => {
    // A zero-delay reschedule would spin the event loop instead of waiting.
    for (let hour = 0; hour < 24; hour += 1) {
      for (const minute of [0, 1, 30, 59]) {
        const now = at(2026, 7, 29, hour, minute);
        expect(msUntilNextBoundary(now, "hour") >= 1_000).toBe(true);
        expect(msUntilNextBoundary(now, "day") >= 1_000).toBe(true);
      }
    }
  });

  test("the day boundary is the next midnight, not now-plus-24h", () => {
    // The distinction only shows on a DST day, but pinning it here keeps anyone
    // from "simplifying" the calendar arithmetic back into a fixed offset.
    const now = at(2026, 7, 29, 11, 10);
    const landing = new Date(now.getTime() + msUntilNextBoundary(now, "day"));
    expect(landing.getDate()).toBe(30);
    expect(landing.getHours()).toBe(0);
  });

  test("an hour boundary at the end of the day rolls the date", () => {
    const now = at(2026, 7, 29, 23, 30);
    const landing = new Date(now.getTime() + msUntilNextBoundary(now, "hour"));
    expect(landing.getDate()).toBe(30);
    expect(landing.getHours()).toBe(0);
  });
});
