/**
 * How long until the wall clock crosses the next hour or day.
 *
 * Anything picked from the clock during render — a greeting keyed to the hour, a
 * "today"/"yesterday" grouping — is really showing the time of the *last render*,
 * not the current time. A window left open drifts silently: nothing is stale
 * enough to look broken, so nobody refreshes, so it stays wrong.
 *
 * Waiting for the boundary rather than polling means a re-render happens only at
 * the one moment the displayed value can actually change.
 */
export type ClockBoundary = "hour" | "day";

// Timers fire a hair early, and the system clock can be nudged backwards by NTP.
// Landing a second past the boundary keeps the recomputed value on the new side
// of it; without this, a wake-up at 23:59:59.998 would re-render "yesterday" and
// then wait another full day to correct itself.
const SETTLE_MS = 1_000;

export function msUntilNextBoundary(now: Date, boundary: ClockBoundary): number {
  // Built from local calendar fields rather than by adding milliseconds, so DST
  // shifts land on the real next boundary — on a spring-forward day, "tomorrow
  // at midnight" is 23 hours away, not 24.
  const next =
    boundary === "day"
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1);

  // A DST transition can make the constructed boundary land on or before `now`.
  // Falling back to a short delay retries rather than scheduling a timer in the
  // past, which would spin.
  return Math.max(SETTLE_MS, next.getTime() - now.getTime() + SETTLE_MS);
}
