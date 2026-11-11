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
  validateLibraryFileName,
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
  validateLibraryFileName(row.fileName);
  if (typeof row.id !== "string" || !row.id) throw new Error("Invalid library document id");
  return { id: row.id, projectId: row.projectId, bytes, fileName: row.fileName };
}
export interface LibraryBackupBindings {
  project(value: unknown): string | null;
  conversation(value: unknown): string | null;
  channel(value: unknown): string | null;
  stable(kind: string, value: string): string;
}
function validateLibraryBackupQuestion(value: unknown) {
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
    (row.scopeKind !== "personal" && row.scopeKind !== "project") ||
    (row.scopeKind === "project" && (typeof row.scopeProjectId !== "string" || !row.scopeProjectId))
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
      documentId: source.documentId,
      fileName: source.fileName,
      chunkIndex: source.chunkIndex,
      text: source.text,
      ...(source.heading === undefined ? {} : { heading: source.heading }),
    };
  });
  const prompt = libraryQuestionPayload(row.question, sources);
  if (utf8Bytes(prompt) > LIBRARY_LIMITS.sourceBytes)
    throw new Error("Library source budget exceeded");
  const createdAt = new Date(String(row.createdAt));
  if (!Number.isFinite(createdAt.getTime())) throw new Error("Invalid library question date");
  return {
    id: row.id,
    requestId: row.requestId,
    question: row.question,
    modelId: row.modelId,
    scopeKind: row.scopeKind as LibraryScope["kind"],
    scopeProjectId: row.scopeProjectId,
    projectId: row.projectId,
    channelId: row.channelId,
    conversationId: row.conversationId,
    createdAt,
    sources,
  };
}

export function prepareLibraryBackup(docs: unknown[], questions: unknown[]) {
  if (docs.length > LIBRARY_LIMITS.documents || questions.length > LIBRARY_LIMITS.questions)
    throw new Error("Library backup record limit");
  let bytes = 0;
  const documents = docs.map((value) => {
    const original = validateLibraryBackupOriginal(value);
    bytes += original.bytes.length;
    if (bytes > LIBRARY_LIMITS.totalBytes) throw new Error("Library backup original size limit");
    return original;
  });
  return { documents, questions: questions.map(validateLibraryBackupQuestion) };
}
export function restoreLibraryBackup(
  userId: string,
  docs: unknown[],
  questions: unknown[],
  bindings: LibraryBackupBindings,
) {
  return restorePreparedLibraryBackup(userId, prepareLibraryBackup(docs, questions), bindings);
}
export async function restorePreparedLibraryBackup(
  userId: string,
  backup: ReturnType<typeof prepareLibraryBackup>,
  bindings: LibraryBackupBindings,
) {
  const counts = { imported: 0, skipped: 0, errors: [] as string[] };
  const documentMap = new Map<string, string>();
  for (const row of backup.documents) {
    const { bytes, fileName } = row;
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
    let restored: Awaited<ReturnType<typeof insertLibraryOriginal>>;
    try {
      restored = await libraryTransaction((tx) =>
        insertLibraryOriginal(
          tx,
          userId,
          scope,
          fileName,
          bytes,
          bindings.stable("library-document", row.id),
        ),
      );
    } catch {
      counts.skipped++;
      counts.errors.push(`Library original could not be restored: ${fileName}`);
      continue;
    }
    documentMap.set(row.id, restored.document.id);
    if (restored.reused) counts.skipped++;
    else {
      counts.imported++;
      try {
        const indexed = await indexLibraryDocument(userId, restored.document.id);
        if (indexed.status !== "ready")
          counts.errors.push(`Library index unavailable: ${fileName}`);
      } catch {
        counts.errors.push(`Library index unavailable: ${fileName}`);
      }
    }
  }
  for (const row of backup.questions) {
    const sources = row.sources.map((source) => ({
      ...source,
      documentId:
        documentMap.get(source.documentId) ??
        bindings.stable("library-document", source.documentId),
    }));
    const prompt = libraryQuestionPayload(row.question, sources);
    if (utf8Bytes(prompt) > LIBRARY_LIMITS.sourceBytes) {
      counts.skipped++;
      counts.errors.push("Library question skipped: source budget exceeded after rebinding");
      continue;
    }
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
    try {
      const inserted = await libraryTransaction(async (tx) => {
        const [previous] = await tx
          .select({ id: libraryQuestions.id })
          .from(libraryQuestions)
          .where(and(eq(libraryQuestions.userId, userId), eq(libraryQuestions.id, id)))
          .limit(1);
        // Same-account restore also recognizes the original row.
        const [original] = await tx
          .select({ id: libraryQuestions.id })
          .from(libraryQuestions)
          .where(and(eq(libraryQuestions.userId, userId), eq(libraryQuestions.id, row.id)))
          .limit(1);
        if (previous || original) return false;
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
          scopeKind: row.scopeKind,
          scopeProjectId,
          projectId,
          conversationId: conversation?.id ?? null,
          channelId,
          modelId: row.modelId,
          question: row.question,
          sources: JSON.stringify(sources),
          prompt,
          createdAt: row.createdAt,
        });
        return true;
      });
      if (inserted) counts.imported++;
      else counts.skipped++;
    } catch {
      counts.skipped++;
      counts.errors.push("Library question could not be restored");
    }
  }
  return counts;
}
