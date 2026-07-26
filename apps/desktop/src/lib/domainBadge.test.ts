import { describe, expect, test } from "bun:test";
import { getDomainBadge } from "./domainBadge";

describe("getDomainBadge", () => {
  test("uses the first letter of the hostname", () => {
    expect(getDomainBadge("example.com").letter).toBe("E");
    expect(getDomainBadge("github.com").letter).toBe("G");
  });

  test("ignores a leading www.", () => {
    expect(getDomainBadge("www.example.com").letter).toBe("E");
  });

  // The badge replaces a favicon, so it must look the same every time the same
  // site appears — across messages and across restarts.
  test("the same hostname always maps to the same hue", () => {
    const a = getDomainBadge("example.com");
    const b = getDomainBadge("example.com");
    expect(a.hue).toBe(b.hue);
    expect(a.letter).toBe(b.letter);
  });

  test("www. and bare hostname share one identity", () => {
    expect(getDomainBadge("www.example.com").hue).toBe(getDomainBadge("example.com").hue);
  });

  test("different hostnames generally get different hues", () => {
    const hues = new Set(
      ["example.com", "github.com", "anthropic.com", "openai.com", "wikipedia.org"].map(
        (h) => getDomainBadge(h).hue,
      ),
    );
    // Collisions are possible in principle; 5 distinct hosts should not all clash.
    expect(hues.size > 1).toBe(true);
  });

  test("hue stays within the valid range", () => {
    for (const host of ["a.io", "zzz.example", "1.2.3.4", "sub.domain.co.uk"]) {
      const { hue } = getDomainBadge(host);
      expect(hue >= 0 && hue < 360).toBe(true);
    }
  });

  test("is case-insensitive", () => {
    expect(getDomainBadge("EXAMPLE.com").hue).toBe(getDomainBadge("example.com").hue);
    expect(getDomainBadge("EXAMPLE.com").letter).toBe("E");
  });

  test("falls back to ? when there is no alphanumeric character", () => {
    expect(getDomainBadge("").letter).toBe("?");
    expect(getDomainBadge("---").letter).toBe("?");
  });

  test("handles a hostname that starts with a digit", () => {
    expect(getDomainBadge("1.2.3.4").letter).toBe("1");
  });

  // The badge carries white text. Yellow/green read much lighter than blue at
  // the same HSL lightness, so that band must come back darker or the letter
  // becomes unreadable — caught by looking at a rendered preview, not by types.
  test("yellow-green hues get a darker lightness than the rest", () => {
    // Reach the real values through hostnames that land in each band.
    const hn = getDomainBadge("news.ycombinator.com");
    const an = getDomainBadge("anthropic.com");
    expect(hn.hue >= 45 && hn.hue <= 195).toBe(true);
    expect(an.hue < 45 || an.hue > 195).toBe(true);
    expect(hn.lightness < an.lightness).toBe(true);
  });

  test("lightness is always in a sane range", () => {
    for (const host of ["a.io", "github.com", "wikipedia.org", "openai.com", "1.2.3.4"]) {
      const { lightness } = getDomainBadge(host);
      expect(lightness >= 25 && lightness <= 55).toBe(true);
    }
  });
});
