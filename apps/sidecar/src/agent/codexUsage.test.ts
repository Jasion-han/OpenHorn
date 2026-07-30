import { describe, expect, test } from "bun:test";
import { readCodexExecUsage } from "./chatCodex";
import { readCodexUsage } from "./codex";

/**
 * The payloads below are verbatim captures from codex-cli 0.145.0, not
 * hand-written guesses — one turn through `codex app-server` and one through
 * `codex exec --json`. The field names and, more importantly, the *arithmetic*
 * came off the wire: in both transports `totalTokens === inputTokens +
 * outputTokens` while the cached bucket was non-zero, which is what proves the
 * cache is counted inside the input rather than beside it.
 */
describe("codex app-server → usage", () => {
  test("reads the cumulative `total` bucket, cache included but not double-counted", () => {
    const usage = readCodexUsage({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "019fb0e2-5068-7e80-8c03-962c69971d53",
        turnId: "019fb0e2-51da-7fd2-9df5-6c2168fa461b",
        tokenUsage: {
          total: {
            totalTokens: 15930,
            inputTokens: 15913,
            cachedInputTokens: 4480,
            cacheWriteInputTokens: 0,
            outputTokens: 17,
            reasoningOutputTokens: 10,
          },
          last: {
            totalTokens: 15930,
            inputTokens: 15913,
            cachedInputTokens: 4480,
            cacheWriteInputTokens: 0,
            outputTokens: 17,
            reasoningOutputTokens: 10,
          },
          modelContextWindow: 258400,
        },
      },
    });
    // 15913 + 17 === 15930, codex's own total. Adding cachedInputTokens would
    // have produced 20393 and overstated the turn by 28%.
    expect(usage).toEqual({ promptTokens: 15913, completionTokens: 17 });
  });

  test("prefers `total` over `last` so a multi-step run is not billed as one step", () => {
    const usage = readCodexUsage({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          total: { inputTokens: 90_000, outputTokens: 3_000 },
          last: { inputTokens: 15_000, outputTokens: 400 },
        },
      },
    });
    expect(usage).toEqual({ promptTokens: 90_000, completionTokens: 3_000 });
  });

  test("other notifications are not mistaken for usage", () => {
    expect(
      readCodexUsage({ method: "turn/completed", params: { turn: { status: "completed" } } }),
    ).toBe(null);
    expect(readCodexUsage({ method: "item/agentMessage/delta", params: { delta: "hi" } })).toBe(
      null,
    );
    expect(readCodexUsage({ id: 3, result: {} })).toBe(null);
  });

  test("a malformed or empty notification reads as zeros, which the caller drops", () => {
    expect(readCodexUsage({ method: "thread/tokenUsage/updated" })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(
      readCodexUsage({ method: "thread/tokenUsage/updated", params: { tokenUsage: {} } }),
    ).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});

describe("codex exec --json → usage", () => {
  test("reads snake_case counts off turn.completed", () => {
    const usage = readCodexExecUsage({
      type: "turn.completed",
      usage: {
        input_tokens: 16072,
        cached_input_tokens: 4480,
        cache_write_input_tokens: 0,
        output_tokens: 17,
        reasoning_output_tokens: 10,
      },
    });
    expect(usage).toEqual({ promptTokens: 16072, completionTokens: 17 });
  });

  test("other exec events are ignored", () => {
    expect(readCodexExecUsage({ type: "thread.started" })).toBe(null);
    expect(
      readCodexExecUsage({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
    ).toBe(null);
    expect(readCodexExecUsage(null)).toBe(null);
    expect(readCodexExecUsage("turn.completed")).toBe(null);
  });

  test("turn.completed without usage reads as zeros, which the caller drops", () => {
    expect(readCodexExecUsage({ type: "turn.completed" })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
    });
  });
});
