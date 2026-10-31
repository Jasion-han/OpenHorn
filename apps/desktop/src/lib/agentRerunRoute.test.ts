import { describe, expect, test } from "bun:test";
import { resolveRerunRoute } from "./agentRerunRoute";

const model = { ok: true as const, modelId: "m-1" };

describe("resolveRerunRoute", () => {
  test("chat rounds go to the server", () => {
    expect(resolveRerunRoute({ mode: "chat", channelId: "c-1", effectiveModel: model })).toEqual({
      kind: "server",
    });
    expect(
      resolveRerunRoute({ mode: undefined, channelId: null, effectiveModel: { ok: false } }),
    ).toEqual({ kind: "server" });
  });

  test("agent rounds run in the sidecar", () => {
    expect(resolveRerunRoute({ mode: "agent", channelId: "c-1", effectiveModel: model })).toEqual({
      kind: "sidecar",
      channelId: "c-1",
      modelId: "m-1",
    });
  });

  test("an agent round without a channel never falls back to the server", () => {
    expect(resolveRerunRoute({ mode: "agent", channelId: null, effectiveModel: model })).toEqual({
      kind: "unavailable",
      reason: "noChannel",
    });
  });

  test("an agent round without a usable model never falls back to the server", () => {
    expect(
      resolveRerunRoute({ mode: "agent", channelId: "c-1", effectiveModel: { ok: false } }),
    ).toEqual({ kind: "unavailable", reason: "noModel" });
  });

  test("a missing channel is reported before a missing model, like the send path", () => {
    expect(
      resolveRerunRoute({ mode: "agent", channelId: "", effectiveModel: { ok: false } }),
    ).toEqual({ kind: "unavailable", reason: "noChannel" });
  });
});
