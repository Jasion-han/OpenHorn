import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { attachmentFileDeletes, attachments, conversations, users } from "db";
import { client, db } from "../db";
import { bootstrapDatabase } from "../db/bootstrap";
import { drainAttachmentFileDeletes } from "./attachmentFileDeletes";
import { applyConversationDeletion, planConversationDeletion } from "./conversationService";

const root = process.env.OPENHORN_DATA_DIR;
assert.ok(root);
assert.equal(process.env.DATABASE_URL, `file:${path.join(root, "temporary.db")}`);
const file = path.join(root, "attachments", "chat", "synthetic.txt");
await bootstrapDatabase({ backup: null });
if (process.argv[2] === "delete") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "original");
  const dates = { createdAt: new Date(), updatedAt: new Date() };
  await db
    .insert(users)
    .values({ id: "fixture", email: "fixture@example.invalid", username: "fixture", ...dates });
  await db
    .insert(conversations)
    .values({ id: "chat", userId: "fixture", title: "fixture", ...dates });
  await db.insert(attachments).values({
    id: "file",
    conversationId: "chat",
    filePath: file,
    fileName: "synthetic.txt",
    fileType: "text/plain",
    fileSize: 8,
    createdAt: new Date(),
  });
  const plan = await planConversationDeletion("fixture", "chat");
  assert.ok(plan);
  await assert.rejects(
    db.transaction(async (tx) => {
      await applyConversationDeletion(tx, plan);
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal((await db.select().from(attachmentFileDeletes)).length, 0);
  await access(file);
  await db.transaction((tx) => applyConversationDeletion(tx, plan));
  assert.equal((await db.select().from(attachmentFileDeletes)).length, 1);
  await access(file);
  // Exit before post-commit cleanup; recovery below runs in a fresh process.
} else {
  const unrelated = path.join(root, "unmanaged.txt");
  await writeFile(unrelated, "keep");
  await db.insert(attachmentFileDeletes).values({ filePath: unrelated, conversationId: "chat" });
  await drainAttachmentFileDeletes();
  await access(unrelated);
  await drainAttachmentFileDeletes();
  await assert.rejects(access(file), { code: "ENOENT" });
  assert.equal((await db.select().from(attachmentFileDeletes)).length, 0);
}
client.close();
