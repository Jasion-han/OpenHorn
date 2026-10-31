import { describe, expect, test } from "bun:test";
import { resolveAgentLiveIndicator, resolveBubbleEndLabel } from "./DesktopMessageBubble";

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

  test("hides the indicator once steps are recorded (timeline takes over)", () => {
    expect(resolveAgentLiveIndicator({ ...base, stepCount: 1 })).toBe("none");
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

describe("resolveBubbleEndLabel", () => {
  type ReplyInput = Parameters<typeof resolveBubbleEndLabel>[0]["message"];
  const reply: ReplyInput = { role: "assistant", content: "" };
  const label = (message: Partial<ReplyInput>, isStreaming = false) =>
    resolveBubbleEndLabel({ message: { ...reply, ...message }, isStreaming });

  test("a finished empty reply without a run says so instead of rendering blank", () => {
    expect(label({})).toBe("chat.reply.empty");
  });

  test("a stopped chat reply keeps its stopped state after a reload", () => {
    expect(label({ content: "half an answer", finishReason: "stopped" })).toBe(
      "chat.agent.stopped",
    );
    expect(label({ finishReason: "stopped" })).toBe("chat.agent.cancelled");
  });

  test("nothing for a finished reply, while streaming, with a run, or for users", () => {
    expect(label({ content: "answer" })).toBe(null);
    expect(label({}, true)).toBe(null);
    expect(label({ agentRun: { status: "cancelled", summary: "", steps: [] } })).toBe(null);
    expect(label({ role: "user" })).toBe(null);
  });
});
