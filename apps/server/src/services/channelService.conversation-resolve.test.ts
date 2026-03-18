import { expect, test } from "bun:test";
import { type ChannelItem, resolveModelIdFromChannelItem } from "./channelService";

test("resolveModelIdFromChannelItem returns explicit modelId only when enabled; otherwise returns null; global default is strict", () => {
  const now = new Date();
  const channel: ChannelItem = {
    id: "c1",
    userId: "u1",
    name: "test",
    provider: "openai",
    baseUrl: null,
    enabled: true,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    legacyModel: null,
    models: [
      {
        id: "cm1",
        channelId: "c1",
        modelId: "m1",
        displayName: "m1",
        enabled: true,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "cm2",
        channelId: "c1",
        modelId: "m2",
        displayName: "m2",
        enabled: true,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    defaultModelId: null,
    hasApiKey: false,
  };

  expect(resolveModelIdFromChannelItem(channel, "m1")).toBe("m1");
  expect(resolveModelIdFromChannelItem(channel, "disabled")).toBe(null);
  expect(resolveModelIdFromChannelItem(channel, null)).toBe("m2");
});
