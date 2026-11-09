import { afterAll, expect, mock, test } from "bun:test";
import { attachments, conversations, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import * as embeddingNamespace from "./embeddingService";
import type { DocumentChunk } from "./vectorStore";
import * as vectorNamespace from "./vectorStore";

const originalEmbedding = { ...embeddingNamespace };
const originalVectors = { ...vectorNamespace };
let chunks: DocumentChunk[] = [];
let embeddingCalls = 0;
let onEmbed: (() => Promise<void>) | null = null;
let onSearch: (() => Promise<void>) | null = null;
let onAdd: (() => Promise<void>) | null = null;
mock.module("./embeddingService", () => ({
  ...originalEmbedding,
  generateEmbeddings: async (texts: string[]) => {
    embeddingCalls++;
    await onEmbed?.();
    return texts.map(() => [1, 0]);
  },
}));
mock.module("./vectorStore", () => ({
  ...originalVectors,
  hasChunksForUser: async (userId: string) => chunks.some((row) => row.userId === userId),
  searchChunks: async (_vector: number[], userId: string) => {
    await onSearch?.();
    return chunks.filter((row) => row.userId === userId);
  },
  addChunks: async (rows: DocumentChunk[]) => {
    await onAdd?.();
    chunks.push(...rows);
  },
  deleteChunksByAttachment: async (id: string) => {
    chunks = chunks.filter((row) => row.attachmentId !== id);
  },
}));
const { indexAttachment, retrieveContext } = await import("./ragService");
afterAll(() => {
  mock.module("./embeddingService", () => originalEmbedding);
  mock.module("./vectorStore", () => originalVectors);
});

async function fixture(
  run: (ids: {
    userId: string;
    conversationId: string;
    attachmentId: string;
    foreignUserId: string;
    foreignConversationId: string;
    foreignAttachmentId: string;
  }) => Promise<void>,
) {
  const ids = Object.fromEntries(
    [
      "userId",
      "conversationId",
      "attachmentId",
      "foreignUserId",
      "foreignConversationId",
      "foreignAttachmentId",
    ].map((key) => [key, crypto.randomUUID()]),
  ) as Parameters<typeof run>[0];
  const now = new Date();
  chunks = [];
  embeddingCalls = 0;
  onEmbed = null;
  onSearch = null;
  onAdd = null;
  await db.insert(users).values(
    [ids.userId, ids.foreignUserId].map((id) => ({
      id,
      email: `${id}@test.local`,
      username: "rag-integrity",
      passwordHash: "x",
      createdAt: now,
      updatedAt: now,
    })),
  );
  await db.insert(conversations).values(
    [
      { id: ids.conversationId, userId: ids.userId },
      { id: ids.foreignConversationId, userId: ids.foreignUserId },
    ].map((row) => ({ ...row, title: "fixture", createdAt: now, updatedAt: now })),
  );
  await db.insert(attachments).values(
    [
      { id: ids.attachmentId, conversationId: ids.conversationId },
      { id: ids.foreignAttachmentId, conversationId: ids.foreignConversationId },
    ].map((row) => ({
      ...row,
      fileName: "source.txt",
      filePath: "/synthetic/source.txt",
      fileType: "text/plain",
      fileSize: 1,
      createdAt: now,
    })),
  );
  try {
    await run(ids);
  } finally {
    for (const id of [ids.conversationId, ids.foreignConversationId]) {
      await db.delete(attachments).where(eq(attachments.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    for (const id of [ids.userId, ids.foreignUserId])
      await db.delete(users).where(eq(users.id, id));
    chunks = [];
    onEmbed = null;
    onSearch = null;
    onAdd = null;
  }
}
const record = (
  ids: { userId: string; conversationId: string; attachmentId: string },
  text = "PRIVATE-SOURCE",
): DocumentChunk => ({
  ...ids,
  id: crypto.randomUUID(),
  chunkIndex: 0,
  text,
  vector: [1, 0],
  fileName: "source.txt",
  createdAt: Date.now(),
});
function gate() {
  let release!: () => void;
  let held!: () => void;
  const waiting = new Promise<void>((resolve) => {
    held = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    waiting,
    release,
    hold: async () => {
      held();
      await pending;
    },
  };
}

test("RAG excludes deleted sources and skips pointless embedding when no live source remains", async () => {
  await fixture(async (ids) => {
    chunks = [record(ids)];
    await db.delete(attachments).where(eq(attachments.id, ids.attachmentId));
    expect(await retrieveContext("query", ids.userId, "synthetic-only")).toBe("");
    expect(embeddingCalls).toBe(0);
  });
});
test("RAG result visibility requires the live attachment owner and exact conversation", async () => {
  await fixture(async (ids) => {
    chunks = [
      record(ids, "VISIBLE"),
      record({ ...ids, attachmentId: ids.foreignAttachmentId }, "FOREIGN"),
      record({ ...ids, conversationId: ids.foreignConversationId }, "MISMATCHED"),
    ];
    const context = await retrieveContext("query", ids.userId, "synthetic-only");
    expect(context.includes("VISIBLE")).toBe(true);
    expect(context.includes("FOREIGN")).toBe(false);
    expect(context.includes("MISMATCHED")).toBe(false);
  });
});
test("deleting a source while vector search awaits prevents its late result entering the prompt", async () => {
  await fixture(async (ids) => {
    chunks = [record(ids)];
    const hold = gate();
    onSearch = hold.hold;
    const reading = retrieveContext("query", ids.userId, "synthetic-only");
    await hold.waiting;
    await db.delete(attachments).where(eq(attachments.id, ids.attachmentId));
    hold.release();
    expect(await reading).toBe("");
  });
});
for (const phase of ["embedding", "add"] as const) {
  test(`deletion during ${phase} prevents late indexing from leaving source chunks`, async () => {
    await fixture(async (ids) => {
      const hold = gate();
      if (phase === "embedding") onEmbed = hold.hold;
      else onAdd = hold.hold;
      const indexing = indexAttachment(
        ids.attachmentId,
        ids.userId,
        ids.conversationId,
        "source.txt",
        "PRIVATE-SOURCE",
        "synthetic-only",
      );
      await hold.waiting;
      await db.delete(attachments).where(eq(attachments.id, ids.attachmentId));
      hold.release();
      await indexing;
      expect(chunks).toHaveLength(0);
    });
  });
}
test("indexing missing or wrongly owned source IDs performs no embedding or vector write", async () => {
  await fixture(async (ids) => {
    await indexAttachment(
      crypto.randomUUID(),
      ids.userId,
      ids.conversationId,
      "source.txt",
      "PRIVATE-SOURCE",
      "synthetic-only",
    );
    await indexAttachment(
      ids.foreignAttachmentId,
      ids.userId,
      ids.conversationId,
      "source.txt",
      "PRIVATE-SOURCE",
      "synthetic-only",
    );
    expect(embeddingCalls).toBe(0);
    expect(chunks).toHaveLength(0);
  });
});
test("an owned live source indexes and retrieves normally while an empty store stays cheap", async () => {
  await fixture(async (ids) => {
    expect(await retrieveContext("query", ids.userId, "synthetic-only")).toBe("");
    expect(embeddingCalls).toBe(0);
    await indexAttachment(
      ids.attachmentId,
      ids.userId,
      ids.conversationId,
      "source.txt",
      "LIVE-SOURCE",
      "synthetic-only",
    );
    expect(chunks).toHaveLength(1);
    expect(
      (await retrieveContext("query", ids.userId, "synthetic-only")).includes("LIVE-SOURCE"),
    ).toBe(true);
  });
});

test("deleting a multi-batch source stops later embedding batches", async () => {
  await fixture(async (ids) => {
    const hold = gate();
    onEmbed = hold.hold;
    const text = Array.from({ length: 101 }, (_, index) => `# Section ${index}\nSource text`).join(
      "\n\n",
    );
    const indexing = indexAttachment(
      ids.attachmentId,
      ids.userId,
      ids.conversationId,
      "source.md",
      text,
      "synthetic-only",
    );
    await hold.waiting;
    await db.delete(attachments).where(eq(attachments.id, ids.attachmentId));
    hold.release();
    await indexing;
    expect(embeddingCalls).toBe(1);
    expect(chunks).toHaveLength(0);
  });
});

test("deleting a source during the semantic rerank await prevents stale context injection", async () => {
  await fixture(async (ids) => {
    chunks = [record(ids)];
    const result = await retrieveContext(
      "query",
      ids.userId,
      "synthetic",
      undefined,
      5,
      async (_user, _query, rows) => {
        await db.delete(attachments).where(eq(attachments.id, ids.attachmentId));
        return rows;
      },
    );
    expect(result).toBe("");
  });
});

test("semantic rerank evaluates the same bounded document excerpt the answering model sees", async () => {
  await fixture(async (ids) => {
    chunks = [record(ids, "x".repeat(2800))];
    const context = await retrieveContext(
      "query",
      ids.userId,
      "synthetic",
      undefined,
      5,
      async (_u, _q, rows, text) => {
        expect(text(rows[0])).toHaveLength(800);
        return rows;
      },
    );
    expect(context.includes("x".repeat(800))).toBe(true);
    expect(context.includes("x".repeat(801))).toBe(false);
  });
});
