import { describe, expect, test } from "bun:test";
import { parseIncomingJsonMessage, validateMethodParams } from "./protocol";

describe("protocol", () => {
  test("parses request envelope", () => {
    const msg = parseIncomingJsonMessage(
      JSON.stringify({
        type: "request",
        requestId: "1",
        method: "ping",
        params: {},
      }),
    );
    expect(msg.type).toBe("request");
  });

  test("rejects invalid envelope", () => {
    expect(() => parseIncomingJsonMessage('{"type":"request"}')).toThrow();
  });

  test("validates auth.handshake params", () => {
    const params = validateMethodParams("auth.handshake", { token: "abc" }) as { token: string };
    expect(params.token).toBe("abc");
  });

  test("rejects unknown method params", () => {
    expect(() => validateMethodParams("nope", {})).toThrow();
  });

  test("validates mcp.test params", () => {
    const params = validateMethodParams("mcp.test", {
      name: "context7",
      config: { command: "npx", args: ["-y", "context7"] },
    }) as { name: string; config: Record<string, unknown> };
    expect(params.name).toBe("context7");
    expect(params.config.command).toBe("npx");
  });

  test("rejects mcp.test params without a name", () => {
    expect(() => validateMethodParams("mcp.test", { config: {} })).toThrow();
  });
});
