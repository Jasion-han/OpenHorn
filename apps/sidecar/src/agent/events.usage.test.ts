import { describe, expect, test } from "bun:test";
import { convertSdkEvent } from "./events";

describe("result message → usage event", () => {
  test("counts cached input alongside fresh input", () => {
    // An agent loop resends the whole transcript every step, so almost all of
    // its input is served from cache. `input_tokens` alone would report a small
    // fraction of what the turn actually processed.
    const event = convertSdkEvent({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 120,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 45000,
        output_tokens: 800,
      },
    });
    expect(event).toEqual({
      type: "usage",
      promptTokens: 47120,
      completionTokens: 800,
      totalTokens: 47920,
    });
  });

  test("works when the provider reports only the two basic buckets", () => {
    expect(
      convertSdkEvent({ type: "result", usage: { input_tokens: 10, output_tokens: 4 } }),
    ).toEqual({ type: "usage", promptTokens: 10, completionTokens: 4, totalTokens: 14 });
  });

  test("a result without usage stays silent rather than reporting zeros", () => {
    // "Not reported" must stay distinguishable from "reported as zero" — the
    // bubble hides the token line entirely in the first case.
    expect(convertSdkEvent({ type: "result", subtype: "success" })).toBe(null);
    expect(convertSdkEvent({ type: "result", usage: {} })).toBe(null);
    expect(convertSdkEvent({ type: "result", usage: { input_tokens: 0, output_tokens: 0 } })).toBe(
      null,
    );
  });

  test("negative and non-numeric counts are treated as absent", () => {
    expect(
      convertSdkEvent({
        type: "result",
        usage: { input_tokens: -5, output_tokens: "12", cache_read_input_tokens: 30 },
      }),
    ).toEqual({ type: "usage", promptTokens: 30, completionTokens: 0, totalTokens: 30 });
  });
});
