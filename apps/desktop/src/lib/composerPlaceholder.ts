/**
 * The one placeholder pool, shared by the welcome screen and the composer.
 * They are the same control in two places: two pools would drift in voice,
 * and a user who saw one style on arrival and another a moment later would
 * read it as two different products.
 *
 * English on purpose. Mixing it with the Chinese chrome around it reads as an
 * untranslated string rather than as a choice, so the copy commits to one
 * language throughout — deliberately, not by omission.
 */
export const COMPOSER_PLACEHOLDERS = [
  "Start with a spark — I will shape the rest.",
  "What should we build, refine, or rethink today?",
  "Drop a thought. I will turn it into something real.",
  "Give me a direction, I will find the path.",
  "Ask anything. Then push it one level deeper.",
  "Sketch the idea. I will fill in the lines.",
  "Let us turn a question into a plan.",
  "Pitch the headline. I will write the story.",
  "Take the blank page. I will bring the motion.",
  "Name the problem. I will cut through it.",
  "Start messy. End elegant.",
  "One prompt away from clarity.",
  "Tell me the goal, I will map the route.",
  "What would you love to ship this week?",
  "Let us turn curiosity into momentum.",
  "If you can imagine it, we can draft it.",
  "Give me the vibe. I will deliver the words.",
  "Turn a rough idea into a sharp answer.",
  "Ask for bold. I will keep it grounded.",
  "What do you wish existed right now?",
  "We can brainstorm or go straight to done.",
  "Write less. Say more.",
  "A single line can unlock the whole plan.",
  "Let us design the next move.",
  "Bring the question. Leave with the output.",
  "Make it clear, make it quick, make it real.",
  "Want a first draft that actually works?",
  "Turn complexity into clean steps.",
  "Take a breath — then type the dream.",
  "If it matters, put it here.",
] as const;

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

/**
 * Roughly double-width characters: CJK, kana, Hangul, and the fullwidth forms.
 * Only used to pace an animation, so the boundary cases (rare fullwidth
 * punctuation, emoji) costing one tick too many or too few is not worth a
 * proper width table.
 */
const WIDE_CHAR = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

/**
 * How long one character of the typewriter should take.
 *
 * A per-character constant makes the *visual* speed depend on the script: a CJK
 * glyph is about twice as wide as a Latin one, so at a fixed ms/char a Chinese
 * line grows across the box twice as fast as an English one. The two composers
 * draw from pools in different languages, and side by side that read as one of
 * them being broken. Pacing by width instead of by count makes them match.
 */
export function tickMsFor(char: string, baseMs: number): number {
  return WIDE_CHAR.test(char) ? baseMs : Math.round(baseMs / 2);
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
