import { afterAll, expect, mock, test } from "bun:test";
// These `import * as` namespaces are LIVE views: once this file's in-test `mock.module(...)`
// calls run, they would reflect the mocked exports. So snapshot each into a plain object at
// module-eval time (before any test runs a mock) to capture the REAL modules. `mock.restore()`
// does NOT unregister `mock.module()`, so we re-register these real snapshots in afterAll to
// stop this file's `db`/`../db` mocks leaking into later files (the "db.delete is not a
// function" baseline noise).
import * as realDbSchemaNs from "db";
import * as realDbNs from "../db";
import * as realUtilsNs from "../utils";

const realDbSchema = { ...realDbSchemaNs };
const realDb = { ...realDbNs };
const realUtils = { ...realUtilsNs };

afterAll(() => {
  mock.module("db", () => realDbSchema);
  mock.module("../db", () => realDb);
  mock.module("../utils", () => realUtils);
});

test("agent-check: runtime=agent_sdk keeps OpenAI-compatible /v1 endpoints intact", async () => {
  const channelTable = { id: "channel_id", userId: "channel_user_id" };
  const channelModelTable = { channelId: "channel_model_channel_id" };

  mock.module("db", () => ({
    agentSessions: {},
    agentTasks: {},
    channelModels: channelModelTable,
    channels: channelTable,
    conversations: {},
  }));

  mock.module("../db", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === channelTable) {
            return {
              where: () => ({
                limit: async () => [
                  {
                    id: "channel-1",
                    userId: "user-1",
                    name: "c",
                    provider: "openai",
                    protocol: "openai",
                    apiKey: "encrypted-key",
                    baseUrl: "https://relay.example.com/v1/messages/v1",
                    model: null,
                    enabled: true,
                    isDefault: false,
                    createdAt: new Date("2026-03-23T00:00:00.000Z"),
                    updatedAt: new Date("2026-03-23T00:00:00.000Z"),
                  },
                ],
              }),
            };
          }

          if (table === channelModelTable) {
            return {
              where: async () => [],
            };
          }

          throw new Error("Unexpected table in select");
        },
      }),
      insert: () => ({
        values: async () => ({ rowsAffected: 1 }),
      }),
    },
  }));

  mock.module("../utils", () => ({
    decrypt: (value: string) => value,
    encrypt: (value: string) => value,
    generateId: () => "generated-id",
  }));

  try {
    const { getChannelRuntimeCredentialsById } = await import(
      `./channelService?agent-check=${crypto.randomUUID()}`
    );

    const resolved = await getChannelRuntimeCredentialsById("user-1", "channel-1", {
      runtime: "agent_sdk",
    });

    expect(resolved.channel.baseUrl).toBe("https://relay.example.com/v1");
    expect(resolved.apiKey).toBe("encrypted-key");
  } finally {
    mock.restore();
  }
});

test("agent-check: runtime=agent_sdk strips mixed Anthropic suffixes for sdk execution", async () => {
  const channelTable = { id: "channel_id", userId: "channel_user_id" };
  const channelModelTable = { channelId: "channel_model_channel_id" };

  mock.module("db", () => ({
    agentSessions: {},
    agentTasks: {},
    channelModels: channelModelTable,
    channels: channelTable,
    conversations: {},
  }));

  mock.module("../db", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === channelTable) {
            return {
              where: () => ({
                limit: async () => [
                  {
                    id: "channel-1",
                    userId: "user-1",
                    name: "c",
                    provider: "anthropic",
                    protocol: "anthropic",
                    apiKey: "encrypted-key",
                    baseUrl: "https://relay.example.com/v1/messages/v1",
                    model: null,
                    enabled: true,
                    isDefault: false,
                    createdAt: new Date("2026-03-23T00:00:00.000Z"),
                    updatedAt: new Date("2026-03-23T00:00:00.000Z"),
                  },
                ],
              }),
            };
          }

          if (table === channelModelTable) {
            return {
              where: async () => [],
            };
          }

          throw new Error("Unexpected table in select");
        },
      }),
      insert: () => ({
        values: async () => ({ rowsAffected: 1 }),
      }),
    },
  }));

  mock.module("../utils", () => ({
    decrypt: (value: string) => value,
    encrypt: (value: string) => value,
    generateId: () => "generated-id",
  }));

  try {
    const { getChannelRuntimeCredentialsById } = await import(
      `./channelService?agent-check-anthropic=${crypto.randomUUID()}`
    );

    const resolved = await getChannelRuntimeCredentialsById("user-1", "channel-1", {
      runtime: "agent_sdk",
    });

    expect(resolved.channel.baseUrl).toBe("https://relay.example.com");
    expect(resolved.apiKey).toBe("encrypted-key");
  } finally {
    mock.restore();
  }
});
