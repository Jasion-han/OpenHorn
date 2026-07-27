import { describe, expect, test } from "bun:test";
import { resolveAgentLiveIndicator } from "./DesktopMessageBubble";

const base = {
  isAgentAssistant: true,
  isStreaming: true,
  hasText: false,
  stepCount: 0,
};

describe("resolveAgentLiveIndicator", () => {
  test("shows the leading placeholder before any output exists", () => {
    expect(resolveAgentLiveIndicator(base)).toBe("leading");
  });

  test("switches to the trailing indicator once text starts arriving", () => {
    expect(resolveAgentLiveIndicator({ ...base, hasText: true })).toBe("trailing");
  });

  test("switches to the trailing indicator once a step is recorded", () => {
    expect(resolveAgentLiveIndicator({ ...base, stepCount: 1 })).toBe("trailing");
  });

  test("never returns both — leading and trailing are mutually exclusive", () => {
    const cases = [
      base,
      { ...base, hasText: true },
      { ...base, stepCount: 3 },
      { ...base, hasText: true, stepCount: 3 },
    ];
    for (const input of cases) {
      const result = resolveAgentLiveIndicator(input);
      // A single return value cannot be two states at once; assert it is always
      // one of the three known ones so a future refactor cannot smuggle in a mix.
      expect(["leading", "trailing", "none"].includes(result)).toBe(true);
    }
  });

  test("shows nothing once streaming has stopped", () => {
    expect(resolveAgentLiveIndicator({ ...base, isStreaming: false })).toBe("none");
    expect(resolveAgentLiveIndicator({ ...base, isStreaming: false, hasText: true })).toBe("none");
  });

  test("shows nothing for chat-mode answers", () => {
    expect(resolveAgentLiveIndicator({ ...base, isAgentAssistant: false })).toBe("none");
  });
});
