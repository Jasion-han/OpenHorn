import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONVERSATION_TITLE,
  displayConversationTitle,
  formatConversationTime,
  formatMessageTime,
  isDefaultConversationTitle,
} from "./conversationTitle";

describe("displayConversationTitle", () => {
  test("strips the legacy MM-DD HH:mm suffix", () => {
    expect(displayConversationTitle("Claude SDK用法 07-07 13:28")).toBe("Claude SDK用法");
  });

  test("strips the suffix from the default title", () => {
    expect(displayConversationTitle("新会话 07-07 13:28")).toBe("新会话");
  });

  test("leaves clean titles untouched", () => {
    expect(displayConversationTitle("Claude SDK用法")).toBe("Claude SDK用法");
  });

  test("does not strip a bare time that is not the full suffix", () => {
    expect(displayConversationTitle("会议 13:28")).toBe("会议 13:28");
  });

  test("falls back to the original when stripping would empty the title", () => {
    expect(displayConversationTitle("07-07 13:28")).toBe("07-07 13:28");
  });
});

describe("isDefaultConversationTitle", () => {
  test("matches the new bare default title", () => {
    expect(isDefaultConversationTitle(DEFAULT_CONVERSATION_TITLE)).toBe(true);
  });

  test("matches the legacy timestamped default title", () => {
    expect(isDefaultConversationTitle("新会话 07-07 13:28")).toBe(true);
  });

  test("does not match a real title", () => {
    expect(isDefaultConversationTitle("Claude SDK用法")).toBe(false);
  });

  test("does not match a title that merely starts with 新会话", () => {
    expect(isDefaultConversationTitle("新会话记录 07-07 13:28")).toBe(false);
  });
});

describe("formatConversationTime", () => {
  test("formats as YYYY-MM-DD HH:mm", () => {
    expect(formatConversationTime(new Date(2026, 2, 5, 9, 7))).toBe("2026-03-05 09:07");
  });
});

describe("formatMessageTime", () => {
  test("formats as YYYY-MM-DD HH:mm", () => {
    expect(formatMessageTime(new Date(2026, 2, 5, 9, 7))).toBe("2026-03-05 09:07");
  });

  test("handles midnight", () => {
    expect(formatMessageTime(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01 00:00");
  });

  test("handles afternoon time", () => {
    expect(formatMessageTime(new Date(2026, 6, 7, 13, 27))).toBe("2026-07-07 13:27");
  });

  // A malformed createdAt would otherwise render as "NaN-NaN-NaN NaN:NaN".
  test("returns an empty string for an invalid date", () => {
    expect(formatMessageTime(new Date("not a date"))).toBe("");
  });
});
