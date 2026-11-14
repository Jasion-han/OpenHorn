import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "openhorn-backup-provider-state-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(directory, "fixture.db")}`;
process.env.OPENHORN_TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.OPENHORN_DATA_DIR = directory;
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.OPENHORN_JEV_ENABLED = "false";
delete process.env.OPENHORN_JEV_API_KEY;
let networkAttempts = 0;
globalThis.fetch = Object.assign(
  async () => {
    networkAttempts++;
    throw new Error("Provider state backup regression must never use the network");
  },
  { preconnect() {} },
);

const { client, db } = await import("../db");
try {
  const { PROVIDER_CHAT_STATE_MAX_BYTES } = await import("adapters");
  const { conversations, messages, users } = await import("db");
  const { eq } = await import("drizzle-orm");
  const { bootstrapDatabase } = await import("../db/bootstrap");
  const { exportBackup } = await import("./exportService");
  const { extractZipEntries, importOpenHornBackup } = await import("./importService");
  const { getImportRecord } = await import("./importRecordsService");
  await bootstrapDatabase({ backup: null });

  const state = (signature: string) => ({
    provider: "deepseek",
    origin: "https://api.deepseek.com",
    model: "deepseek-flash",
    serverToolCalls: [
      {
        index: 0,
        reasoning_content: "Original search context",
        calls: [
          {
            index: 0,
            id: "original-read-call",
            type: "deepseek_read_url",
            kind: "read_link",
            action: { type: "read_link", url: "https://example.invalid/source" },
            status: "completed",
            signature,
          },
        ],
      },
    ],
  });
  const signature = 'opaque+/==\n"quoted"\\bytes-\u0000-中文-😀';
  const valid = JSON.stringify(state(signature));
  const boundarySignature =
    signature + "x".repeat(PROVIDER_CHAT_STATE_MAX_BYTES - Buffer.byteLength(valid));
  const boundary = JSON.stringify(state(boundarySignature));
  assert.equal(Buffer.byteLength(boundary), PROVIDER_CHAT_STATE_MAX_BYTES);
  const oversized = JSON.stringify(state("x".repeat(PROVIDER_CHAT_STATE_MAX_BYTES)));
  const multibyteOversized = JSON.stringify(state("😀".repeat(70000)));
  assert.ok(multibyteOversized.length < PROVIDER_CHAT_STATE_MAX_BYTES);
  assert.ok(Buffer.byteLength(multibyteOversized) > PROVIDER_CHAT_STATE_MAX_BYTES);

  type Case = {
    id: string;
    role: "assistant" | "user";
    mode: "chat" | "agent";
    providerState: string | null;
    agentRun?: string;
    retained: boolean;
  };
  const cases: Case[] = [
    { id: "valid", role: "assistant", mode: "chat", providerState: valid, retained: true },
    { id: "boundary", role: "assistant", mode: "chat", providerState: boundary, retained: true },
    { id: "oversized", role: "assistant", mode: "chat", providerState: oversized, retained: false },
    {
      id: "multibyte-oversized",
      role: "assistant",
      mode: "chat",
      providerState: multibyteOversized,
      retained: false,
    },
    {
      id: "invalid-json",
      role: "assistant",
      mode: "chat",
      providerState: "{broken",
      retained: false,
    },
    {
      id: "foreign-origin",
      role: "assistant",
      mode: "chat",
      providerState: JSON.stringify({ ...state(signature), origin: "https://gateway.invalid" }),
      retained: false,
    },
    {
      id: "foreign-model",
      role: "assistant",
      mode: "chat",
      providerState: JSON.stringify({ ...state(signature), model: "other-model" }),
      retained: false,
    },
    {
      id: "bad-call-schema",
      role: "assistant",
      mode: "chat",
      providerState: JSON.stringify({
        ...state(signature),
        serverToolCalls: [{ index: 0, calls: [{ signature: 123 }] }],
      }),
      retained: false,
    },
    { id: "agent-mode", role: "assistant", mode: "agent", providerState: valid, retained: false },
    {
      id: "agent-run",
      role: "assistant",
      mode: "chat",
      providerState: valid,
      retained: false,
      agentRun: JSON.stringify({
        status: "completed",
        toolCount: 0,
        summary: "Fixture",
        steps: [{ type: "text", content: "agent-run" }],
      }),
    },
    { id: "user", role: "user", mode: "chat", providerState: valid, retained: false },
    { id: "plain", role: "assistant", mode: "chat", providerState: null, retained: false },
  ];
  const now = new Date("2026-11-14T00:00:00Z");
  const userId = crypto.randomUUID(),
    conversationId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@backup.invalid`,
    username: "Backup state fixture",
    passwordHash: "synthetic-only",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "Provider state backup round trip",
    defaultMode: "chat",
    lastMode: "chat",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values(
    cases.map((item, index) => ({
      id: item.id,
      conversationId,
      role: item.role,
      mode: item.mode,
      content: item.id,
      model: "deepseek-flash",
      providerState: item.providerState,
      agentRun: item.agentRun ?? null,
      createdAt: new Date(now.getTime() + index * 1000),
    })),
  );

  const exported = await exportBackup(userId, path.join(directory, "exports"));
  const archive = await extractZipEntries(exported.filePath);
  const archivedMessages = JSON.parse(
    archive.get("messages.json")?.toString("utf8") ?? "null",
  ) as Array<{ id: string; providerState: string | null }>;
  assert.equal(exported.manifest.contents.conversations, 1);
  assert.equal(exported.manifest.contents.messages, cases.length);
  // Confirm the real exporter actually carried every hostile value to the import boundary.
  for (const item of cases) {
    assert.equal(
      archivedMessages.find((row) => row.id === item.id)?.providerState,
      item.providerState,
    );
  }

  await db.delete(messages).where(eq(messages.conversationId, conversationId));
  await db.delete(conversations).where(eq(conversations.id, conversationId));
  assert.equal(
    (await db.select().from(messages).where(eq(messages.conversationId, conversationId))).length,
    0,
  );
  assert.equal(
    (await db.select().from(conversations).where(eq(conversations.id, conversationId))).length,
    0,
  );

  const result = await importOpenHornBackup(userId, exported.filePath);
  assert.equal(result.backupFailure, undefined);
  assert.deepEqual(result.conversations, { imported: 1, skipped: 0 });
  assert.equal(result.messages.imported, cases.length);
  const restored = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  assert.equal(restored.length, cases.length);
  for (const item of cases) {
    const row = restored.find((row) => row.id === item.id);
    assert.ok(row, `Missing restored message: ${item.id}`);
    assert.equal(
      row.providerState,
      item.retained ? item.providerState : null,
      `Wrong restored state: ${item.id}`,
    );
    assert.equal(row.content, item.id);
  }
  // Compare decoded signatures as well as the complete serialized state, including the byte limit.
  assert.equal(
    JSON.parse(restored.find((row) => row.id === "valid")?.providerState ?? "null")
      .serverToolCalls[0].calls[0].signature,
    signature,
  );
  assert.equal(
    JSON.parse(restored.find((row) => row.id === "boundary")?.providerState ?? "null")
      .serverToolCalls[0].calls[0].signature,
    boundarySignature,
  );
  const expectedWarnings = cases
    .filter((item) => item.providerState && !item.retained)
    .map((item) => `Message ${item.id}: invalid provider continuation state was omitted`)
    .sort();
  assert.deepEqual([...result.errors].sort(), expectedWarnings);
  assert.ok(result.recordId);
  const history = await getImportRecord(userId, result.recordId);
  assert.equal(history?.source, "file");
  assert.equal(history?.kind, "backup");
  assert.deepEqual(history?.errors.slice().sort(), expectedWarnings);
  assert.equal(networkAttempts, 0);
  console.log(
    JSON.stringify({
      messages: restored.length,
      retained: cases.filter((item) => item.retained).length,
      clearedWithWarnings: expectedWarnings.length,
      boundaryBytes: Buffer.byteLength(boundary),
      signatureExact: true,
      deletedBeforeImport: true,
      agentStateCleared: true,
      warningsPersisted: true,
      networkAttempts,
    }),
  );
} finally {
  client.close();
  rmSync(directory, { recursive: true, force: true });
}
