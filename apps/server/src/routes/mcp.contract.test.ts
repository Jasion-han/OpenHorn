import { beforeAll, expect, test } from "bun:test";

type Response = { status: number; body: Record<string, unknown> };
type Mutation = { response: Response; unchanged: boolean };
let report: {
  baseUrl: string;
  savedSettings: Response[];
  readSettings: Response;
  servicePrototypeNull: boolean;
  emptyPrototypeNull: boolean;
  storedSettings: Array<{ key: string; value: string }>;
  created: Response[];
  invalidCreates: Mutation[];
  invalidUpdates: Mutation[];
  invalidBodies: Mutation[];
  foreignResponses: Response[];
  foreignUnchanged: boolean;
  list: Response;
  toggle: Response;
  emptyObjectUpdate: Response;
  updated: Response;
};

beforeAll(() => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      new URL("./mcp.contract.fixture.ts", import.meta.url).pathname,
    ],
    { env: { ...process.env, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe", timeout: 20_000 },
  );
  if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
  report = JSON.parse(child.stdout.toString().trim().split("\n").at(-1) ?? "null");
});

test("real temporary SQLite and loopback HTTP roundtrip special settings keys", () => {
  expect(report.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
  expect(report.savedSettings.map((r) => r.status)).toEqual([200, 200, 200]);
  expect(report.readSettings.status).toBe(200);
  expect(report.readSettings.body.settings).toEqual(
    JSON.parse(
      '{"__proto__":"value:__proto__","constructor":"value:constructor","toString":"value:toString"}',
    ),
  );
  expect(report.storedSettings).toHaveLength(3);
  expect(report.servicePrototypeNull).toBe(true);
  expect(report.emptyPrototypeNull).toBe(true);
});

test("HTTP rejects invalid create config before any database mutation with stable and legacy errors", () => {
  for (const { response, unchanged } of [...report.invalidCreates, ...report.invalidBodies]) {
    expect(response.status).toBe(400);
    expect(response.body.errorCode).toBe("mcp_invalid_config");
    expect(typeof response.body.error).toBe("string");
    expect(unchanged).toBe(true);
  }
});

test("HTTP rejects invalid update config without changing any fields", () => {
  for (const { response, unchanged } of report.invalidUpdates) {
    expect(response.status).toBe(400);
    expect(response.body.errorCode).toBe("mcp_invalid_config");
    expect(typeof response.body.error).toBe("string");
    expect(unchanged).toBe(true);
  }
});

test("HTTP accepts object configs and special MCP names and preserves toggle-only updates", () => {
  expect(report.created.map((r) => r.status)).toEqual([201, 201, 201]);
  const names = ["__proto__", "constructor", "toString"];
  const servers = report.list.body.servers as Array<{ name: string; config: unknown }>;
  expect(servers.map((s) => s.name).sort()).toEqual(names.sort());
  for (const response of report.created) {
    expect((response.body.server as { config: unknown }).config).toEqual({
      command: "openhorn-qa-do-not-execute",
      args: ["fixture"],
    });
  }
  expect(report.toggle.status).toBe(200);
  expect(report.emptyObjectUpdate.status).toBe(200);
  expect((report.updated.body.server as { config: unknown }).config).toEqual({});
  expect((report.updated.body.server as { isEnabled: boolean }).isEnabled).toBe(false);
});

test("HTTP preserves ownership 404 and never mutates another user's MCP record", () => {
  expect(report.foreignResponses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
  expect(report.foreignUnchanged).toBe(true);
});
