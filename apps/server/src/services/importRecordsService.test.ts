import { expect, test } from "bun:test";
import { importRecords, users } from "db";
import { eq } from "drizzle-orm";
import { IMPORT_PART_ITEMS_LIMIT } from "shared/constants";
import { db } from "../db";
import {
  addPartItem,
  createImportRecord,
  createPart,
  deleteImportRecord,
  getImportRecord,
  listImportRecords,
  sanitizeParts,
} from "./importRecordsService";

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
  await db.delete(importRecords).where(eq(importRecords.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

test("createPart/addPartItem: counters follow item status and items cap at the limit", () => {
  const part = createPart("mcp", "note");
  expect(part).toEqual({
    type: "mcp",
    imported: 0,
    skipped: 0,
    needsAction: 0,
    note: "note",
    items: [],
  });
  for (let i = 0; i < IMPORT_PART_ITEMS_LIMIT + 5; i++) {
    addPartItem(part, { label: `s${i}`, status: "imported" });
  }
  addPartItem(part, { label: "dup", status: "skipped" });
  addPartItem(part, { label: "broken", status: "needsAction", link: { kind: "mcp", id: "x" } });
  expect(part.imported).toBe(IMPORT_PART_ITEMS_LIMIT + 5);
  expect(part.skipped).toBe(1);
  expect(part.needsAction).toBe(1);
  expect(part.items).toHaveLength(IMPORT_PART_ITEMS_LIMIT);
});

test("sanitizeParts: drops unknown part types, bad items and unknown link kinds; keeps counters", () => {
  const parts = sanitizeParts([
    {
      type: "skills",
      imported: 2,
      skipped: -1,
      needsAction: "x",
      note: "n",
      items: [
        { label: "a", status: "imported", link: { kind: "skill", id: "a" } },
        { label: "b", status: "imported", link: { kind: "nope", id: "b" }, detail: "d" },
        { label: "", status: "imported" },
        { label: "c", status: "weird" },
        "junk",
      ],
    },
    { type: "not-a-type", items: [] },
    "junk",
  ]);
  expect(parts).toHaveLength(1);
  expect(parts[0].type).toBe("skills");
  expect(parts[0].imported).toBe(2);
  expect(parts[0].skipped).toBe(0);
  expect(parts[0].needsAction).toBe(0);
  expect(parts[0].note).toBe("n");
  expect(parts[0].items).toEqual([
    { label: "a", status: "imported", link: { kind: "skill", id: "a" } },
    { label: "b", status: "imported", detail: "d" },
  ]);
});

test("import records: create/get/list(desc, cursor paging)/delete with user isolation", async () => {
  const u1 = await seedUser();
  const u2 = await seedUser();
  try {
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const part = createPart("conversations");
      addPartItem(part, {
        label: `conv ${i}`,
        status: "imported",
        link: { kind: "conversation", id: `c${i}` },
      });
      if (i % 2 === 0) addPartItem(part, { label: "needs key", status: "needsAction" });
      const record = await createImportRecord(u1, {
        source: i === 0 ? "file" : "claude-code",
        kind: i === 0 ? "backup" : "local",
        parts: [part],
        errors: i === 4 ? ["boom"] : [],
      });
      created.push(record.id);
      // created_at is stored at second precision; make ordering unambiguous.
      await db
        .update(importRecords)
        .set({ createdAt: new Date(1_800_000_000_000 + i * 1000) })
        .where(eq(importRecords.id, record.id));
    }
    await createImportRecord(u2, {
      source: "codex",
      kind: "local",
      parts: [createPart("prompts")],
    });

    const page1 = await listImportRecords(u1, { limit: 2 });
    expect(page1.records.map((r) => r.id)).toEqual([created[4], created[3]]);
    expect(page1.records[0].errors).toEqual(["boom"]);
    expect(page1.records[0].totalImported).toBe(1);
    expect(page1.records[0].totalNeedsAction).toBe(1);
    expect(page1.records[1].totalNeedsAction).toBe(0);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await listImportRecords(u1, { limit: 2, cursor: page1.nextCursor });
    expect(page2.records.map((r) => r.id)).toEqual([created[2], created[1]]);
    const page3 = await listImportRecords(u1, { limit: 2, cursor: page2.nextCursor });
    expect(page3.records.map((r) => r.id)).toEqual([created[0]]);
    expect(page3.nextCursor).toBeUndefined();
    expect(page3.records[0].source).toBe("file");
    expect(page3.records[0].kind).toBe("backup");
    expect(page3.records[0].parts[0].items[0].link).toEqual({ kind: "conversation", id: "c0" });

    // Isolation
    expect(await getImportRecord(u2, created[0])).toBeNull();
    expect(await deleteImportRecord(u2, created[0])).toBe(false);
    expect((await listImportRecords(u2)).records).toHaveLength(1);

    expect(await deleteImportRecord(u1, created[0])).toBe(true);
    expect(await getImportRecord(u1, created[0])).toBeNull();
    expect((await listImportRecords(u1)).records).toHaveLength(4);

    await expect(
      createImportRecord(u1, { source: "nope" as never, kind: "local", parts: [] }),
    ).rejects.toThrow("invalid import source");
  } finally {
    await cleanupUser(u1);
    await cleanupUser(u2);
  }
});

test("legacy rows: retired part types are dropped on read and totals re-derived from the rest", async () => {
  const userId = await seedUser();
  try {
    const id = crypto.randomUUID();
    // Written by a build that still emitted a `messages` part and counted it in total_imported.
    await db.insert(importRecords).values({
      id,
      userId,
      source: "claude-code",
      kind: "local",
      parts: JSON.stringify([
        { type: "conversations", imported: 2, skipped: 0, needsAction: 0, items: [] },
        { type: "messages", imported: 143, skipped: 0, needsAction: 0, items: [] },
      ]),
      errors: "[]",
      totalImported: 145,
      totalNeedsAction: 0,
      createdAt: new Date(),
    });
    const record = await getImportRecord(userId, id);
    expect(record?.parts.map((p) => p.type)).toEqual(["conversations"]);
    expect(record?.totalImported).toBe(2);
  } finally {
    await cleanupUser(userId);
  }
});
