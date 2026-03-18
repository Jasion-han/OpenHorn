import { Hono } from "hono";
import {
  deleteMessage,
  editUserMessage,
  getMessagesForUserWithAttachments,
  regenerateMessage,
  sendMessage,
  streamMessage,
} from "../services/messageService";
import { requireUser, type UserEnv } from "../utils/requestUser";

const messages = new Hono<UserEnv>();

messages.use("*", requireUser);

messages.get("/:conversationId", async (c) => {
  const user = c.get("user");

  try {
    const conversationId = c.req.param("conversationId");
    const result = await getMessagesForUserWithAttachments(user.id, conversationId);
    return c.json({ messages: result });
  } catch (_error) {
    // Avoid leaking which conversation ids exist to other users.
    return c.json({ error: "Conversation not found" }, 404);
  }
});

messages.post("/", async (c) => {
  const user = c.get("user");

  try {
    const body = await c.req.json();
    if (!body?.conversationId) {
      return c.json({ error: "conversationId is required" }, 400);
    }

    const hasContent = typeof body.content === "string" && body.content.trim().length > 0;
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    if (!hasContent && !hasAttachments) {
      return c.json({ error: "content or attachments are required" }, 400);
    }

    const result = await sendMessage(user.id, body);
    return c.json(result);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to send message",
      },
      400,
    );
  }
});

messages.post("/stream", async (c) => {
  const user = c.get("user");

  try {
    const body = await c.req.json();
    if (!body?.conversationId) {
      return c.json({ error: "conversationId is required" }, 400);
    }

    const hasContent = typeof body.content === "string" && body.content.trim().length > 0;
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    if (!hasContent && !hasAttachments) {
      return c.json({ error: "content or attachments are required" }, 400);
    }

    const stream = await streamMessage(user.id, body);

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to stream message",
      },
      400,
    );
  }
});

messages.delete("/:id", async (c) => {
  const user = c.get("user");

  const messageId = c.req.param("id");
  await deleteMessage(user.id, messageId);
  return c.json({ success: true });
});

messages.post("/:id/regenerate", async (c) => {
  const user = c.get("user");
  const messageId = c.req.param("id");
  try {
    const stream = await regenerateMessage(user.id, messageId);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed" }, 400);
  }
});

messages.post("/:id/edit", async (c) => {
  const user = c.get("user");
  const messageId = c.req.param("id");
  try {
    const body = await c.req.json();
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) {
      return c.json({ error: "content is required" }, 400);
    }
    const stream = await editUserMessage(user.id, messageId, content);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed" }, 400);
  }
});

export default messages;
