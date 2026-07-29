import { describe, expect, test } from "bun:test";
import { getChatLabel } from "./i18n/agent";
import { welcomeTitleKeyFor } from "./welcomeHero";

describe("welcomeTitleKeyFor", () => {
  test("covers the whole day with no gap and no overlap", () => {
    const seen = new Set<string>();
    for (let hour = 0; hour < 24; hour += 1) seen.add(welcomeTitleKeyFor(hour));
    expect(seen.size).toBe(5);
  });

  test("no phrase has to stretch across more than a few hours", () => {
    // The bug this replaces: one line owned 5am–11am, so "the day just broke"
    // was still on screen at 11. Six hours is the widest a single mood can sit
    // without going stale on someone who left the window open.
    const spans = new Map<string, number>();
    for (let hour = 0; hour < 24; hour += 1) {
      const key = welcomeTitleKeyFor(hour);
      spans.set(key, (spans.get(key) ?? 0) + 1);
    }
    for (const hours of spans.values()) expect(hours <= 6).toBe(true);
  });

  test("boundaries land on the later phrase, not the earlier one", () => {
    // Off-by-one here is the whole risk: noon must already read as afternoon,
    // and midnight as the small hours rather than as morning.
    expect(welcomeTitleKeyFor(0)).toBe("chat.welcome.title.lateNight");
    expect(welcomeTitleKeyFor(4)).toBe("chat.welcome.title.lateNight");
    expect(welcomeTitleKeyFor(5)).toBe("chat.welcome.title.morning");
    expect(welcomeTitleKeyFor(8)).toBe("chat.welcome.title.morning");
    expect(welcomeTitleKeyFor(9)).toBe("chat.welcome.title.forenoon");
    expect(welcomeTitleKeyFor(11)).toBe("chat.welcome.title.forenoon");
    expect(welcomeTitleKeyFor(12)).toBe("chat.welcome.title.afternoon");
    expect(welcomeTitleKeyFor(17)).toBe("chat.welcome.title.afternoon");
    expect(welcomeTitleKeyFor(18)).toBe("chat.welcome.title.evening");
    expect(welcomeTitleKeyFor(23)).toBe("chat.welcome.title.evening");
  });

  test("every hour resolves to real copy in the dictionary", () => {
    // The keys are a hand-written union; a typo would only surface at runtime as
    // an undefined label, which renders as a blank hero.
    for (let hour = 0; hour < 24; hour += 1) {
      const copy = getChatLabel(welcomeTitleKeyFor(hour));
      expect(typeof copy === "string" && copy.length > 0).toBe(true);
    }
  });

  test("the line starts mid-sentence so the name can lead it", () => {
    // Rendered as `${name}，${line}`. A line opening with its own greeting would
    // read as two sentences jammed together.
    for (let hour = 0; hour < 24; hour += 1) {
      const copy = getChatLabel(welcomeTitleKeyFor(hour));
      expect(copy.startsWith("你好") || copy.startsWith("欢迎")).toBe(false);
    }
  });
});
