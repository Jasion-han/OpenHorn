import { expect, mock, test } from "bun:test";

test("agent-check: runtime=agent_sdk baseUrl normalization tolerates mixed suffixes", async () => {
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

    expect(resolved.channel.baseUrl).toBe("https://relay.example.com");
    expect(resolved.apiKey).toBe("encrypted-key");
  } finally {
    mock.restore();
  }
});
