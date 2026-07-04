import { describe, expect, test } from "bun:test";
import { normalizeMcpServerConfig } from "./mcpServerConfig";

describe("normalizeMcpServerConfig", () => {
  test("maps npx-typed command servers to stdio", () => {
    expect(
      normalizeMcpServerConfig("npx", {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      }),
    ).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    });
  });

  test("maps uvx-typed command servers to stdio", () => {
    expect(normalizeMcpServerConfig("uvx", { command: "uvx", args: ["mcp-server-git"] })).toEqual({
      type: "stdio",
      command: "uvx",
      args: ["mcp-server-git"],
    });
  });

  test("maps any custom server type with a command to stdio", () => {
    expect(normalizeMcpServerConfig("custom", { command: "/usr/local/bin/my-mcp" })).toEqual({
      type: "stdio",
      command: "/usr/local/bin/my-mcp",
    });
  });

  test("keeps sse when declared in config, overriding the DB type", () => {
    expect(
      normalizeMcpServerConfig("npx", { type: "sse", url: "https://mcp.example.com/sse" }),
    ).toEqual({ type: "sse", url: "https://mcp.example.com/sse" });
  });

  test("keeps http when declared in config", () => {
    expect(
      normalizeMcpServerConfig("remote", { type: "http", url: "https://mcp.example.com/mcp" }),
    ).toEqual({ type: "http", url: "https://mcp.example.com/mcp" });
  });

  test("lowercases a declared SSE type", () => {
    expect(
      normalizeMcpServerConfig("npx", { type: "SSE", url: "https://mcp.example.com/sse" }),
    ).toEqual({ type: "sse", url: "https://mcp.example.com/sse" });
  });

  test("keeps sse declared as the server type when config has no type", () => {
    expect(normalizeMcpServerConfig("sse", { url: "https://mcp.example.com/sse" })).toEqual({
      type: "sse",
      url: "https://mcp.example.com/sse",
    });
  });

  test("defaults to http when only a url is present", () => {
    expect(normalizeMcpServerConfig("remote", { url: "https://mcp.example.com/mcp" })).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
    });
  });

  test("passes through env, headers and alwaysAllow untouched", () => {
    expect(
      normalizeMcpServerConfig("npx", {
        command: "npx",
        args: ["-y", "some-mcp"],
        env: { API_KEY: "secret" },
        headers: { Authorization: "Bearer t" },
        alwaysAllow: ["tool_a"],
      }),
    ).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "some-mcp"],
      env: { API_KEY: "secret" },
      headers: { Authorization: "Bearer t" },
      alwaysAllow: ["tool_a"],
    });
  });

  test("returns a null config as-is without crashing", () => {
    expect(normalizeMcpServerConfig("npx", null)).toEqual({ type: "npx" });
  });

  test("returns configs with neither command nor url as-is", () => {
    expect(normalizeMcpServerConfig("npx", { args: ["-y", "broken"] })).toEqual({
      type: "npx",
      args: ["-y", "broken"],
    });
  });
});
