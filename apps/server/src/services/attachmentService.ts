import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentSessions, attachments, conversations } from "db";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { generateId } from "../utils";
import { formatAttachmentContext, parseAttachmentContent } from "./attachmentParser";

export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

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

export async function storeAttachment(params: {
  conversationId?: string;
  sessionId?: string;
  file: File;
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
