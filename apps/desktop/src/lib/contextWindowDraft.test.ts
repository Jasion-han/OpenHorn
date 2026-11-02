import { describe, expect, test } from "bun:test";
import { channelModelUpdates, parseContextWindowDraft } from "./contextWindowDraft";

describe("context window editor", () => {
  test("blank restores automatic resolution while valid integer capacities remain exact", () => {
    for (const blank of ["", " ", "\n\t"]) {
      expect(parseContextWindowDraft(blank)).toEqual({ valid: true, value: null });
    }
    for (const value of [8192, 1_000_000, 2_000_000]) {
      expect(parseContextWindowDraft(` ${value} `)).toEqual({ valid: true, value });
    }
  });

  test("rejects out-of-range, fractional, non-finite and ambiguous formatted values", () => {
    for (const draft of [
      "0",
      "8191",
      "2000001",
      "-1000000",
      "8192.5",
      "8192.0",
      "NaN",
      "Infinity",
      "1e6",
      "1,000,000",
      "1M",
      "9007199254740993",
      "８１９２",
    ]) {
      expect(parseContextWindowDraft(draft)).toEqual({ valid: false });
    }
  });

  test("model list edits preserve separate overrides and explicit automatic resets", () => {
    const models = [
      {
        modelId: "primary",
        displayName: "Primary",
        enabled: true,
        isDefault: true,
        contextWindow: 1_000_000,
      },
      {
        modelId: "secondary",
        displayName: "Secondary",
        enabled: true,
        isDefault: false,
        contextWindow: 128_000,
      },
    ];
    const toggled = models.map((model) =>
      model.modelId === "secondary" ? { ...model, enabled: false } : model,
    );
    expect(channelModelUpdates(toggled)).toEqual([models[0], { ...models[1], enabled: false }]);
    const removed = models.filter((model) => model.modelId !== "secondary");
    expect(channelModelUpdates(removed)).toEqual([models[0]]);
    const changedDefault = models.map((model) => ({
      ...model,
      isDefault: model.modelId === "secondary",
    }));
    expect(channelModelUpdates(changedDefault)).toEqual([
      { ...models[0], isDefault: false },
      { ...models[1], isDefault: true },
    ]);
    expect(
      channelModelUpdates([
        { ...models[0], contextWindow: null },
        { ...models[1], contextWindow: undefined },
      ]),
    ).toEqual([
      { ...models[0], contextWindow: null },
      { ...models[1], contextWindow: null },
    ]);
  });
});
