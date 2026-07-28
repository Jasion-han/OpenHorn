import { useCallback, useEffect, useState } from "react";
import { charCount, pickPlaceholder, takeChars, tickMsFor } from "../lib/composerPlaceholder";

/**
 * The placeholder types itself in, rests, rewinds character by character, and
 * types the *same* line again. Only a click on the box draws a different one —
 * a line that swapped itself out on a timer would read as a slideshow demanding
 * attention rather than as an idle input.
 *
 * Erasing runs faster than typing: a rewind that takes as long as the write
 * feels like a mistake being corrected instead of a loop resetting.
 */
const TYPE_MS = 42;
const ERASE_MS = 26;
/** Long enough to actually read the line before it starts rewinding. */
const HOLD_MS = 2400;
/** Beat on the empty box, so the restart reads as deliberate. */
const REST_MS = 700;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Drives the composer placeholder animation. Shared by the welcome screen and
 * the in-conversation composer so the two cannot drift — they are the same
 * control in two places, and a user who sees one animate reads the other
 * standing still as a glitch.
 *
 * `paused` is the "box has text in it" signal: the placeholder is invisible
 * then, so running the loop would re-render on every tick for nothing.
 */
export function usePlaceholderTypewriter(pool: readonly string[], paused: boolean) {
  // `draw` counts the redraws: it makes each draw a distinct value even when the
  // same line comes up twice, so the effect below always replays.
  const [placeholder, setPlaceholder] = useState(() => ({
    text: pickPlaceholder(pool),
    draw: 0,
  }));
  const [revealed, setRevealed] = useState(0);
  const [erasing, setErasing] = useState(false);

  // The type → hold → rewind → restart loop. Each step schedules exactly one
  // timeout and then re-enters through its own state change, so there is no
  // interval to leak and no state updater doing side effects (they must stay
  // pure — React may call them twice).
  useEffect(() => {
    const total = charCount(placeholder.text);
    if (prefersReducedMotion()) {
      // A perpetual animation is exactly what this preference asks to be spared:
      // show the line, leave it alone.
      setRevealed(total);
      return;
    }
    if (paused) return;

    // Paced by the character actually being drawn (or rubbed out), not by a flat
    // per-character constant — see tickMsFor.
    const chars = Array.from(placeholder.text);
    const typing = chars[revealed] ?? "";
    const erasingChar = chars[revealed - 1] ?? "";

    const step = erasing
      ? revealed > 0
        ? { delay: tickMsFor(erasingChar, ERASE_MS), run: () => setRevealed((n) => n - 1) }
        : { delay: REST_MS, run: () => setErasing(false) }
      : revealed < total
        ? { delay: tickMsFor(typing, TYPE_MS), run: () => setRevealed((n) => n + 1) }
        : { delay: HOLD_MS, run: () => setErasing(true) };

    const timer = window.setTimeout(step.run, step.delay);
    return () => window.clearTimeout(timer);
  }, [placeholder, revealed, erasing, paused]);

  /**
   * Swaps in a different line and restarts the loop from an empty box.
   *
   * Deliberately unguarded: "clear the box" calls this in the same tick as the
   * state update that empties it, so `paused` is still true here and a guard
   * would swallow exactly the redraw that matters. Callers that only want to
   * redraw an already-empty box check for themselves.
   */
  const reroll = useCallback(() => {
    setPlaceholder((prev) => ({
      text: pickPlaceholder(pool, prev.text),
      draw: prev.draw + 1,
    }));
    setRevealed(0);
    setErasing(false);
  }, [pool]);

  return { text: takeChars(placeholder.text, revealed), reroll };
}
