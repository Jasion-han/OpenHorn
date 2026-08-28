import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentSessions, attachments, channels, conversations } from "db";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { decrypt, generateId } from "../utils";
import { formatAttachmentContext, parseAttachmentContent } from "./attachmentParser";

export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

/**
 * Marker prefix used as `filePath` for attachments that were only ever
 * referenced by a local sidecar run. No blob exists on this server for them.
 */
export const LOCAL_ATTACHMENT_PATH_PREFIX = "local:";

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

const EXTENSION_MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

export function isAllowedMimeType(mime: string) {
  return ALLOWED_MIME_TYPES.has(mime);
}

function resolveMimeType(file: File) {
  if (isAllowedMimeType(file.type)) {
    return file.type;
  }

  const lowerName = file.name.toLowerCase();
  const extension = Object.keys(EXTENSION_MIME_MAP).find((ext) => lowerName.endsWith(ext));

  if (extension) {
    return EXTENSION_MIME_MAP[extension];
  }

  return file.type || "";
}

export function buildAttachmentDir(input: { conversationId?: string; sessionId?: string }) {
  const dataDir = resolveDataDir();
  if (input.sessionId) {
    return join(dataDir, "attachments", "agent", input.sessionId);
  }

  if (!input.conversationId) {
    throw new Error("conversationId or sessionId is required");
  }

  return join(dataDir, "attachments", input.conversationId);
}

function sanitizeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function resolveDataDir() {
  if (process.env.OPENHORN_DATA_DIR) {
    return process.env.OPENHORN_DATA_DIR;
  }

  const rootDataDir = join(process.cwd(), "..", "..", "data");
  if (existsSync(rootDataDir)) {
    return rootDataDir;
  }

  const localDataDir = join(process.cwd(), "data");
  if (existsSync(localDataDir)) {
    return localDataDir;
  }

  return localDataDir;
}

/**
 * Resolve an OpenAI-compatible embedding API key for the given user.
 * Returns null when the user has no enabled OpenAI-compatible channel.
 */
export async function getEmbeddingApiKey(
  userId: string,
): Promise<{ apiKey: string; baseUrl?: string } | null> {
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.enabled, true)));

  // Prefer a channel whose protocol is explicitly "openai" (or null/empty,
  // which defaults to OpenAI-compatible).
  const openaiRow = rows.find((ch) => {
    const p = (ch.protocol || "").toLowerCase();
    return p === "openai" || p === "";
  });

  const row = openaiRow || rows[0];
  if (!row?.apiKey) return null;

  const apiKey = decrypt(row.apiKey);
  // Skip CLI-OAuth channels — they don't support the embeddings endpoint.
  if (apiKey.startsWith("__cli_oauth__")) return null;

  let baseUrl: string | undefined;
  if (row.baseUrl) {
    // Ensure the base URL ends with /v1 for OpenAI-compatible calls.
    let url = row.baseUrl.replace(/\/+$/, "");
    if (!url.match(/\/v\d+$/)) {
      url = `${url}/v1`;
    }
    baseUrl = url;
  }

  return { apiKey, baseUrl };
}

export async function storeAttachment(params: {
  conversationId?: string;
  sessionId?: string;
  file: File;
  /** Optional — when provided, enables background RAG indexing of text-based attachments. */
  userId?: string;
}) {
  const resolvedType = resolveMimeType(params.file);

  if (!isAllowedMimeType(resolvedType)) {
    throw new Error("Unsupported file type");
  }

  if (params.file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error("File too large");
  }

  const id = generateId();
  const dir = buildAttachmentDir(params);
  await mkdir(dir, { recursive: true });

  const safeName = sanitizeFileName(params.file.name);
  const filePath = join(dir, `${id}-${safeName}`);
  const buffer = Buffer.from(await params.file.arrayBuffer());

  await writeFile(filePath, buffer);

  await db.insert(attachments).values({
    id,
    conversationId: params.conversationId || null,
    sessionId: params.sessionId || null,
    messageId: null,
    fileName: params.file.name,
    filePath,
    fileType: resolvedType,
    fileSize: params.file.size,
    createdAt: new Date(),
  });

  // Fire-and-forget: asynchronously index text-based attachments into the
  // vector store for RAG retrieval. Images are skipped (no text to embed).
  if (params.userId && params.conversationId) {
    const capturedUserId = params.userId;
    const capturedConversationId = params.conversationId;
    const capturedFileName = params.file.name;
    const capturedFilePath = filePath;
    const capturedFileType = resolvedType;

    void (async () => {
      try {
        const creds = await getEmbeddingApiKey(capturedUserId);
        if (!creds) return;

        const text = await parseAttachmentContent({
          filePath: capturedFilePath,
          fileType: capturedFileType,
          fileName: capturedFileName,
        });
        // Skip images and empty content
        if (!text || text.startsWith("[Image:")) return;

        const { indexAttachment } = await import("./ragService");
        await indexAttachment(
          id,
          capturedUserId,
          capturedConversationId,
          capturedFileName,
          text,
          creds.apiKey,
          creds.baseUrl,
        );
      } catch (error) {
        // Best-effort: RAG indexing failure must never block attachment upload.
        console.error("[rag] indexing failed for attachment", id, error);
      }
    })();
  }

  return {
    id,
    fileName: params.file.name,
    filePath,
    fileType: resolvedType,
    fileSize: params.file.size,
  };
}

// Attachments have no direct `userId` column; ownership is derived from the owning
// conversation or agent session. Scope by joining to both so a user can only touch
// attachments they own — cross-user IDs are silently dropped (not linked, not read).
async function selectOwnedAttachments(attachmentIds: string[], userId: string) {
  if (attachmentIds.length === 0) return [];

  const rows = await db
    .select({
      attachment: attachments,
      convUserId: conversations.userId,
      sessUserId: agentSessions.userId,
    })
    .from(attachments)
    .leftJoin(conversations, eq(conversations.id, attachments.conversationId))
    .leftJoin(agentSessions, eq(agentSessions.id, attachments.sessionId))
    .where(inArray(attachments.id, attachmentIds));

  return rows
    .filter((row) => row.convUserId === userId || row.sessUserId === userId)
    .map((row) => row.attachment);
}

export async function linkAttachmentsToMessage(
  attachmentIds: string[],
  messageId: string,
  userId: string,
) {
  if (attachmentIds.length === 0) return;

  const ownedIds = (await selectOwnedAttachments(attachmentIds, userId)).map((row) => row.id);
  if (ownedIds.length === 0) return;

  await db.update(attachments).set({ messageId }).where(inArray(attachments.id, ownedIds));
}

export async function getAttachmentsByIds(attachmentIds: string[], userId: string) {
  if (attachmentIds.length === 0) return [];

  return selectOwnedAttachments(attachmentIds, userId);
}

export type ImageAttachmentPayload = {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  dataBase64: string;
};

export async function buildAttachmentPayloadFromIds(attachmentIds: string[], userId: string) {
  if (attachmentIds.length === 0) {
    return {
      textContext: "",
      images: [] as ImageAttachmentPayload[],
      files: [] as Array<{ id: string; fileName: string; fileType: string; fileSize: number }>,
    };
  }

  const records = await getAttachmentsByIds(attachmentIds, userId);
  const parsed: Array<{ fileName: string; text: string }> = [];
  const images: ImageAttachmentPayload[] = [];
  const files: Array<{ id: string; fileName: string; fileType: string; fileSize: number }> = [];

  for (const record of records) {
    files.push({
      id: record.id,
      fileName: record.fileName,
      fileType: record.fileType,
      fileSize: record.fileSize,
    });

    // Images are sent as native vision blocks; do not include placeholder text.
    if (record.fileType?.startsWith("image/")) {
      try {
        const buffer = await readFile(record.filePath);
        images.push({
          id: record.id,
          fileName: record.fileName,
          fileType: record.fileType,
          fileSize: record.fileSize,
          dataBase64: buffer.toString("base64"),
        });
      } catch {
        // ignore: leave image out (fallback will be text-only).
      }
      continue;
    }

    try {
      const text = await parseAttachmentContent({
        fileName: record.fileName,
        filePath: record.filePath,
        fileType: record.fileType,
      });
      parsed.push({ fileName: record.fileName, text });
    } catch {
      parsed.push({ fileName: record.fileName, text: "" });
    }
  }

  return {
    textContext: formatAttachmentContext(parsed),
    images,
    files,
  };
}

export async function buildAttachmentContextFromIds(attachmentIds: string[], userId: string) {
  const payload = await buildAttachmentPayloadFromIds(attachmentIds, userId);
  // Back-compat: include only text context (images are represented as blocks elsewhere).
  return payload.textContext;
}

/**
 * Deletes attachment blobs from disk.
 *
 * MUST be called *after* the transaction that removed the rows has committed:
 * a rolled-back transaction leaves the rows in place, and files deleted early
 * could not be restored. Losing the reverse case (rows gone, file left behind)
 * only wastes disk, which is why every failure here is swallowed and logged.
 *
 * Callers collect the paths inside the transaction — once the rows are gone
 * there is no way to find the files again.
 */
export async function removeAttachmentFiles(filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    if (!filePath) continue;
    // Sidecar-run attachments store a `local:<name>` marker rather than a real
    // path: the file lives on the user's machine and was never uploaded here.
    if (filePath.startsWith(LOCAL_ATTACHMENT_PATH_PREFIX)) continue;
    try {
      await unlink(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      // Already gone is the expected outcome of a retry, not a problem.
      if (code === "ENOENT") continue;
      console.error(`[attachments] failed to delete ${filePath}:`, error);
    }
  }
}

/** Reads the on-disk paths for the given attachment ids, before their rows are deleted. */
export async function collectAttachmentFilePaths(attachmentIds: string[]): Promise<string[]> {
  if (attachmentIds.length === 0) return [];
  const rows = await db
    .select({ filePath: attachments.filePath })
    .from(attachments)
    .where(inArray(attachments.id, attachmentIds));
  return rows.map((row) => row.filePath).filter((p): p is string => Boolean(p));
}
