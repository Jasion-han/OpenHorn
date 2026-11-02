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

  test("workspace.setCurrent accepts the empty default sentinel but requires a string root", () => {
    expect(validateMethodParams("workspace.setCurrent", { root: "" })).toEqual({ root: "" });
    expect(validateMethodParams("workspace.setCurrent", { root: "/fixture/project" })).toEqual({
      root: "/fixture/project",
    });
    for (const params of [undefined, {}, { root: null }, { root: 123 }, { root: [] }]) {
      expect(() => validateMethodParams("workspace.setCurrent", params)).toThrow();
    }
  });

  test("agent.run preserves an optional per-run workspace and rejects explicit empty roots", () => {
    const base = { prompt: "fixture", model: "fixture" };
    expect(validateMethodParams("agent.run", base)).not.toHaveProperty("workspaceRoot");
    expect(
      (
        validateMethodParams("agent.run", {
          ...base,
          workspaceRoot: "/fixture/project with space ",
        }) as { workspaceRoot: string }
      ).workspaceRoot,
    ).toBe("/fixture/project with space ");
    for (const workspaceRoot of ["", "  ", null, 123]) {
      expect(() => validateMethodParams("agent.run", { ...base, workspaceRoot })).toThrow();
    }
  });
});
