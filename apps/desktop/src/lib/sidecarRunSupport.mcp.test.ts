import { expect, test } from "bun:test";
import type { ServerApi } from "./serverApi";
import { resolveEnabledMcpServers } from "./sidecarRunSupport";

const servers = ["__proto__", "constructor", "toString", "regular"].map((name) => ({
  name,
  type: "stdio",
  config: { command: "openhorn-qa-do-not-execute" },
  isEnabled: true,
}));
const api = {
  mcp: {
    listServers: async () => ({
      servers: [...servers, { ...servers[0], name: "disabled", isEnabled: false }],
    }),
  },
} as unknown as ServerApi;

test("enabled MCP roster retains special names as own entries without a prototype", async () => {
  const roster = await resolveEnabledMcpServers(api);
  expect(Object.keys(roster ?? {}).sort()).toEqual(servers.map((s) => s.name).sort());
  expect(Object.getPrototypeOf(roster)).toBe(null);
  for (const server of servers) {
    expect(Object.hasOwn(roster ?? {}, server.name)).toBe(true);
    expect(roster?.[server.name]).toEqual({ type: "stdio", command: "openhorn-qa-do-not-execute" });
  }
});

test("targeted special MCP names stay isolated and survive JSON RPC serialization", async () => {
  for (const name of ["__proto__", "constructor", "toString"]) {
    const roster = await resolveEnabledMcpServers(api, ` ${name.toUpperCase()} `);
    expect(Object.keys(roster ?? {})).toEqual([name]);
    expect(Object.getPrototypeOf(roster)).toBe(null);
    expect(Object.keys(JSON.parse(JSON.stringify(roster)))).toEqual([name]);
  }
});

test("empty roster stays undefined and an unknown target retains enabled servers", async () => {
  const empty = { mcp: { listServers: async () => ({ servers: [] }) } } as unknown as ServerApi;
  expect(await resolveEnabledMcpServers(empty)).toBe(undefined);
  expect(Object.keys((await resolveEnabledMcpServers(api, "missing")) ?? {}).sort()).toEqual(
    servers.map((s) => s.name).sort(),
  );
});
