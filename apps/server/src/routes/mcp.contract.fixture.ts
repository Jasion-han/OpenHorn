import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "openhorn-mcp-settings-http-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(directory, "isolated.db")}`;
process.env.OPENHORN_TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.OPENHORN_DATA_DIR = directory;
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.OPENHORN_JEV_ENABLED = "false";
delete process.env.OPENHORN_JEV_API_KEY;
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error("Fixture refuses non-loopback HTTP");
    }
    return realFetch(input, init);
  },
  { preconnect() {} },
);

const { client, db } = await import("../db");
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const { Hono } = await import("hono");
  const { users } = await import("db");
  const { bootstrapDatabase } = await import("../db/bootstrap");
  const { default: mcp } = await import("./mcp");
  const { default: settings } = await import("./settings");
  const { createMCPServer } = await import("../services/mcpService");
  const { getSettingValues } = await import("../services/settingsService");
  await bootstrapDatabase({ backup: null });
  const [owner] = await db.select().from(users).limit(1);
  const foreignId = crypto.randomUUID();
  await db.insert(users).values({
    id: foreignId,
    email: `${foreignId}@fixture.local`,
    username: "foreign",
    passwordHash: "unused",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // Stored only: neither this fixture nor these routes starts an MCP process.
  const config = { command: "openhorn-qa-do-not-execute", args: ["fixture"] };
  const foreign = await createMCPServer(foreignId, { name: "foreign", type: "stdio", config });
  const app = new Hono().route("/settings", settings).route("/mcp", mcp);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const request = async (suffix: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${baseUrl}${suffix}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let responseBody: Record<string, unknown>;
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = { error: text };
    }
    return { status: response.status, body: responseBody };
  };
  const snapshot = async () =>
    JSON.stringify((await client.execute("SELECT * FROM mcp_servers ORDER BY id")).rows);
  const specialKeys = ["__proto__", "constructor", "toString"];
  const savedSettings = [];
  for (const key of specialKeys) {
    savedSettings.push(
      await request(`/settings/${encodeURIComponent(key)}`, "PUT", { value: `value:${key}` }),
    );
  }
  const readSettings = await request(`/settings?keys=${specialKeys.join(",")}`);
  const serviceSettings = await getSettingValues(owner.id, specialKeys);
  const servicePrototypeNull = Object.getPrototypeOf(serviceSettings) === null;
  const emptyPrototypeNull = Object.getPrototypeOf(await getSettingValues(owner.id, [])) === null;
  const storedSettings = (
    await client.execute({
      sql: "SELECT key, value FROM settings WHERE user_id = ? ORDER BY key",
      args: [owner.id],
    })
  ).rows;
  const created = [];
  for (const name of specialKeys) {
    created.push(await request("/mcp/servers", "POST", { name, type: "stdio", config }));
  }
  const ownServer = (created[0].body.server as { id: string }).id;
  const invalidConfigs = [null, [], "scalar", 42, false, undefined];
  const invalidCreates = [];
  const invalidUpdates = [];
  for (const config of invalidConfigs) {
    const beforeCreate = await snapshot();
    invalidCreates.push({
      response: await request("/mcp/servers", "POST", {
        name: "invalid",
        type: "stdio",
        ...(config === undefined ? {} : { config }),
      }),
      unchanged: beforeCreate === (await snapshot()),
    });
    if (config !== undefined) {
      const beforeUpdate = await snapshot();
      invalidUpdates.push({
        response: await request(`/mcp/servers/${ownServer}`, "PUT", {
          name: "must-not-write",
          isEnabled: false,
          config,
        }),
        unchanged: beforeUpdate === (await snapshot()),
      });
    }
  }
  const invalidBodies = [];
  for (const body of [null, [], "scalar", 42, false]) {
    const before = await snapshot();
    invalidBodies.push({
      response: await request("/mcp/servers", "POST", body),
      unchanged: before === (await snapshot()),
    });
  }
  const beforeForeign = await snapshot();
  const foreignResponses = [
    await request(`/mcp/servers/${foreign.id}`),
    await request(`/mcp/servers/${foreign.id}`, "PUT", { config }),
    await request(`/mcp/servers/${foreign.id}`, "PUT", { config: null }),
    await request(`/mcp/servers/${foreign.id}`, "DELETE"),
  ];
  const foreignUnchanged = beforeForeign === (await snapshot());
  const list = await request("/mcp/servers");
  const toggle = await request(`/mcp/servers/${ownServer}`, "PUT", { isEnabled: false });
  const emptyObjectUpdate = await request(`/mcp/servers/${ownServer}`, "PUT", { config: {} });
  const updated = await request(`/mcp/servers/${ownServer}`);
  console.log(
    JSON.stringify({
      baseUrl,
      savedSettings,
      readSettings,
      servicePrototypeNull,
      emptyPrototypeNull,
      storedSettings,
      created,
      invalidCreates,
      invalidUpdates,
      invalidBodies,
      foreignResponses,
      foreignUnchanged,
      list,
      toggle,
      emptyObjectUpdate,
      updated,
    }),
  );
} finally {
  await server?.stop(true);
  client.close();
  rmSync(directory, { recursive: true, force: true });
}
