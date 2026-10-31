import { describe, expect, test } from "bun:test";
import { buildClaudeInitialMessages } from "./claude";
import { buildHistoryMessages, truncateHistory } from "./context";
import { buildModel, toPiHistoryMessages } from "./direct";

describe("buildHistoryMessages", () => {
  test("keeps a normal alternating history and leaves the prompt alone", () => {
    const result = buildHistoryMessages(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "how are you" },
        { role: "assistant", content: "fine" },
      ],
      "next question",
    );
    expect(result).toEqual({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "how are you" },
        { role: "assistant", content: "fine" },
      ],
      prompt: "next question",
    });
  });

  test("merges adjacent same-role messages with a blank line", () => {
    const result = buildHistoryMessages(
      [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" },
        { role: "assistant", content: "d" },
      ],
      "q",
    );
    expect(result.messages).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c\n\nd" },
    ]);
    expect(result.prompt).toBe("q");
  });

  test("drops empty entries before merging", () => {
    const result = buildHistoryMessages(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "   " },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" },
      ],
      "q",
    );
    expect(result.messages).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c" },
    ]);
  });

  test("drops leading assistant messages", () => {
    const result = buildHistoryMessages(
      [
        { role: "assistant", content: "orphan" },
        { role: "assistant", content: "orphan 2" },
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
      ],
      "q",
    );
    expect(result.messages).toEqual([
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ]);
  });

  test("merges a trailing user message into the current prompt", () => {
    const result = buildHistoryMessages(
      [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "unanswered" },
      ],
      "q",
    );
    expect(result).toEqual({
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
      prompt: "unanswered\n\nq",
    });
  });

  test("keeps the truncation marker as the opening user turn", () => {
    const long = "x".repeat(100);
    const truncated = truncateHistory(
      [
        { role: "user", content: long },
        { role: "assistant", content: long },
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
      ],
      40,
    );
    const result = buildHistoryMessages(truncated, "q");
    expect(result.messages).toEqual([
      { role: "user", content: "[2 earlier messages omitted]\n\nu" },
      { role: "assistant", content: "a" },
    ]);
  });

  test("empty or missing history yields no messages", () => {
    expect(buildHistoryMessages([], "q")).toEqual({ messages: [], prompt: "q" });
    expect(buildHistoryMessages(undefined, "q")).toEqual({ messages: [], prompt: "q" });
  });

  test("does not mutate the input history", () => {
    const history = [
      { role: "user" as const, content: "a" },
      { role: "user" as const, content: "b" },
    ];
    buildHistoryMessages(history, "q");
    expect(history).toEqual([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);
  });
});

describe("buildClaudeInitialMessages", () => {
  const history = [
    { role: "user" as const, content: "u1" },
    { role: "assistant" as const, content: "a1" },
  ];

  test("history precedes the current prompt as the final user message", () => {
    expect(buildClaudeInitialMessages(history, "q", [])).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q" },
    ]);
  });

  test("current prompt with images stays a multi-block message", () => {
    const messages = buildClaudeInitialMessages(history, "look", [
      { mediaType: "image/png", dataBase64: "AAAA" },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    });
  });
});

describe("toPiHistoryMessages", () => {
  test("maps history to pi user/assistant transcript messages", () => {
    const model = buildModel({ apiKey: "k", model: "gpt-4o" } as never, false);
    const messages = toPiHistoryMessages(
      [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
      model,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "u1" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "a1" }],
      api: model.api,
      provider: model.provider,
      model: "gpt-4o",
      stopReason: "stop",
    });
  });
});
