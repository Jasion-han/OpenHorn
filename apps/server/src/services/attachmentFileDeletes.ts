import { realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { attachmentFileDeletes, attachments } from "db";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "../db";
import { resolveDataDir } from "./attachmentService";

// Only the two server-owned blob directories can be reclaimed. In particular
// never interpret a local: marker or a path through a redirected directory.
async function unlinkManaged(file: string) {
  const dir = path.dirname(file);
  const roots = [
    path.resolve(resolveDataDir(), "attachments"),
    path.resolve(resolveDataDir(), "uploads"),
  ];
  const root = roots.find((r) => file.startsWith(r + path.sep));
  if (!root) return;
  try {
    const [actualRoot, parent] = await Promise.all([realpath(root), realpath(dir)]);
    if (parent !== actualRoot && !parent.startsWith(actualRoot + path.sep)) return;
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function drainAttachmentFileDeletes(conversationId?: string) {
  let cursor = "";
  for (;;) {
    const rows = await db
      .select()
      .from(attachmentFileDeletes)
      .where(
        and(
          gt(attachmentFileDeletes.filePath, cursor),
          conversationId === undefined
            ? undefined
            : eq(attachmentFileDeletes.conversationId, conversationId),
        ),
      )
      .orderBy(asc(attachmentFileDeletes.filePath))
      .limit(128);
    if (!rows.length) return;
    for (const { filePath } of rows) {
      cursor = filePath;
      const [referenced] = await db
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.filePath, filePath))
        .limit(1);
      try {
        if (!referenced) await unlinkManaged(filePath);
        await db.delete(attachmentFileDeletes).where(eq(attachmentFileDeletes.filePath, filePath));
      } catch {
        console.warn("[attachments] deferred file cleanup will retry");
      }
    }
  }
}
