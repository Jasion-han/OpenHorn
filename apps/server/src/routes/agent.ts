import { Hono } from "hono";
import {
  createAgentSession,
  deleteAgentEvent,
  deleteAgentSession,
  getAgentEvents,
  getAgentSessionById,
  getAgentSessions,
  renameAgentSession,
  runAgent,
  updateAgentSessionChannel,
  updateAgentSessionStatus,
} from "../services/agentService";
import { generateAutoTitle } from "../services/autoTitleService";
import { checkChannelAgentCompatibility } from "../services/channelAgentCheckService";
import { getResolvedChannelForConversation } from "../services/channelService";
import { requireUser, type UserEnv } from "../utils/requestUser";
import { createSseStream } from "../utils/sse";
import { isRecord } from "../utils/typeGuards";

const agent = new Hono<UserEnv>();

agent.use("*", requireUser);

agent.get("/sessions", async (c) => {
  const user = c.get("user");

  const sessions = await getAgentSessions(user.id);
  return c.json({ sessions });
});

agent.get("/sessions/:id/events", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const events = await getAgentEvents(user.id, sessionId);
  return c.json({ events });
});

agent.delete("/events/:eventId", async (c) => {
  const user = c.get("user");
  const eventId = c.req.param("eventId");
  const ok = await deleteAgentEvent(user.id, eventId);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

agent.get("/sessions/:id", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const session = await getAgentSessionById(user.id, sessionId);

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({ session });
});

agent.post("/sessions", async (c) => {
  const user = c.get("user");

  try {
    const body = await c.req.json();
    const session = await createAgentSession(user.id, body);
    return c.json({ session }, 201);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to create session",
      },
      400,
    );
  }
});

agent.post("/sessions/:id/run", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const session = await getAgentSessionById(user.id, sessionId);
  if (!session) {
    return c.text("Session not found", 404);
  }

  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!isRecord(body)) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const prompt = body.prompt;
  const attachmentsRaw = body.attachments;

  const hasPrompt = typeof prompt === "string" && prompt.trim().length > 0;
  const attachments = Array.isArray(attachmentsRaw)
    ? attachmentsRaw.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const hasAttachments = attachments.length > 0;
  if (!hasPrompt && !hasAttachments) {
    return c.json({ error: "prompt or attachments are required" }, 400);
  }

  // Agent runtime is Anthropic-only (Claude Agent SDK). Fail fast for other providers
  // so users don't get stuck with a long "Running..." and no output.
  const resolvedChannel = await getResolvedChannelForConversation(user.id, {
    channelId: session.channelId || null,
    modelId: session.modelId || null,
  });
  const provider = resolvedChannel?.channel?.provider;
  if (!provider) {
    return c.text("未配置可用的默认渠道/默认模型。请先在设置中完成配置。", 400);
  }
  if (provider !== "anthropic") {
    return c.text(
      `Agent 模式目前仅支持 Anthropic(Claude Agent SDK)。当前 Provider: ${provider}。请切换到 Anthropic 渠道后重试。`,
      400,
    );
  }

  const compatibility = await checkChannelAgentCompatibility(
    user.id,
    resolvedChannel.channel.id,
    resolvedChannel.modelId,
  );
  if (compatibility.success === false) {
    return c.text(compatibility.error, 400);
  }

  const stream = createSseStream(async (send, ctx) => {
    let sawAny = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };

    // If the provider doesn't produce any output quickly, fail fast instead of hanging forever.
    const firstOutputTimer = setTimeout(() => {
      try {
        ctx.abortController.abort("first_output_timeout");
      } catch {
        // ignore
      }
    }, 20_000);

    const armIdle = () => {
      clearIdle();
      idleTimer = setTimeout(() => {
        try {
          ctx.abortController.abort("idle_timeout");
        } catch {
          // ignore
        }
      }, 120_000);
    };

    try {
      armIdle();
      for await (const event of runAgent(
        user.id,
        sessionId,
        typeof prompt === "string" ? prompt : "",
        attachments,
        ctx.abortController,
      )) {
        const isVisibleEvent = event.type !== "meta";
        if (isVisibleEvent && !sawAny) {
          sawAny = true;
          clearTimeout(firstOutputTimer);
        }
        // Don't treat meta/keepalive as activity for the idle timer.
        if (isVisibleEvent) {
          armIdle();
        }
        send(event);
      }
    } finally {
      clearTimeout(firstOutputTimer);
      clearIdle();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

agent.put("/sessions/:id/channel", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const { channelId, modelId } = body;
  if (!channelId || !modelId) {
    return c.json({ error: "channelId and modelId are required" }, 400);
  }

  await updateAgentSessionChannel(user.id, sessionId, channelId, modelId);
  return c.json({ success: true });
});

agent.put("/sessions/:id/status", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const { status } = body;

  await updateAgentSessionStatus(user.id, sessionId, status);
  return c.json({ success: true });
});

agent.put("/sessions/:id", async (c) => {
  const user = c.get("user");

  try {
    const sessionId = c.req.param("id");
    const body = await c.req.json();
    const title = body?.title;
    if (typeof title !== "string" || !title.trim()) {
      return c.json({ error: "title is required" }, 400);
    }

    await renameAgentSession(user.id, sessionId, title);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Session not found") {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to update session",
      },
      400,
    );
  }
});

agent.delete("/sessions/:id", async (c) => {
  const user = c.get("user");

  try {
    const sessionId = c.req.param("id");
    await deleteAgentSession(user.id, sessionId);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Session not found") {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to delete session" },
      400,
    );
  }
});

agent.post("/sessions/:id/auto-title", async (c) => {
  const user = c.get("user");

  try {
    const sessionId = c.req.param("id");
    const session = await getAgentSessionById(user.id, sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) {
      return c.json({ error: "prompt is required" }, 400);
    }
    const title = await generateAutoTitle(user.id, prompt, session.channelId || null);
    if (!title) {
      return c.json({ success: false, error: "Failed to generate title" });
    }
    await renameAgentSession(user.id, sessionId, title);
    return c.json({ success: true, title });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : "Failed" });
  }
});

export default agent;
