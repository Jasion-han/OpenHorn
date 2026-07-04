import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import { capMcpTools, MAX_TOTAL_TOOLS, type McpServerTools, testMcpServer } from "./mcp-tools";

function makeServer(serverName: string, count: number): McpServerTools {
  const tools = Array.from(
    { length: count },
    (_, i) =>
      ({
        name: `mcp__${serverName}__tool${i}`,
        label: `tool${i}`,
        description: `tool${i} from ${serverName}`,
        parameters: { type: "object", properties: {} } as unknown as TSchema,
        execute: async () => ({
          content: [{ type: "text" as const, text: "" }],
          details: undefined,
        }),
      }) as AgentTool<TSchema>,
  );
  return { serverName, tools };
}

describe("capMcpTools", () => {
  test("keeps every tool in server order when under the cap", () => {
    const servers = [makeServer("alpha", 2), makeServer("beta", 3)];
    const kept = capMcpTools(9, servers);
    expect(kept).toHaveLength(5);
    expect(kept.map((t) => t.name)).toEqual([
      "mcp__alpha__tool0",
      "mcp__alpha__tool1",
      "mcp__beta__tool0",
      "mcp__beta__tool1",
      "mcp__beta__tool2",
    ]);
  });

  test("truncates in server order once builtin + MCP exceeds the cap", () => {
    const builtin = MAX_TOTAL_TOOLS - 3;
    const servers = [makeServer("first", 2), makeServer("second", 4)];
    const kept = capMcpTools(builtin, servers);
    // Budget of 3: "first" survives whole, "second" keeps only its head.
    expect(kept).toHaveLength(3);
    expect(kept.map((t) => t.name)).toEqual([
      "mcp__first__tool0",
      "mcp__first__tool1",
      "mcp__second__tool0",
    ]);
  });

  test("keeps everything when builtin + MCP lands exactly on the cap", () => {
    const builtin = MAX_TOTAL_TOOLS - 5;
    const kept = capMcpTools(builtin, [makeServer("alpha", 2), makeServer("beta", 3)]);
    expect(kept).toHaveLength(5);
    expect(kept[4]?.name).toBe("mcp__beta__tool2");
  });

  test("drops everything when builtin tools already fill the cap", () => {
    const kept = capMcpTools(MAX_TOTAL_TOOLS, [makeServer("solo", 2)]);
    expect(kept).toHaveLength(0);
  });

  test("a targeted server placed first always survives", () => {
    const builtin = MAX_TOTAL_TOOLS - 2;
    const servers = [makeServer("target", 2), makeServer("noise", 50)];
    const kept = capMcpTools(builtin, servers);
    expect(kept.map((t) => t.name)).toEqual(["mcp__target__tool0", "mcp__target__tool1"]);
  });
});

describe("testMcpServer", () => {
  test("reports invalid config (no url, no command) as a failure", async () => {
    const result = await testMcpServer("broken", {});
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error?.includes("invalid config")).toBe(true);
    expect(typeof result.elapsedMs).toBe("number");
  });

  test("reports a nonexistent stdio command as a failure with a reason", async () => {
    const result = await testMcpServer("ghost", {
      command: "/nonexistent/openhorn-mcp-test-binary",
    });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect((result.error ?? "").length > 0).toBe(true);
  });
});
