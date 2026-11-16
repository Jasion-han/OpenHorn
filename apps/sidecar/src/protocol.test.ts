import { describe, expect, test } from "bun:test";
import { parseIncomingJsonMessage, validateMethodParams } from "./protocol";

describe("protocol", () => {
  test("agent.run preserves the selected tool connection instead of stripping it", () => {
    const toolConnection = {
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "fixture-only",
      model: "test/model",
    };
    const result = validateMethodParams("agent.run", {
      prompt: "x",
      apiKey: "model-key",
      model: "test/model",
      toolConnection,
    }) as { toolConnection: unknown };
    expect(result.toolConnection).toEqual(toolConnection);
  });
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

test("agent.run preserves the selected native retrieval route while rejecting another endpoint or model", () => {
  const nativeSearchConnection = {
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-pro",
    apiKey: "fixture-native",
  };
  const params = {
    prompt: "Search docs",
    apiKey: "answer-model-key",
    model: "gpt-6-astra",
    searchProvider: "deepseek-native",
    nativeSearchConnection,
  };
  expect(
    (validateMethodParams("agent.run", params) as { nativeSearchConnection: unknown })
      .nativeSearchConnection,
  ).toEqual(nativeSearchConnection);
  for (const connection of [
    { ...nativeSearchConnection, baseUrl: "https://relay.example.com/v1" },
    { ...nativeSearchConnection, model: "deepseek-flash" },
  ]) {
    expect(() =>
      validateMethodParams("agent.run", { ...params, nativeSearchConnection: connection }),
    ).toThrow();
  }
});

test("agent.run preserves only the fixed independent OpenRouter search contract", () => {
  const connection = {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-v4-pro",
    engine: "exa",
    apiKey: "synthetic-openrouter-key",
  };
  const params = {
    prompt: "docs",
    apiKey: "answer-model-key",
    model: "answer-model",
    searchProvider: "openrouter",
    openRouterSearchConnection: connection,
  };
  const result = validateMethodParams("agent.run", params) as {
    openRouterSearchConnection: unknown;
    searchProvider: string;
  };
  expect(result.openRouterSearchConnection).toEqual(connection);
  expect(result.searchProvider).toBe("openrouter");
  const flash = { ...connection, model: "deepseek/deepseek-v4-flash" };
  expect(
    (
      validateMethodParams("agent.run", { ...params, openRouterSearchConnection: flash }) as {
        openRouterSearchConnection: unknown;
      }
    ).openRouterSearchConnection,
  ).toEqual(flash);
  for (const change of [
    { baseUrl: "https://relay.example.com/v1" },
    { model: "other" },
    { engine: "other" },
    { apiKey: "bad key" },
  ]) {
    let failed = false;
    try {
      validateMethodParams("agent.run", {
        ...params,
        openRouterSearchConnection: { ...connection, ...change },
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  }
});

test("agent.run preserves explicit MCP targeting without inferring it from a single server", () => {
  const base = { prompt: "docs", model: "answer", mcpServers: { "tavily-hikari": {} } };
  const targeted = validateMethodParams("agent.run", {
    ...base,
    targetMcpServer: "tavily-hikari",
  }) as { targetMcpServer?: string };
  expect(targeted.targetMcpServer).toBe("tavily-hikari");
  expect(
    (validateMethodParams("agent.run", base) as { targetMcpServer?: string }).targetMcpServer,
  ).toBe(undefined);
});
