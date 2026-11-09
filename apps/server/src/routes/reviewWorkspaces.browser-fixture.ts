/** Loopback-only test backend. Never import this file from the production entry. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";

const directory = mkdtempSync(path.join(tmpdir(), "openhorn-reviews-browser-"));
process.env.NODE_ENV = "test";
// Synthetic mode must never inherit paid decision credentials from the developer .env.
const decisionFixture = process.env.OPENHORN_JEV_SYNTHETIC === "1";
delete process.env.OPENHORN_JEV_API_KEY;
process.env.OPENHORN_JEV_ENABLED = "false";
if (decisionFixture) {
  process.env.OPENHORN_JEV_API_KEY = "synthetic-openrouter-only";
  process.env.OPENHORN_JEV_ENABLED = "true";
  process.env.OPENHORN_JEV_DAILY_BUDGET_USD = "0.05";
}
let syntheticDecisionCalls = 0;
const liveJev = process.env.OPENHORN_REVIEW_LIVE_JEV === "1";
const maxLiveCalls = process.env.OPENHORN_REVIEW_LIVE_JEV_MAX_CALLS === "3" ? 3 : 2;
const nativeFetch = globalThis.fetch;
if (!liveJev) process.env.TYPESAFE_API_KEY = "synthetic-browser-key";
let verificationMode = liveJev ? "live" : "negative";
let liveProviderCalls = 0;
const verificationRequests: Array<{
  payload: unknown;
  status: number;
  live: boolean;
  response?: unknown;
}> = [];
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    if (String(input) === "https://openrouter.ai/api/v1/systemone" && decisionFixture) {
      syntheticDecisionCalls++;
      const payload = JSON.parse(String(options?.body));
      const answers = Object.fromEntries(
        Object.entries(payload.questions).map(([id, raw]) => {
          const question = raw as { type: string; criteria?: Record<string, string> };
          if (question.type === "choice") {
            const keys = Object.keys(question.criteria ?? {});
            const selected = keys.includes("positive")
              ? "positive"
              : keys.includes("direct_model")
                ? "direct_model"
                : keys[0];
            return [
              id,
              {
                type: "choice",
                choice: selected,
                confidence: 1,
                probabilities: Object.fromEntries(
                  keys.map((key) => [key, key === selected ? 1 : 0]),
                ),
              },
            ];
          }
          return [
            id,
            {
              type: "noul",
              noul:
                id.endsWith("_interpretable") ||
                id.endsWith("_usability") ||
                id === "note" ||
                id === "hasClaims"
                  ? 0.95
                  : 0.05,
            },
          ];
        }),
      );
      return Response.json({
        id: `synthetic-jev-${syntheticDecisionCalls}`,
        model: "typesafe/jev-1.14-20261014",
        answers,
        usage: { input_tokens: 1000, output_tokens: 100, cost: 0.000042 },
      });
    }
    if (String(input) === "https://api.typesafe.ai/v1/systemone") {
      const payload: unknown = JSON.parse(String(options?.body));
      if (verificationMode === "timeout") {
        verificationRequests.push({ payload, status: 0, live: false });
        throw new DOMException("synthetic timeout", "TimeoutError");
      }
      if (verificationMode === "error") {
        verificationRequests.push({ payload, status: 401, live: false });
        return new Response("synthetic upstream error", { status: 401 });
      }
      if (verificationMode === "live") {
        if (!liveJev || liveProviderCalls >= maxLiveCalls)
          throw new Error("Live verification call budget exhausted");
        liveProviderCalls++;
        const response = await nativeFetch(input, options);
        const body: unknown = response.ok ? await response.clone().json() : undefined;
        verificationRequests.push({
          payload,
          status: response.status,
          live: true,
          ...(body ? { response: body } : {}),
        });
        return response;
      }
      const body = {
        model: "jev-1.14.0",
        answers: {
          hasClaims: {
            type: "noul",
            noul:
              verificationMode === "no-claims"
                ? 0.05
                : verificationMode === "unclear-claims"
                  ? 0.5
                  : 0.99,
          },
          note: {
            type: "noul",
            noul:
              verificationMode === "positive"
                ? 0.95
                : verificationMode === "uncertain"
                  ? 0.5
                  : verificationMode === "no-claims" || verificationMode === "unclear-claims"
                    ? 0.99
                    : 0.02,
          },
        },
        usage: { input_tokens: 300, output_tokens: 8 },
      };
      verificationRequests.push({ payload, status: 200, live: false, response: body });
      return Response.json(body);
    }
    throw new Error("External network forbidden in review fixture");
  },
  { preconnect() {} },
);
process.env.DATABASE_URL = `file:${path.join(directory, "isolated.db")}`;
process.env.OPENHORN_TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.OPENHORN_HOME = path.join(directory, "state");
const { db, client } = await import("../db");
const { bootstrapDatabase } = await import("../db/bootstrap");
const {
  channels,
  channelModels,
  users,
  messages,
  reviewWorkspaces,
  conversations: conversationTable,
} = await import("db");
const { eq } = await import("drizzle-orm");
const { getReviewWorkspace } = await import("../services/reviewWorkspaceService");
const { default: reviews } = await import("./reviewWorkspaces");
const { default: decisions } = await import("./decisions");
const { default: conversations } = await import("./conversations");
const { default: messageRoutes } = await import("./messages");
await bootstrapDatabase({ backup: null });
// bootstrap's default local account is replaced only inside this owned test DB.
await db.delete(users);
const now = new Date();
await db.insert(users).values({
  id: "reviews-browser-user",
  username: "Synthetic",
  email: "reviews-browser@test.invalid",
  createdAt: now,
  updatedAt: now,
});
await db.insert(channels).values({
  id: "reviews-browser-channel",
  userId: "reviews-browser-user",
  name: "Synthetic API",
  provider: "openai",
  protocol: "openai",
  apiKey: "synthetic-never-used",
  enabled: true,
  isDefault: true,
  createdAt: now,
  updatedAt: now,
});
await db.insert(channelModels).values({
  id: "reviews-browser-model",
  channelId: "reviews-browser-channel",
  modelId: "synthetic-model",
  displayName: "Synthetic model",
  enabled: true,
  isDefault: true,
  createdAt: now,
  updatedAt: now,
});
const app = new Hono();
app.use(
  "*",
  cors({
    origin: (origin) => (/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) ? origin : null),
    credentials: true,
  }),
);
app
  .route("/decisions", decisions)
  .route("/review-workspaces", reviews)
  .route("/conversations", conversations)
  .route("/messages", messageRoutes);
app.get("/__fixture/decision-stats", (c) => c.json({ calls: syntheticDecisionCalls }));
app.post("/__fixture/decision-budget", async (c) => {
  process.env.OPENHORN_JEV_DAILY_BUDGET_USD = String((await c.req.json()).limit);
  return c.json({ success: true });
});
app.get("/__fixture/verification-stats", (c) =>
  c.json({ calls: verificationRequests, liveProviderCalls }),
);
app.post("/__fixture/legacy-note", async (c) => {
  const { workspaceId, rowId } = await c.req.json();
  const workspace = await getReviewWorkspace("reviews-browser-user", workspaceId);
  const row = workspace.data.rows.find((item) => item.id === rowId);
  if (!row?.noteVerification) return c.json({}, 400);
  row.noteVerification.questionVersion = "review-note-v1";
  delete row.noteVerification.hasClaimsProbability;
  row.noteVerification.verdict =
    row.noteVerification.probability <= 0.3
      ? "review"
      : row.noteVerification.probability >= 0.7
        ? "supported"
        : "uncertain";
  await db
    .update(reviewWorkspaces)
    .set({ data: JSON.stringify(workspace.data), revision: workspace.revision + 1 })
    .where(eq(reviewWorkspaces.id, workspaceId));
  return c.json({ success: true });
});
app.post("/__fixture/verification-mode", async (c) => {
  verificationMode = (await c.req.json()).mode;
  return c.json({ success: true });
});
app.post("/__fixture/complete", async (c) => {
  const { workspaceId, bad } = await c.req.json();
  const workspace = await getReviewWorkspace("reviews-browser-user", workspaceId);
  const run = workspace.data.runs.at(-1);
  if (!run?.conversationId) return c.json({}, 400);
  const content = JSON.stringify({
    runId: bad ? "wrong-run" : run.id,
    results: run.inputs.map((row) => ({
      id: row.id,
      sentiment: "negative",
      topics: ["delivery"],
      quote: row.text.slice(0, 12),
      note: "Synthetic browser fixture",
    })),
  });
  await db.insert(messages).values({
    id: crypto.randomUUID(),
    conversationId: run.conversationId,
    role: "assistant",
    mode: "chat",
    content,
    createdAt: new Date(),
  });
  return c.json({ success: true });
});
app.post("/__fixture/conflict", async (c) => {
  const { workspaceId } = await c.req.json();
  const workspace = await getReviewWorkspace("reviews-browser-user", workspaceId);
  await db
    .update(reviewWorkspaces)
    .set({ revision: workspace.revision + 1 })
    .where(eq(reviewWorkspaces.id, workspaceId));
  return c.json({ success: true });
});
app.post("/__fixture/delete-source", async (c) => {
  const { workspaceId } = await c.req.json();
  const workspace = await getReviewWorkspace("reviews-browser-user", workspaceId);
  const conversationId = workspace.data.runs[0]?.conversationId;
  if (conversationId)
    await db.delete(conversationTable).where(eq(conversationTable.id, conversationId));
  return c.json({ success: true });
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    server.stop(true);
    client.close();
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
