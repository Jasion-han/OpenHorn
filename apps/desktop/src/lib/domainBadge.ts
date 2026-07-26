/**
 * Locally-derived stand-in for a site favicon.
 *
 * Link icons used to be fetched from `google.com/s2/favicons?domain=<host>`,
 * which handed Google the hostname of every link that ever appeared in a
 * conversation — including internal and private ones, and including links the
 * user never clicked. For a local-first desktop app that is the wrong trade for
 * a 16px decoration, so the badge is now computed on-device: no request leaves
 * the machine, and nothing about the conversation is disclosed.
 *
 * The colour is derived from the hostname so a given site keeps a stable,
 * recognisable badge across messages and restarts.
 */

export interface DomainBadge {
  /** Single uppercase character shown inside the badge. */
  letter: string;
  /** Hue in [0, 360) derived from the hostname. */
  hue: number;
  /** Lightness percentage to pair with `hue`, tuned so white text stays legible. */
  lightness: number;
}

/**
 * Perceived brightness is far from uniform across hues: yellow and green read
 * much lighter than blue or magenta at the same HSL lightness, and white text
 * on them becomes hard to read. Darken that band so every badge keeps usable
 * contrast against its white letter.
 */
function lightnessForHue(hue: number): number {
  const isBrightBand = hue >= 45 && hue <= 195;
  return isBrightBand ? 32 : 45;
}

/** Strips a leading `www.` so `www.example.com` and `example.com` match. */
function stripWww(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

/**
 * FNV-1a. Chosen for being tiny and stable across runs — the exact hash does
 * not matter, only that the same hostname always maps to the same hue.
 */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function getDomainBadge(hostname: string): DomainBadge {
  const host = stripWww((hostname || "").trim().toLowerCase());
  // Use the first alphanumeric character; punycode/odd hosts fall back to "?".
  const match = host.match(/[a-z0-9]/);
  const letter = (match?.[0] ?? "?").toUpperCase();
  const hue = hashString(host) % 360;
  return { letter, hue, lightness: lightnessForHue(hue) };
}
