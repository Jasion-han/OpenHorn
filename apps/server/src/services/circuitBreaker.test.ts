import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { channelModels, channels, conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { encrypt } from "../utils";
import { getResolvedChannelForConversation } from "./channelService";
import {
  getChannelBreakerState,
  isChannelAvailable,
  recordChannelFailure,
  recordChannelSuccess,
  resetAllBreakers,
} from "./circuitBreaker";
import { completeChatFromSidecar, prepareChatForSidecar } from "./messageService";
import * as ragServiceNamespace from "./ragService";
import { completeSidecarChannelProbe, prepareWithSidecarChannelProbe } from "./sidecarChannelProbe";

const realRagService = { ...ragServiceNamespace };
beforeAll(() => {
  // This suite checks channel routing and owned completion, not the vector
  // store. Keep it away from the application's on-disk vector directory.
  mock.module("./ragService", () => ({ ...realRagService, retrieveContext: async () => "" }));
});
afterAll(() => {
  mock.module("./ragService", () => realRagService);
});

let now = 1_000_000;
const realNow = Date.now;

beforeEach(() => {
  now = 1_000_000;
  Date.now = () => now;
  resetAllBreakers();
});

afterEach(() => {
  Date.now = realNow;
  resetAllBreakers();
});

function trip(channelId: string) {
  for (let i = 0; i < 5; i++) recordChannelFailure(channelId);
}

describe("channel circuit recovery", () => {
  test("only one concurrent request acquires the half-open probe", async () => {
    trip("primary");
    expect(isChannelAvailable("primary")).toBe(false);
    now += 30_000;
    const attempts = await Promise.all(
      Array.from({ length: 20 }, async () => isChannelAvailable("primary")),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(getChannelBreakerState("primary")).toBe("half_open");
    expect(isChannelAvailable("other-channel")).toBe(true);
  });

  test("a successful probe closes the breaker and resets consecutive failures", () => {
    trip("primary");
    now += 30_000;
    expect(isChannelAvailable("primary")).toBe(true);
    recordChannelSuccess("primary");
    expect(getChannelBreakerState("primary")).toBe("closed");
    for (let i = 0; i < 4; i++) recordChannelFailure("primary");
    expect(isChannelAvailable("primary")).toBe(true);
    recordChannelFailure("primary");
    expect(isChannelAvailable("primary")).toBe(false);
  });

  test("a failed probe starts a full new cooldown", () => {
    trip("primary");
    now += 30_000;
    expect(isChannelAvailable("primary")).toBe(true);
    now += 10_000;
    recordChannelFailure("primary");
    expect(getChannelBreakerState("primary")).toBe("open");
    now += 29_999;
    expect(isChannelAvailable("primary")).toBe(false);
    now += 1;
    expect(isChannelAvailable("primary")).toBe(true);
    expect(isChannelAvailable("primary")).toBe(false);
  });

  test("an abandoned probe expires and cools down before another request probes", () => {
    trip("primary");
    now += 30_000;
    expect(isChannelAvailable("primary")).toBe(true);
    now += 119_999;
    expect(isChannelAvailable("primary")).toBe(false);
    now += 1;
    expect(isChannelAvailable("primary")).toBe(false);
    expect(getChannelBreakerState("primary")).toBe("open");
    now += 30_000;
    expect(isChannelAvailable("primary")).toBe(true);
    expect(isChannelAvailable("primary")).toBe(false);
  });
});

async function withChannels(run: (ids: string[], userId: string) => Promise<void>) {
  const previousKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = "circuit-breaker-synthetic-test-key";
  const userId = crypto.randomUUID();
  const ids: string[] = [];
  try {
    await db.insert(users).values({
      id: userId,
      email: `${userId}@test.invalid`,
      username: "breaker",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    for (const isDefault of [true, false, false]) {
      const id = crypto.randomUUID();
      ids.push(id);
      await db.insert(channels).values({
        id,
        userId,
        name: id,
        provider: "openai",
        protocol: "openai",
        apiKey: encrypt("synthetic-breaker-key"),
        baseUrl: "http://127.0.0.1:1/v1",
        model: ids.length === 2 ? null : "synthetic-model",
        enabled: true,
        isDefault,
        createdAt: new Date(now),
        updatedAt: new Date(now - ids.length),
      });
      // The middle channel deliberately has no default model. Its breaker
      // must not reserve a probe until credentials can actually be resolved.
      if (ids.length === 2) continue;
      await db.insert(channelModels).values({
        id: crypto.randomUUID(),
        channelId: id,
        modelId: "synthetic-model",
        displayName: "Synthetic model",
        isDefault: true,
        enabled: true,
        contextMetadata: JSON.stringify({
          contextWindow: 32_768,
          source: "channel",
          fetchedAt: now,
        }),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
    }
    await run(ids, userId);
  } finally {
    const ownedConversations = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.userId, userId));
    for (const conversation of ownedConversations) {
      await db.delete(messages).where(eq(messages.conversationId, conversation.id));
    }
    await db.delete(conversations).where(eq(conversations.userId, userId));
    for (const id of ids) {
      await db.delete(channelModels).where(eq(channelModels.channelId, id));
      await db.delete(channels).where(eq(channels.id, id));
    }
    await db.delete(users).where(eq(users.id, userId));
    if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousKey;
  }
}

test("resolution never bypasses the breaker when every usable channel is blocked", async () => {
  await withChannels(async ([primary, unusable, fallback], userId) => {
    trip(primary);
    trip(unusable);
    trip(fallback);
    expect(await getResolvedChannelForConversation(userId, { channelId: primary })).toBe(null);
    now += 30_000;
    const probe = await getResolvedChannelForConversation(userId, { channelId: primary });
    expect(probe?.channel.id).toBe(primary);
    const otherProbe = await getResolvedChannelForConversation(userId, { channelId: primary });
    expect(otherProbe?.channel.id).toBe(fallback);
    expect(getChannelBreakerState(unusable)).toBe("open");
    expect(await getResolvedChannelForConversation(userId, { channelId: primary })).toBe(null);
    recordChannelSuccess(fallback);
    expect(
      (await getResolvedChannelForConversation(userId, { channelId: primary }))?.channel.id,
    ).toBe(fallback);
  });
});

test("sidecar completion settles the actual fallback probe without trusting a client channel", async () => {
  await withChannels(async ([primary, , fallback], userId) => {
    trip(fallback);
    now += 30_000;
    trip(primary);
    const conversationId = crypto.randomUUID();
    await db.insert(conversations).values({
      id: conversationId,
      userId,
      channelId: primary,
      modelId: "synthetic-model",
      title: "Probe fixture",
      forceWebSearch: false,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    const prepared = await prepareChatForSidecar(userId, { conversationId, content: "hello" });
    expect(getChannelBreakerState(primary)).toBe("open");
    expect(getChannelBreakerState(fallback)).toBe("half_open");
    await expect(
      completeChatFromSidecar(userId, {
        assistantMessageId: "missing-assistant",
        conversationId,
        content: "unmatched completion",
      }),
    ).rejects.toThrow("Assistant message not found");
    expect(getChannelBreakerState(fallback)).toBe("half_open");
    await completeChatFromSidecar(userId, {
      assistantMessageId: prepared.assistantMessageId,
      conversationId,
      content: "synthetic response",
      model: prepared.model,
    });
    expect(getChannelBreakerState(primary)).toBe("open");
    expect(getChannelBreakerState(fallback)).toBe("closed");
  });
});

test("sidecar stop and local/model errors do not masquerade as successful probes", async () => {
  await withChannels(async ([primary], userId) => {
    const conversationId = crypto.randomUUID();
    await db.insert(conversations).values({
      id: conversationId,
      userId,
      channelId: primary,
      modelId: "synthetic-model",
      title: "Probe outcomes",
      forceWebSearch: false,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    trip(primary);
    for (const finishReason of ["error", "context_budget_exceeded", "stopped", "length"]) {
      now += 30_000;
      const prepared = await prepareChatForSidecar(userId, { conversationId, content: "hello" });
      expect(getChannelBreakerState(primary)).toBe("half_open");
      await completeChatFromSidecar(userId, {
        assistantMessageId: prepared.assistantMessageId,
        conversationId,
        content: "synthetic partial response",
        finishReason,
      });
      expect(getChannelBreakerState(primary)).toBe(finishReason === "length" ? "closed" : "open");
    }
  });
});

test("sidecar preparation failure releases its probe without counting a provider failure", async () => {
  trip("primary");
  now += 30_000;
  expect(isChannelAvailable("primary")).toBe(true);
  await expect(
    prepareWithSidecarChannelProbe(
      { userId: "user", conversationId: "conversation", channelId: "primary" },
      async () => {
        throw new Error("synthetic preflight failure");
      },
    ),
  ).rejects.toThrow("synthetic preflight failure");
  expect(getChannelBreakerState("primary")).toBe("open");
  expect(isChannelAvailable("primary")).toBe(false);
});

test("an expired preparation cannot hand an unreserved probe to the sidecar", async () => {
  trip("primary");
  now += 30_000;
  expect(isChannelAvailable("primary")).toBe(true);
  await expect(
    prepareWithSidecarChannelProbe(
      { userId: "user", conversationId: "conversation", channelId: "primary" },
      async () => {
        now += 120_000;
        return { assistantMessageId: "expired-preparation" };
      },
    ),
  ).rejects.toThrow("Channel recovery probe expired during preparation");
  expect(getChannelBreakerState("primary")).toBe("open");
});

test("wrong identity and stale sidecar results cannot close a newer probe", async () => {
  const identity = {
    userId: "user",
    conversationId: "conversation",
    assistantMessageId: "old-sidecar-assistant",
  };
  trip("primary");
  now += 30_000;
  expect(isChannelAvailable("primary")).toBe(true);
  await prepareWithSidecarChannelProbe(
    { userId: identity.userId, conversationId: identity.conversationId, channelId: "primary" },
    async () => ({ assistantMessageId: identity.assistantMessageId }),
  );
  completeSidecarChannelProbe({ ...identity, userId: "other-user" }, "success");
  expect(getChannelBreakerState("primary")).toBe("half_open");
  now += 120_000;
  expect(isChannelAvailable("primary")).toBe(false);
  now += 30_000;
  expect(isChannelAvailable("primary")).toBe(true);
  const newer = { ...identity, assistantMessageId: "new-sidecar-assistant" };
  await prepareWithSidecarChannelProbe(
    { userId: newer.userId, conversationId: newer.conversationId, channelId: "primary" },
    async () => ({ assistantMessageId: newer.assistantMessageId }),
  );
  completeSidecarChannelProbe(identity, "success");
  expect(getChannelBreakerState("primary")).toBe("half_open");
  completeSidecarChannelProbe(newer, "success");
  expect(getChannelBreakerState("primary")).toBe("closed");
});

test("cancelled sidecar probes cool down without pretending to be successful", async () => {
  const identity = {
    userId: "user",
    conversationId: "conversation",
    assistantMessageId: "cancelled-sidecar-assistant",
  };
  trip("primary");
  now += 30_000;
  expect(isChannelAvailable("primary")).toBe(true);
  await prepareWithSidecarChannelProbe(
    { userId: identity.userId, conversationId: identity.conversationId, channelId: "primary" },
    async () => ({ assistantMessageId: identity.assistantMessageId }),
  );
  completeSidecarChannelProbe(identity, "abandoned");
  expect(getChannelBreakerState("primary")).toBe("open");
});
