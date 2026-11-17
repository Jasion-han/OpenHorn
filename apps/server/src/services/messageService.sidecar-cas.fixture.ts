import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SidecarSaveResult } from "shared/types";

const directory = mkdtempSync(path.join(tmpdir(), "openhorn-save-cas-http-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(directory, "isolated.db")}`;
const { client, db } = await import("../db");
try {
  const { Hono } = await import("hono");
  const { bootstrapDatabase } = await import("../db/bootstrap");
  const { users, conversations } = await import("db");
  const { default: messageRoutes } = await import("../routes/messages");
  await bootstrapDatabase();
  const [localUser] = await db.select().from(users).limit(1);
  const userId = localUser?.id ?? crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const now = new Date();
  if (!localUser) {
    await db.insert(users).values({
      id: userId,
      email: `${userId}@test.invalid`,
      username: "cas-http",
      createdAt: now,
      updatedAt: now,
    });
  }
  await db
    .insert(conversations)
    .values({ id: conversationId, userId, title: "CAS HTTP", createdAt: now, updatedAt: now });
  const app = new Hono();
  app.route("/messages", messageRoutes);
  const input = {
    conversationId,
    userMessageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
    userContent: "baseline",
    assistantContent: "baseline",
    agentRun: { status: "completed", steps: [{ type: "text", content: "baseline" }] },
    syncRevision: { sessionId: crypto.randomUUID(), sequence: 1 },
    expectedUserToken: null,
    expectedAssistantToken: null,
  };
  const send = (body: unknown) =>
    app.request("/messages/sync-sidecar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const first = await send(input);
  const firstSaved = (await first.json()) as SidecarSaveResult;
  const stale = {
    ...input,
    syncRevision: { sessionId: crypto.randomUUID(), sequence: 1 },
    expectedUserToken: firstSaved.saveTokens?.user,
    expectedAssistantToken: firstSaved.saveTokens?.assistant,
  };
  const newer = await send({
    ...stale,
    syncRevision: { sessionId: crypto.randomUUID(), sequence: 1 },
    userContent: "newer",
    agentRun: { status: "completed", steps: [{ type: "text", content: "newer" }] },
  });
  const newSaved = (await newer.json()) as SidecarSaveResult;
  const conflict = await send({ ...stale, recovery: true });
  const failure = (await conflict.json()) as { errorCode?: string };
  const listed = await app.request(`/messages/${conversationId}`);
  const result = (await listed.json()) as {
    messages: Array<{ role: string; content: string; saveToken?: string }>;
  };
  console.log(
    JSON.stringify({
      first: first.status,
      newer: newer.status,
      conflict: conflict.status,
      errorCode: failure.errorCode,
      content: result.messages.find((row) => row.role === "assistant")?.content,
      tokensMatch:
        result.messages.find((row) => row.role === "user")?.saveToken ===
          newSaved.saveTokens?.user &&
        result.messages.find((row) => row.role === "assistant")?.saveToken ===
          newSaved.saveTokens?.assistant,
    }),
  );
} finally {
  client.close();
  rmSync(directory, { recursive: true, force: true });
}
