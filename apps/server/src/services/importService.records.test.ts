import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { channels, conversations, importRecords, mcpServers, messages, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { getImportRecord } from "./importRecordsService";
import { importChatGPT, importOpenHornBackup } from "./importService";
import { createMCPServer } from "./mcpService";

async function seedUser(): Promise<string> {
  const userId = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

async function cleanupUser(userId: string) {
  const convs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, userId));
  for (const c of convs) await db.delete(messages).where(eq(messages.conversationId, c.id));
  await db.delete(conversations).where(eq(conversations.userId, userId));
  await db.delete(mcpServers).where(eq(mcpServers.userId, userId));
  await db.delete(channels).where(eq(channels.userId, userId));
  await db.delete(importRecords).where(eq(importRecords.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

// Minimal STORE-only zip writer so the test does not depend on archiver's
// (major-version-sensitive) API; yauzl in importService reads it like any zip.
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeZip(zipPath: string, entries: Record<string, unknown>): Promise<void> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(JSON.stringify(value), "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  await writeFile(zipPath, Buffer.concat([...locals, ...centrals, end]));
}

test("chatgpt import: writes an import record and stamps conversations with imported_from=file", async () => {
  const userId = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-import-"));
  try {
    const file = path.join(dir, "conversations.json");
    await writeFile(
      file,
      JSON.stringify([
        {
          title: "Hello thread",
          create_time: 1_700_000_000,
          update_time: 1_700_000_100,
          current_node: "n2",
          mapping: {
            n1: {
              id: "n1",
              parent: null,
              children: ["n2"],
              message: {
                id: "n1",
                author: { role: "user" },
                content: { content_type: "text", parts: ["hi"] },
                create_time: 1_700_000_000,
              },
            },
            n2: {
              id: "n2",
              parent: "n1",
              children: [],
              message: {
                id: "n2",
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["hello"] },
                metadata: { model_slug: "gpt-4o" },
                create_time: 1_700_000_050,
              },
            },
          },
        },
      ]),
    );

    const result = await importChatGPT(userId, file);
    expect(result.conversations.imported).toBe(1);
    expect(result.messages.imported).toBe(2);
    expect(result.recordId).toBeDefined();

    const record = await getImportRecord(userId, result.recordId ?? "");
    expect(record?.source).toBe("file");
    expect(record?.kind).toBe("chatgpt");
    // Conversations only — messages are not a top-level unit.
    expect(record?.totalImported).toBe(1);
    const convPart = record?.parts.find((p) => p.type === "conversations");
    expect(convPart?.items[0].label).toBe("Hello thread");
    expect(convPart?.items[0].detail).toBe("2 条消息");
    expect(convPart?.items[0].link?.kind).toBe("conversation");
    expect(convPart?.note).toBe("共 2 条消息");
    expect(record?.parts.find((p) => p.type === ("messages" as string))).toBeUndefined();

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, convPart?.items[0].link?.id ?? ""));
    expect(conv.importedFrom).toBe("file");
    expect(conv.importedAt).not.toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanupUser(userId);
  }
});

test("backup import: dedupes MCP servers by name, stamps new ones, and records needsAction items", async () => {
  const userId = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-import-"));
  try {
    const existing = await createMCPServer(userId, { name: "fs", type: "stdio", config: { a: 1 } });
    const convId = crypto.randomUUID();
    const now = Date.now();
    const zipPath = path.join(dir, "backup.zip");
    await writeZip(zipPath, {
      "manifest.json": {
        formatVersion: "1",
        exportedAt: new Date().toISOString(),
        appVersion: "test",
        contents: {},
      },
      "conversations.json": [
        {
          id: convId,
          title: "Backed up",
          contextLength: 4096,
          createdAt: now,
          updatedAt: now,
        },
      ],
      "messages.json": [
        {
          id: crypto.randomUUID(),
          conversationId: convId,
          role: "user",
          content: "x",
          createdAt: now,
        },
      ],
      "mcp-servers.json": [
        {
          id: crypto.randomUUID(),
          name: "fs",
          type: "stdio",
          config: "{}",
          isEnabled: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: crypto.randomUUID(),
          name: "browser",
          type: "stdio",
          config: "{}",
          isEnabled: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      "channels.json": [
        {
          id: crypto.randomUUID(),
          name: "OpenAI main",
          provider: "openai",
          protocol: "openai",
          enabled: true,
          isDefault: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const result = await importOpenHornBackup(userId, zipPath);
    expect(result.mcpServers).toEqual({ imported: 1, skipped: 1, needsConfirm: 1 });
    expect(result.conversations.imported).toBe(1);
    expect(result.channels.needsKey).toBe(1);

    const servers = await db.select().from(mcpServers).where(eq(mcpServers.userId, userId));
    expect(servers).toHaveLength(2);
    const fs = servers.find((s) => s.id === existing.id);
    expect(fs?.importedFrom).toBeNull();
    const browser = servers.find((s) => s.name === "browser");
    expect(browser?.importedFrom).toBe("file");

    const record = await getImportRecord(userId, result.recordId ?? "");
    expect(record?.kind).toBe("backup");
    const mcpPart = record?.parts.find((p) => p.type === "mcp");
    expect(mcpPart?.skipped).toBe(1);
    expect(mcpPart?.needsAction).toBe(1);
    expect(mcpPart?.items.find((i) => i.label === "fs")?.link).toEqual({
      kind: "mcp",
      id: existing.id,
    });
    const channelPart = record?.parts.find((p) => p.type === "channels");
    expect(channelPart?.needsAction).toBe(1);
    expect(record?.totalNeedsAction).toBe(2);

    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    expect(conv.importedFrom).toBe("file");

    // Second run: everything already present → nothing new, but still recorded.
    const again = await importOpenHornBackup(userId, zipPath);
    expect(again.conversations).toEqual({ imported: 0, skipped: 1 });
    expect(again.mcpServers).toEqual({ imported: 0, skipped: 2, needsConfirm: 0 });
    expect(again.recordId).toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
    await db.delete(mcpServers).where(eq(mcpServers.userId, userId));
    await cleanupUser(userId);
  }
});
