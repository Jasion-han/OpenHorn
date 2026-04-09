import { Hono } from "hono";
import { checkChannelAgentCompatibility } from "../services/channelAgentCheckService";
import {
  createChannel,
  deleteChannel,
  fetchChannelModels,
  getChannelById,
  getChannels,
  getResolvedChannelById,
  listChannelModels,
  setDefaultChannel,
  setDefaultChannelModel,
  testChannel,
  updateChannel,
  updateChannelModels,
} from "../services/channelService";
import { classifyProviderError } from "../services/providerErrorSummary";
import { requireUser, type UserEnv } from "../utils/requestUser";
import { isRecord } from "../utils/typeGuards";

const channels = new Hono<UserEnv>();

channels.use("*", requireUser);

channels.get("/", async (c) => {
  const user = c.get("user");

  const result = await getChannels(user.id);
  return c.json({ channels: result });
});

channels.get("/:id", async (c) => {
  const user = c.get("user");

  const channelId = c.req.param("id");
  const channel = await getChannelById(user.id, channelId);

  if (!channel) {
    return c.json({ error: "Channel not found" }, 404);
  }

  return c.json({ channel });
});

/**
 * Returns the decrypted credentials for a channel the caller owns.
 *
 * This is the one endpoint that exposes the plaintext apiKey on the
 * wire; every other route only returns `hasApiKey: boolean`. Callers
 * (currently: the desktop sidecar runtime) need the real value so the
 * sidecar can hand it to the Claude SDK.
 *
 * Security posture:
 *   - requireUser middleware already guarantees we have an authed user
 *   - getResolvedChannelById reads the channel scoped to userId, so
 *     a user cannot pull another user's credentials by guessing ids
 *   - we log the fetch for audit
 *   - the response is never cached anywhere on the server side
 */
channels.get("/:id/credentials", async (c) => {
  const user = c.get("user");
  const channelId = c.req.param("id");

  const resolved = await getResolvedChannelById(user.id, channelId);
  if (!resolved) {
    return c.json({ error: "Channel not found" }, 404);
  }

  console.log(
    JSON.stringify({
      event: "channel.credentials.fetch",
      userId: user.id,
      channelId,
      modelId: resolved.modelId,
      at: new Date().toISOString(),
    }),
  );

  return c.json({
    credentials: {
      apiKey: resolved.apiKey,
      baseUrl: resolved.channel.baseUrl ?? null,
      modelId: resolved.modelId,
      protocol: resolved.channel.protocol,
    },
  });
});

channels.post("/", async (c) => {
  const user = c.get("user");

  try {
    const body = await c.req.json();
    const channel = await createChannel(user.id, body);
    return c.json({ channel }, 201);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to create channel",
      },
      400,
    );
  }
});

channels.put("/:id", async (c) => {
  const user = c.get("user");

  try {
    const channelId = c.req.param("id");
    const body = await c.req.json();
    const channel = await updateChannel(user.id, channelId, body);
    return c.json({ channel });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to update channel",
      },
      400,
    );
  }
});

channels.delete("/:id", async (c) => {
  const user = c.get("user");

  try {
    const channelId = c.req.param("id");
    await deleteChannel(user.id, channelId);
    return c.json({ success: true });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to delete channel",
      },
      400,
    );
  }
});

channels.post("/:id/test", async (c) => {
  const user = c.get("user");

  const channelId = c.req.param("id");
  const result = await testChannel(user.id, channelId);

  return c.json(result);
});

channels.post("/:id/fetch-models", async (c) => {
  const user = c.get("user");

  const channelId = c.req.param("id");
  const result = await fetchChannelModels(user.id, channelId);
  // Treat "sync models" as an operation result, not an exception.
  // Always return 200 so the UI can render inline diagnostics from { success, error }.
  return c.json(result);
});

channels.get("/:id/models", async (c) => {
  const user = c.get("user");

  const channelId = c.req.param("id");
  const models = await listChannelModels(user.id, channelId);
  return c.json({ models });
});

channels.put("/:id/models", async (c) => {
  const user = c.get("user");

  try {
    const channelId = c.req.param("id");
    const body = await c.req.json();
    const models = await updateChannelModels(user.id, channelId, body);
    return c.json({ models });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to update models",
      },
      400,
    );
  }
});

channels.post("/:id/set-default", async (c) => {
  const user = c.get("user");

  try {
    const channelId = c.req.param("id");
    await setDefaultChannel(user.id, channelId);
    return c.json({ success: true });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to set default channel",
      },
      400,
    );
  }
});

channels.post("/:id/models/:modelId/set-default", async (c) => {
  const user = c.get("user");

  try {
    const channelId = c.req.param("id");
    const modelId = c.req.param("modelId");
    await setDefaultChannelModel(user.id, channelId, modelId);
    return c.json({ success: true });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to set default model",
      },
      400,
    );
  }
});

channels.post("/:id/agent-check", async (c) => {
  const user = c.get("user");

  try {
    const channelId = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as unknown;
    const modelId = isRecord(body) && typeof body.modelId === "string" ? body.modelId : "";

    const result = await checkChannelAgentCompatibility(user.id, channelId, modelId, {
      bypassCache: true,
    });
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent check failed";
    const classified = classifyProviderError(message);
    return c.json({
      success: false,
      error: classified.userMessage,
      errorCode: classified.kind,
      retryable: classified.retryable,
      rawError: classified.raw,
    });
  }
});

export default channels;
