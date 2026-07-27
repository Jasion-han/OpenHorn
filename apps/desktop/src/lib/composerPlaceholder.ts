/**
 * Picks a placeholder at random from `pool`, preferring one different from
 * `avoid` so two consecutive draws rarely look like nothing changed.
 *
 * The retry is bounded rather than exhaustive: with a pool of any real size the
 * odds of four collisions are negligible, and a repeat is cosmetic, not a bug.
 */
/**
 * Character count and prefix used by the typewriter reveal.
 *
 * Both go through `Array.from` rather than `.length`/`.slice`, which count UTF-16
 * code units: an emoji in a placeholder would be revealed as half a surrogate
 * pair and render as a replacement glyph for one frame.
 */
export function charCount(text: string): number {
  return Array.from(text).length;
}

export function takeChars(text: string, count: number): string {
  if (count <= 0) return "";
  return Array.from(text).slice(0, count).join("");
}

export function pickPlaceholder(pool: readonly string[], avoid?: string): string {
  if (pool.length === 0) return "";
  if (pool.length === 1) return pool[0] ?? "";
  let next = pool[Math.floor(Math.random() * pool.length)] ?? "";
  let tries = 0;
  while (avoid && next === avoid && tries < 4) {
    next = pool[Math.floor(Math.random() * pool.length)] ?? next;
    tries += 1;
  }
  return next;
}
