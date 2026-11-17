import { expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { attachments, conversations, users } from "db";
import { Hono } from "hono";

const directory = await mkdtemp(path.join(tmpdir(), "openhorn-document-upload-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(directory, "test.db")}`;
process.env.OPENHORN_DATA_DIR = path.join(directory, "data");
const localFetch = globalThis.fetch;
let server: ReturnType<typeof Bun.serve> | undefined;
globalThis.fetch = (async () => {
  throw new Error("External requests forbidden in upload regression");
}) as unknown as typeof fetch;
const { bootstrapDatabase } = await import("../db/bootstrap");
const { db, client } = await import("../db");
const quiet = console.log;
console.log = () => {};
try {
  await bootstrapDatabase();
  let owner = await db
    .select()
    .from(users)
    .limit(1)
    .then((rows) => rows[0]);
  if (!owner) {
    const id = crypto.randomUUID();
    await db.insert(users).values({
      id,
      email: "document@test.invalid",
      username: "Synthetic",
      passwordHash: "synthetic",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    owner = await db
      .select()
      .from(users)
      .limit(1)
      .then((rows) => rows[0]);
  }
  const conversationId = crypto.randomUUID();
  await db.insert(conversations).values({
    id: conversationId,
    userId: owner.id,
    title: "Synthetic document upload",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const { default: route } = await import("../routes/attachments");
  const app = new Hono().route("/attachments", route);
  const names = ["a.pdf", "a.pdf [page 1].jpg", "b.pdf", "b.pdf [page 2].jpg"];
  const form = new FormData();
  form.append("conversationId", conversationId);
  for (const [index, name] of names.entries())
    form.append(
      "files",
      new File([new Uint8Array([255, 216, 255, index, 255, 217])], name, {
        type: name.endsWith(".pdf") ? "application/pdf" : "image/jpeg",
      }),
    );
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const response = await localFetch(`http://127.0.0.1:${server.port}/attachments/upload`, {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(201);
  const result = (await response.json()) as {
    attachments: Array<{ id: string; fileName: string }>;
  };
  expect(result.attachments.map((item) => item.fileName)).toEqual(names);
  const rows = await db.select().from(attachments);
  expect(rows).toHaveLength(4);
  for (const [index, item] of result.attachments.entries()) {
    const stored = rows.find((row) => row.id === item.id);
    if (!stored) throw new Error("Missing stored attachment");
    const bytes = await readFile(stored.filePath);
    if (bytes[3] !== index)
      throw new Error(
        JSON.stringify({
          name: stored.fileName,
          declaredSize: stored.fileSize,
          bytes: [...bytes],
          expected: index,
        }),
      );
    expect(bytes[3]).toBe(index);
  }
  const ambiguous = new FormData();
  ambiguous.append("conversationId", conversationId);
  ambiguous.append("conversationId", conversationId);
  ambiguous.append("files", new File(["x"], "x.txt", { type: "text/plain" }));
  expect(
    (await app.request("/attachments/upload", { method: "POST", body: ambiguous })).status,
  ).toBe(400);
  expect(await db.select().from(attachments)).toHaveLength(4);
  console.log = quiet;
  console.log(
    JSON.stringify({
      multipartFiles: 4,
      exactFileBytesAndIdentity: true,
      ambiguousScopeRejected: true,
    }),
  );
} finally {
  console.log = quiet;
  server?.stop(true);
  client.close();
  await rm(directory, { recursive: true, force: true });
}
