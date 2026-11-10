import { createHash } from "node:crypto";
import { conversations, libraryQuestions } from "db";
import { and, eq, sql } from "drizzle-orm";
import { LIBRARY_LIMITS, libraryQuestionPayload, utf8Bytes } from "shared/library";
import type { LibraryScope, LibrarySource } from "shared/types";
import { db } from "../db";
import {
  indexLibraryDocument,
  insertLibraryOriginal,
  LibraryError,
  libraryTransaction,
  validateLibraryScope,
} from "./libraryService";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function canonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) return false;
  const padding = value.indexOf("=");
  return padding < 0 || (padding >= value.length - 2 && /^={1,2}$/.test(value.slice(padding)));
}
export function validateLibraryBackupOriginal(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid library document");
  const row = value as Record<string, unknown>;
  if (
    !("projectId" in row) ||
    (row.projectId !== null && (typeof row.projectId !== "string" || !row.projectId)) ||
    row.scopeKey !== (row.projectId === null ? "personal" : `project:${row.projectId}`)
  )
    throw new Error("Invalid library project scope");
  if (
    typeof row.originalBase64 !== "string" ||
    row.originalBase64.length > 4 * Math.ceil(LIBRARY_LIMITS.fileBytes / 3) ||
    !canonicalBase64(row.originalBase64) ||
    typeof row.fileSize !== "number" ||
    !Number.isSafeInteger(row.fileSize) ||
    row.fileSize < 1 ||
    row.fileSize > LIBRARY_LIMITS.fileBytes
  )
    throw new Error("Invalid library original encoding or size");
  const bytes = Buffer.from(row.originalBase64, "base64");
  if (
    bytes.length !== row.fileSize ||
    bytes.toString("base64") !== row.originalBase64 ||
    sha(bytes) !== row.sha256
  )
    throw new Error("Invalid library original checksum");
  if (typeof row.fileName !== "string") throw new Error("Invalid library filename");
  return { row, bytes, fileName: row.fileName };
}
export interface LibraryBackupBindings {
  project(value: unknown): string | null;
  conversation(value: unknown): string | null;
  channel(value: unknown): string | null;
  stable(kind: string, value: string): string;
}
export async function restoreLibraryBackup(
  userId: string,
  docs: unknown[],
  questions: unknown[],
  bindings: LibraryBackupBindings,
) {
  const counts = { imported: 0, skipped: 0, errors: [] as string[] };
  if (docs.length > LIBRARY_LIMITS.documents || questions.length > LIBRARY_LIMITS.questions)
    throw new Error("Library backup record limit");
  const documentMap = new Map<string, string>();
  for (const value of docs) {
    const { row, bytes, fileName } = validateLibraryBackupOriginal(value);
    if (typeof row.id !== "string") throw new Error("Invalid library document id");
    const projectId = bindings.project(row.projectId);
    if (row.projectId != null && !projectId) {
      counts.skipped++;
      counts.errors.push(`Library project unavailable: ${fileName}`);
      continue;
    }
    const scope: LibraryScope = projectId ? { kind: "project", projectId } : { kind: "personal" };
    try {
      await validateLibraryScope(db, userId, scope);
    } catch {
      counts.skipped++;
      counts.errors.push(`Library project unavailable: ${fileName}`);
      continue;
    }
    const restored = await libraryTransaction((tx) =>
      insertLibraryOriginal(
        tx,
        userId,
        scope,
        fileName,
        bytes,
        bindings.stable("library-document", row.id as string),
      ),
    );
    documentMap.set(row.id, restored.document.id);
    if (restored.reused) counts.skipped++;
    else {
      counts.imported++;
      await indexLibraryDocument(userId, restored.document.id);
    }
  }
  for (const value of questions) {
    if (!value || typeof value !== "object") throw new Error("Invalid library question");
    const row = value as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.requestId !== "string" ||
      typeof row.question !== "string" ||
      !row.question.trim() ||
      row.question.length > LIBRARY_LIMITS.questionChars ||
      typeof row.modelId !== "string" ||
      row.modelId.length > 256 ||
      !["personal", "project"].includes(String(row.scopeKind)) ||
      (row.scopeKind === "project" &&
        (typeof row.scopeProjectId !== "string" || !row.scopeProjectId))
    )
      throw new Error("Invalid library question metadata");
    const rawSources: unknown =
      typeof row.sources === "string" ? JSON.parse(row.sources) : row.sources;
    if (
      !Array.isArray(rawSources) ||
      rawSources.length < 1 ||
      rawSources.length > LIBRARY_LIMITS.sources
    )
      throw new Error("Invalid library sources");
    const sources: LibrarySource[] = rawSources.map((source) => {
      if (
        !source ||
        typeof source !== "object" ||
        typeof source.documentId !== "string" ||
        typeof source.fileName !== "string" ||
        !source.fileName ||
        source.fileName.length > 200 ||
        !Number.isSafeInteger(source.chunkIndex) ||
        source.chunkIndex < 0 ||
        source.chunkIndex >= LIBRARY_LIMITS.chunks ||
        typeof source.text !== "string" ||
        !source.text ||
        source.text.length > 2800 ||
        (source.heading !== undefined &&
          (typeof source.heading !== "string" ||
            utf8Bytes(source.heading) > LIBRARY_LIMITS.sourceBytes))
      )
        throw new Error("Invalid library source snapshot");
      return {
        documentId:
          documentMap.get(source.documentId) ??
          bindings.stable("library-document", source.documentId),
        fileName: source.fileName,
        chunkIndex: source.chunkIndex,
        text: source.text,
        ...(source.heading === undefined ? {} : { heading: source.heading }),
      };
    });
    const prompt = libraryQuestionPayload(row.question, sources);
    if (utf8Bytes(prompt) > LIBRARY_LIMITS.sourceBytes)
      throw new Error("Library source budget exceeded");
    let projectId = row.scopeKind === "project" ? bindings.project(row.projectId) : null;
    if (projectId) {
      try {
        await validateLibraryScope(db, userId, { kind: "project", projectId });
      } catch {
        projectId = null;
      }
    }
    // Preserve an unavailable project scope as a historical identifier, never as personal.
    const scopeProjectId =
      row.scopeKind === "project"
        ? (projectId ?? bindings.stable("missing-library-project", String(row.scopeProjectId)))
        : null;
    const scope: LibraryScope =
      row.scopeKind === "personal"
        ? { kind: "personal" }
        : { kind: "project", projectId: scopeProjectId as string };
    const channelId = bindings.channel(row.channelId),
      conversationId = bindings.conversation(row.conversationId);
    const id = bindings.stable("library-question", row.id),
      requestId = bindings.stable("library-request", row.requestId);
    const createdAt = new Date(String(row.createdAt));
    if (!Number.isFinite(createdAt.getTime())) throw new Error("Invalid library question date");
    await libraryTransaction(async (tx) => {
      const [previous] = await tx
        .select({ id: libraryQuestions.id })
        .from(libraryQuestions)
        .where(and(eq(libraryQuestions.userId, userId), eq(libraryQuestions.id, id)))
        .limit(1);
      // Same-account restore also recognizes the original row.
      const [original] = await tx
        .select({ id: libraryQuestions.id })
        .from(libraryQuestions)
        .where(and(eq(libraryQuestions.userId, userId), eq(libraryQuestions.id, row.id as string)))
        .limit(1);
      if (previous || original) {
        counts.skipped++;
        return;
      }
      const [quota] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(libraryQuestions)
        .where(eq(libraryQuestions.userId, userId));
      if (Number(quota.count) >= LIBRARY_LIMITS.questions)
        throw new LibraryError("library_question_limit", 413);
      const [conversation] = conversationId
        ? await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(and(eq(conversations.userId, userId), eq(conversations.id, conversationId)))
            .limit(1)
        : [];
      await tx.insert(libraryQuestions).values({
        id,
        userId,
        requestId,
        inputHash: sha(
          JSON.stringify({ scope, question: row.question, channelId, modelId: row.modelId }),
        ),
        scopeKind: row.scopeKind as "personal" | "project",
        scopeProjectId,
        projectId,
        conversationId: conversation?.id ?? null,
        channelId,
        modelId: row.modelId as string,
        question: row.question as string,
        sources: JSON.stringify(sources),
        prompt,
        createdAt,
      });
      counts.imported++;
    });
  }
  return counts;
}
