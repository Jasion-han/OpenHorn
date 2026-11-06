/** Dedicated local database/server for attachment acceptance; never imports normal app data. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = await mkdtemp(join(tmpdir(), "openhorn-matrix-server-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${join(scratch, "test.db")}`;
process.env.OPENHORN_DATA_DIR = join(scratch, "uploads");
process.env.ENCRYPTION_KEY = "attachment-matrix-test-only-key-32";
const { bootstrapDatabase } = await import("../src/db/bootstrap");
await bootstrapDatabase();
const { db } = await import("../src/db");
const { users, conversations } = await import("db");
const { Hono } = await import("hono");
const { cors } = await import("hono/cors");
const routes = (await import("../src/routes/attachments")).default;
const localUser = (await db.select().from(users).limit(1))[0];
const userId = localUser?.id ?? crypto.randomUUID();
const conversationId = crypto.randomUUID();
const now = new Date();
if (!localUser)
  await db.insert(users).values({
    id: userId,
    email: "attachment-matrix@test.local",
    username: "matrix",
    passwordHash: "test-only",
    createdAt: now,
    updatedAt: now,
  });
await db.insert(conversations).values({
  id: conversationId,
  userId,
  title: "Synthetic attachment test",
  createdAt: now,
  updatedAt: now,
});
const app = new Hono();
app.use(
  "*",
  cors({
    origin: (origin) => (/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) ? origin : ""),
    credentials: true,
  }),
);
app.route("/attachments", routes);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
console.log(
  JSON.stringify({
    kind: "attachmentMatrixServer",
    url: `http://127.0.0.1:${server.port}`,
    conversationId,
    scratch,
  }),
);
