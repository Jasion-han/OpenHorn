import { useEffect, useState } from "react";
import { type ClockBoundary, msUntilNextBoundary } from "../lib/clockBoundary";

/**
 * A `Date` that re-renders the caller when it crosses the given boundary.
 *
 * Use this instead of calling `new Date()` during render whenever the rendered
 * output depends on the reading — see lib/clockBoundary for why that goes wrong.
 */
export function useClockTick(boundary: ClockBoundary): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer = 0;
    // Rescheduled from inside the callback rather than by re-running this effect
    // on `now`: a boundary that resolves to the same rendered value must still
    // arm the next timer. Hanging the chain off state would let it stop there
    // and never tick again.
    const scheduleNext = () => {
      timer = window.setTimeout(
        () => {
          setNow(new Date());
          scheduleNext();
        },
        msUntilNextBoundary(new Date(), boundary),
      );
    };
    scheduleNext();
    return () => window.clearTimeout(timer);
  }, [boundary]);

  return now;
}
