import { describe, expect, test } from "bun:test";
import { mapCodexEvent } from "./codex";

describe("mapCodexEvent", () => {
  test("maps an agentMessage delta to a text event", () => {
    const event = mapCodexEvent({
      method: "item/agentMessage/delta",
      params: { delta: "hello" },
    });
    expect(event).toEqual({ type: "text", content: "hello" });
  });

  test("ignores an empty delta", () => {
    const event = mapCodexEvent({
      method: "item/agentMessage/delta",
      params: { delta: "" },
    });
    expect(event).toBe(null);
  });

  test("maps a commandExecution start to tool_start", () => {
    const event = mapCodexEvent({
      method: "item/started",
      params: { item: { type: "commandExecution", command: "ls -la" } },
    });
    expect(event).toEqual({
      type: "tool_start",
      toolName: "shell",
      toolInput: { command: "ls -la" },
    });
  });

  test("maps a completed turn to done", () => {
    const event = mapCodexEvent({ method: "turn/completed", params: { status: "completed" } });
    expect(event).toEqual({ type: "done" });
  });

  test("maps a failed turn to an error carrying the message", () => {
    const event = mapCodexEvent({
      method: "turn/completed",
      params: { status: "failed", error: { message: "upstream exploded" } },
    });
    expect(event).toEqual({ type: "error", content: "upstream exploded" });
  });
});

// The bug this guards: text deltas used to be buffered into `pendingText` and
// only replayed after turn/completed, so the UI showed nothing for the whole
// run. Every non-`done` event — text included — must be forwarded as it maps.
describe("text deltas are forwarded as they arrive", () => {
  // Mirrors the dispatch in runCodexAgent's rl.on("line") handler.
  function dispatch(messages: Array<Record<string, unknown>>) {
    const forwarded: Array<{ type: string; content?: string }> = [];
    for (const msg of messages) {
      const event = mapCodexEvent(msg);
      if (!event) continue;
      if (event.type !== "done") {
        forwarded.push({ type: event.type, content: (event as { content?: string }).content });
      }
    }
    return forwarded;
  }

  test("each delta is emitted, in order, before the turn completes", () => {
    const forwarded = dispatch([
      { method: "item/agentMessage/delta", params: { delta: "one " } },
      { method: "item/agentMessage/delta", params: { delta: "two " } },
      { method: "item/agentMessage/delta", params: { delta: "three" } },
      { method: "turn/completed", params: { status: "completed" } },
    ]);

    expect(forwarded).toHaveLength(3);
    expect(forwarded.map((e) => e.content).join("")).toBe("one two three");
    for (const event of forwarded) {
      expect(event.type).toBe("text");
    }
  });

  test("text emitted before a tool call is not swallowed by the tool event", () => {
    const forwarded = dispatch([
      { method: "item/agentMessage/delta", params: { delta: "checking" } },
      { method: "item/started", params: { item: { type: "commandExecution", command: "ls" } } },
      { method: "item/agentMessage/delta", params: { delta: "done" } },
      { method: "turn/completed", params: { status: "completed" } },
    ]);

    expect(forwarded.map((e) => e.type)).toEqual(["text", "tool_start", "text"]);
  });
});
