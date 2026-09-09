import { describe, expect, test } from "bun:test";
import { convertSdkEvent } from "./events";

describe("text message → reasoning event", () => {
  test("maps SDK text message to reasoning event instead of dropping it", () => {
    const event = convertSdkEvent({
      type: "text",
      text: "Let me look at this file to understand the structure...",
    });
    expect(event).toEqual({
      type: "reasoning",
      content: "Let me look at this file to understand the structure...",
    });
  });

  test("handles empty text content", () => {
    const event = convertSdkEvent({ type: "text", text: "" });
    expect(event).toEqual({ type: "reasoning", content: "" });
  });

  test("returns null when text field is not a string", () => {
    expect(convertSdkEvent({ type: "text", text: 42 })).toBe(null);
    expect(convertSdkEvent({ type: "text" })).toBe(null);
  });

  test("stream_event content_block_delta still maps to final_text", () => {
    const event = convertSdkEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { text: "Here is the final answer" },
      },
    });
    expect(event).toEqual({ type: "final_text", content: "Here is the final answer" });
  });

  test("reasoning and final_text are distinct event types", () => {
    const reasoning = convertSdkEvent({
      type: "text",
      text: "I should check the config file first",
    });
    const finalText = convertSdkEvent({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { text: "Done!" } },
    });

    expect(reasoning).toEqual({
      type: "reasoning",
      content: "I should check the config file first",
    });
    expect(finalText).toEqual({ type: "final_text", content: "Done!" });
  });
});
