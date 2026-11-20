import { createHash } from "node:crypto";
import {
  channels,
  conversations,
  libraryChunks,
  libraryDocuments,
  libraryFolders,
  libraryQuestions,
  projects,
} from "db";
import { and, desc, eq, getTableColumns, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  LIBRARY_LIMITS,
  LIBRARY_SYSTEM_PROMPT,
  LIBRARY_SYSTEM_TAG,
  libraryFileType,
  libraryKeywords,
  libraryKeywordVariants,
  libraryOcrFileType,
  libraryQuestionPayload,
  libraryScopeKey,
  packLibrarySources,
  utf8Bytes,
} from "shared/library";
import { readToolRuntime } from "shared/tool-connection";
import type {
  LibraryDocument,
  LibraryDocumentDetail,
  LibraryDocumentMetadata,
  LibraryFilter,
  LibraryFolder,
  LibraryListOptions,
  LibraryQuestion,
  LibraryQuestionSourceRef,
  LibraryScope,
  LibrarySearchMatchRequest,
  LibrarySearchResult,
  LibrarySource,
  LibrarySourceLocation,
  LibraryStats,
  PreparedLibraryQuestion,
  UpdateLibraryDocumentMetadataInput,
} from "shared/types";
import { db } from "../db";
import { generateId } from "../utils";
import { getChannelById, resolveModelIdFromChannelItem } from "./channelService";
import { chunkTextWithOffsets } from "./chunkingService";
import {
  type LibraryParsedDocument,
  LibraryParseError,
  parseLibraryOriginalDetailed,
  validateLibraryOcrOriginal,
} from "./libraryParser";
import { requestLibraryToolParseDetailed } from "./libraryToolParser";
import { getSettingValues } from "./settingsService";
import { toolConnectionFingerprint } from "./toolConnectionService";

export class LibraryError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 413 = 400,
  ) {
    super(code);
  }
}
type Reader = Pick<typeof db, "select">;
type Writer = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = typeof libraryDocuments.$inferSelect;
const {
  originalBase64: _original,
  textContent: _text,
  ...metadata
} = getTableColumns(libraryDocuments);
/** Reduce local contention; quotas and dedupe still live in the actual SQL transaction. */
let transactionQueue: Promise<void> = Promise.resolve();
export async function libraryTransaction<T>(work: (tx: Writer) => Promise<T>): Promise<T> {
  const previous = transactionQueue;
  let release = () => {};
  transactionQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.transaction(work);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        if (code !== "SQLITE_BUSY" || attempt >= 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, 5 * 2 ** attempt)));
      }
    }
  } finally {
    release();
  }
}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const ownedWhere = (userId: string, id: string) =>
  and(eq(libraryDocuments.userId, userId), eq(libraryDocuments.id, id));
export function parseLibraryScope(value: unknown): LibraryScope;
export function parseLibraryScope(value: unknown, allowAll: boolean): LibraryFilter;
export function parseLibraryScope(value: unknown, allowAll = false): LibraryFilter {
  if (!value || typeof value !== "object") throw new LibraryError("library_invalid_scope");
  const scope = value as Record<string, unknown>;
  if (scope.kind === "personal") return { kind: "personal" };
  if (scope.kind === "all" && allowAll) return { kind: "all" };
  if (
    scope.kind === "project" &&
    typeof scope.projectId === "string" &&
    scope.projectId.length > 0 &&
    scope.projectId.length <= 200
  )
    return { kind: "project", projectId: scope.projectId };
  throw new LibraryError("library_invalid_scope");
}
export async function validateLibraryScope(reader: Reader, userId: string, scope: LibraryFilter) {
  if (scope.kind !== "project") return;
  const [project] = await reader
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) throw new LibraryError("library_invalid_scope", 404);
}
const filter = (userId: string, scope: LibraryFilter) =>
  and(
    eq(libraryDocuments.userId, userId),
    scope.kind === "all" ? undefined : eq(libraryDocuments.scopeKey, libraryScopeKey(scope)),
  );
const currentFilter = (userId: string, scope: LibraryFilter) =>
  and(filter(userId, scope), eq(libraryDocuments.isCurrent, true));
const visibleFilter = (userId: string, scope: LibraryFilter, options: LibraryListOptions = {}) =>
  and(
    currentFilter(userId, scope),
    options.folderId === null
      ? isNull(libraryDocuments.folderId)
      : options.folderId
        ? eq(libraryDocuments.folderId, options.folderId)
        : undefined,
    options.favoriteOnly ? eq(libraryDocuments.isFavorite, true) : undefined,
    options.tag
      ? sql`exists (select 1 from json_each(${libraryDocuments.tags}) where value = ${options.tag})`
      : undefined,
  );
export function libraryFolderName(value: unknown): string {
  if (typeof value !== "string" || /\p{Cc}/u.test(value))
    throw new LibraryError("library_invalid_folder_name");
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > LIBRARY_LIMITS.folderNameChars)
    throw new LibraryError("library_invalid_folder_name");
  return name;
}

const folderColumns = {
  id: libraryFolders.id,
  projectId: libraryFolders.projectId,
  name: libraryFolders.name,
  revision: libraryFolders.revision,
};
const ownedFolder = (userId: string, id: string) =>
  and(eq(libraryFolders.userId, userId), eq(libraryFolders.id, id));

async function validateFolder(reader: Reader, userId: string, scopeKey: string, id: string) {
  if (typeof id !== "string" || !id || id.length > 200)
    throw new LibraryError("library_folder_not_found", 404);
  const [folder] = await reader
    .select({ id: libraryFolders.id })
    .from(libraryFolders)
    .where(and(ownedFolder(userId, id), eq(libraryFolders.scopeKey, scopeKey)))
    .limit(1);
  if (!folder) throw new LibraryError("library_folder_not_found", 404);
}

export async function listLibraryFolders(
  userId: string,
  scope: LibraryFilter,
): Promise<LibraryFolder[]> {
  await validateLibraryScope(db, userId, scope);
  return db
    .select(folderColumns)
    .from(libraryFolders)
    .where(
      and(
        eq(libraryFolders.userId, userId),
        scope.kind === "all" ? undefined : eq(libraryFolders.scopeKey, libraryScopeKey(scope)),
      ),
    )
    .orderBy(libraryFolders.nameKey, libraryFolders.id);
}

export async function createLibraryFolder(
  userId: string,
  scope: LibraryScope,
  value: unknown,
  restoreId?: string,
) {
  const name = libraryFolderName(value);
  const scopeKey = libraryScopeKey(scope);
  return libraryTransaction(async (tx) => {
    await validateLibraryScope(tx, userId, scope);
    if (restoreId) {
      const [restored] = await tx
        .select(folderColumns)
        .from(libraryFolders)
        .where(and(ownedFolder(userId, restoreId), eq(libraryFolders.scopeKey, scopeKey)))
        .limit(1);
      if (restored) return { folder: restored, reused: true };
    }
    const [existing] = await tx
      .select(folderColumns)
      .from(libraryFolders)
      .where(
        and(
          eq(libraryFolders.userId, userId),
          eq(libraryFolders.scopeKey, scopeKey),
          eq(libraryFolders.nameKey, name.toLowerCase()),
        ),
      )
      .limit(1);
    if (existing) {
      if (restoreId) return { folder: existing, reused: true };
      throw new LibraryError("library_folder_duplicate", 409);
    }
    const [quota] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(libraryFolders)
      .where(eq(libraryFolders.userId, userId));
    if (Number(quota.count) >= LIBRARY_LIMITS.folders)
      throw new LibraryError("library_folder_limit", 413);
    const [folder] = await tx
      .insert(libraryFolders)
      .values({
        id: restoreId ?? generateId(),
        userId,
        scopeKey,
        projectId: scope.kind === "project" ? scope.projectId : null,
        name,
        nameKey: name.toLowerCase(),
      })
      .returning(folderColumns);
    return { folder, reused: false };
  });
}

export async function renameLibraryFolder(
  userId: string,
  id: string,
  revision: number,
  value: unknown,
) {
  const name = libraryFolderName(value);
  return libraryTransaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(libraryFolders)
      .where(ownedFolder(userId, id))
      .limit(1);
    if (!current || current.revision !== revision) throw new LibraryError("library_conflict", 409);
    const [existing] = await tx
      .select({ id: libraryFolders.id })
      .from(libraryFolders)
      .where(
        and(
          eq(libraryFolders.userId, userId),
          eq(libraryFolders.scopeKey, current.scopeKey),
          eq(libraryFolders.nameKey, name.toLowerCase()),
        ),
      )
      .limit(1);
    if (existing && existing.id !== id) throw new LibraryError("library_folder_duplicate", 409);
    const [folder] = await tx
      .update(libraryFolders)
      .set({ name, nameKey: name.toLowerCase(), revision: revision + 1 })
      .where(and(ownedFolder(userId, id), eq(libraryFolders.revision, revision)))
      .returning(folderColumns);
    if (!folder) throw new LibraryError("library_conflict", 409);
    return folder;
  });
}

export async function deleteLibraryFolder(userId: string, id: string, revision: number) {
  await libraryTransaction(async (tx) => {
    const result = await tx
      .delete(libraryFolders)
      .where(and(ownedFolder(userId, id), eq(libraryFolders.revision, revision)));
    if (result.rowsAffected !== 1) throw new LibraryError("library_conflict", 409);
  });
  return true;
}

export function libraryTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 12) throw new LibraryError("library_invalid_tags");
  const tags = value.map((tag) => {
    if (typeof tag !== "string" || /\p{Cc}/u.test(tag))
      throw new LibraryError("library_invalid_tags");
    const normalized = tag.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!normalized || normalized.length > 40 || normalized.includes(","))
      throw new LibraryError("library_invalid_tags");
    return normalized;
  });
  return [...new Set(tags)];
}
export function libraryDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new LibraryError("library_invalid_display_name");
  const name = value.normalize("NFKC").trim();
  if (!name || name.length > 200 || /\p{Cc}/u.test(value))
    throw new LibraryError("library_invalid_display_name");
  return name;
}
function documentItem(row: Omit<Row, "originalBase64" | "textContent">): LibraryDocument {
  const canClaim =
    row.status !== "indexing" || !row.leaseUntil || row.leaseUntil.getTime() <= Date.now();
  return {
    id: row.id,
    projectId: row.projectId,
    folderId: row.folderId,
    fileName: row.fileName,
    displayName: row.displayName,
    tags: (() => {
      try {
        return libraryTags(JSON.parse(row.tags));
      } catch {
        return [];
      }
    })(),
    isFavorite: row.isFavorite,
    versionGroupId: row.versionGroupId,
    version: row.version,
    isCurrent: row.isCurrent,
    previousVersionId: row.previousVersionId,
    fileType: row.fileType,
    fileSize: row.fileSize,
    status: row.status,
    errorCode: row.errorCode,
    chunkCount: row.chunkCount,
    revision: row.revision,
    canIndex: (row.fileType === "text/plain" || row.fileType === "application/pdf") && canClaim,
    canOcr: libraryOcrFileType(row.fileType) && row.status !== "ready" && canClaim,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
const chunkLocationColumns = {
  pageStart: libraryChunks.pageStart,
  pageEnd: libraryChunks.pageEnd,
  startOffset: libraryChunks.startOffset,
  endOffset: libraryChunks.endOffset,
  lineStart: libraryChunks.lineStart,
  lineEnd: libraryChunks.lineEnd,
};

function sourceLocation(row: Partial<Record<keyof LibrarySourceLocation, unknown>>) {
  const location: LibrarySourceLocation = {};
  for (const key of Object.keys(chunkLocationColumns) as (keyof LibrarySourceLocation)[]) {
    const value = row[key];
    if (typeof value === "number") location[key] = value;
  }
  return Object.keys(location).length ? { location } : {};
}

export async function listLibraryDocuments(
  userId: string,
  scope: LibraryFilter,
  options: LibraryListOptions = {},
): Promise<LibraryDocument[]> {
  await validateLibraryScope(db, userId, scope);
  return (
    await db
      .select(metadata)
      .from(libraryDocuments)
      .where(visibleFilter(userId, scope, options))
      .orderBy(desc(libraryDocuments.updatedAt), libraryDocuments.id)
  ).map(documentItem);
}
export async function getLibraryStats(userId: string, scope: LibraryFilter): Promise<LibraryStats> {
  await validateLibraryScope(db, userId, scope);
  const [row] = await db
    .select({
      documents: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${libraryDocuments.fileSize}), 0)`,
    })
    .from(libraryDocuments)
    .where(filter(userId, scope));
  return {
    documents: Number(row?.documents ?? 0),
    documentLimit: LIBRARY_LIMITS.documents,
    bytes: Number(row?.bytes ?? 0),
    byteLimit: LIBRARY_LIMITS.totalBytes,
  };
}
export async function getLibraryDocument(
  userId: string,
  id: string,
): Promise<LibraryDocumentDetail> {
  const [row] = await db
    .select({ ...metadata, textContent: libraryDocuments.textContent })
    .from(libraryDocuments)
    .where(ownedWhere(userId, id))
    .limit(1);
  if (!row) throw new LibraryError("library_not_found", 404);
  return { ...documentItem(row), text: row.textContent };
}
export async function getLibraryOriginal(userId: string, id: string) {
  const [row] = await db
    .select({
      fileName: libraryDocuments.fileName,
      fileType: libraryDocuments.fileType,
      originalBase64: libraryDocuments.originalBase64,
    })
    .from(libraryDocuments)
    .where(ownedWhere(userId, id))
    .limit(1);
  if (!row) throw new LibraryError("library_not_found", 404);
  return { ...row, bytes: Buffer.from(row.originalBase64, "base64") };
}
export async function updateLibraryDocumentMetadata(
  userId: string,
  id: string,
  input: UpdateLibraryDocumentMetadataInput,
) {
  if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new LibraryError("library_invalid_data");
  const { expectedRevision, displayName, tags, isFavorite, folderId } = input;
  if (
    (isFavorite !== undefined && typeof isFavorite !== "boolean") ||
    (displayName === undefined &&
      tags === undefined &&
      isFavorite === undefined &&
      folderId === undefined)
  )
    throw new LibraryError("library_invalid_data");
  const changes = {
    ...(displayName === undefined ? {} : { displayName: libraryDisplayName(displayName) }),
    ...(tags === undefined ? {} : { tags: JSON.stringify(libraryTags(tags)) }),
    ...(isFavorite === undefined ? {} : { isFavorite }),
    ...(folderId === undefined ? {} : { folderId }),
  };
  return libraryTransaction(async (tx) => {
    const [current] = await tx
      .select(metadata)
      .from(libraryDocuments)
      .where(
        and(
          ownedWhere(userId, id),
          eq(libraryDocuments.isCurrent, true),
          eq(libraryDocuments.revision, expectedRevision),
        ),
      )
      .limit(1);
    if (!current) throw new LibraryError("library_conflict", 409);
    if (folderId !== undefined && folderId !== null)
      await validateFolder(tx, userId, current.scopeKey, folderId);
    const group = and(
      eq(libraryDocuments.userId, userId),
      eq(libraryDocuments.scopeKey, current.scopeKey),
      eq(libraryDocuments.versionGroupId, current.versionGroupId),
    );
    const [indexing] = await tx
      .select({ id: libraryDocuments.id })
      .from(libraryDocuments)
      .where(
        and(
          group,
          eq(libraryDocuments.status, "indexing"),
          gt(libraryDocuments.leaseUntil, new Date()),
        ),
      )
      .limit(1);
    if (indexing) throw new LibraryError("library_index_busy", 409);
    await tx
      .update(libraryDocuments)
      .set({ ...changes, revision: sql`${libraryDocuments.revision} + 1` })
      .where(group);
    const [saved] = await tx
      .select({ ...metadata, text: libraryDocuments.textContent })
      .from(libraryDocuments)
      .where(ownedWhere(userId, id))
      .limit(1);
    return { ...documentItem(saved), text: saved.text };
  });
}

export async function moveLibraryDocuments(userId: string, input: unknown) {
  if (!input || typeof input !== "object") throw new LibraryError("library_invalid_data");
  const { scope: rawScope, folderId: rawFolderId, documents } = input as Record<string, unknown>;
  const scope = parseLibraryScope(rawScope);
  if (
    (rawFolderId !== null && typeof rawFolderId !== "string") ||
    !Array.isArray(documents) ||
    !documents.length ||
    documents.length > LIBRARY_LIMITS.documents
  )
    throw new LibraryError("library_invalid_data");
  const folderId = typeof rawFolderId === "string" ? rawFolderId : null;
  const revisions = new Map<string, number>();
  for (const entry of documents) {
    if (!entry || typeof entry !== "object") throw new LibraryError("library_invalid_data");
    const { documentId, expectedRevision } = entry as Record<string, unknown>;
    if (
      typeof documentId !== "string" ||
      !documentId ||
      documentId.length > 200 ||
      revisions.has(documentId) ||
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1
    )
      throw new LibraryError("library_invalid_data");
    revisions.set(documentId, expectedRevision);
  }
  return libraryTransaction(async (tx) => {
    await validateLibraryScope(tx, userId, scope);
    if (folderId !== null) await validateFolder(tx, userId, libraryScopeKey(scope), folderId);
    const current = await tx
      .select({
        id: libraryDocuments.id,
        revision: libraryDocuments.revision,
        folderId: libraryDocuments.folderId,
        groupId: libraryDocuments.versionGroupId,
      })
      .from(libraryDocuments)
      .where(
        and(currentFilter(userId, scope), inArray(libraryDocuments.id, [...revisions.keys()])),
      );
    if (
      current.length !== revisions.size ||
      current.some((doc) => revisions.get(doc.id) !== doc.revision)
    )
      throw new LibraryError("library_conflict", 409);
    const moving = current.filter((doc) => doc.folderId !== folderId);
    if (!moving.length) return { moved: 0 };
    const groups = and(
      filter(userId, scope),
      inArray(
        libraryDocuments.versionGroupId,
        moving.map((doc) => doc.groupId),
      ),
    );
    const [indexing] = await tx
      .select({ id: libraryDocuments.id })
      .from(libraryDocuments)
      .where(
        and(
          groups,
          eq(libraryDocuments.status, "indexing"),
          gt(libraryDocuments.leaseUntil, new Date()),
        ),
      )
      .limit(1);
    if (indexing) throw new LibraryError("library_index_busy", 409);
    await tx
      .update(libraryDocuments)
      .set({ folderId, revision: sql`${libraryDocuments.revision} + 1` })
      .where(groups);
    return { moved: moving.length };
  });
}

export async function listLibraryDocumentVersions(userId: string, id: string) {
  const [document] = await db
    .select({ versionGroupId: libraryDocuments.versionGroupId })
    .from(libraryDocuments)
    .where(ownedWhere(userId, id))
    .limit(1);
  if (!document) throw new LibraryError("library_not_found", 404);
  return (
    await db
      .select(metadata)
      .from(libraryDocuments)
      .where(
        and(
          eq(libraryDocuments.userId, userId),
          eq(libraryDocuments.versionGroupId, document.versionGroupId),
        ),
      )
      .orderBy(desc(libraryDocuments.version), desc(libraryDocuments.updatedAt))
  ).map(documentItem);
}
export async function restoreLibraryDocument(userId: string, id: string, revision: number) {
  return libraryTransaction(async (tx) => {
    const [target] = await tx
      .select(metadata)
      .from(libraryDocuments)
      .where(and(ownedWhere(userId, id), eq(libraryDocuments.revision, revision)))
      .limit(1);
    if (!target) throw new LibraryError("library_conflict", 409);
    if (target.isCurrent) return documentItem(target);
    const now = new Date();
    await tx
      .update(libraryDocuments)
      .set({ isCurrent: false, revision: sql`${libraryDocuments.revision} + 1`, updatedAt: now })
      .where(
        and(
          eq(libraryDocuments.userId, userId),
          eq(libraryDocuments.versionGroupId, target.versionGroupId),
          eq(libraryDocuments.isCurrent, true),
        ),
      );
    const [restored] = await tx
      .update(libraryDocuments)
      .set({ isCurrent: true, revision: target.revision + 1, updatedAt: now })
      .where(and(eq(libraryDocuments.id, id), eq(libraryDocuments.revision, target.revision)))
      .returning(metadata);
    if (!restored) throw new LibraryError("library_conflict", 409);
    return documentItem(restored);
  });
}
export function validateLibraryFileName(fileName: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: filenames must not contain header/path control characters
  if (!fileName || fileName.length > 200 || /[\x00-\x1f\x7f/\\]/.test(fileName))
    throw new LibraryError("library_invalid_file");
  const fileType = libraryFileType(fileName);
  if (!fileType) throw new LibraryError("library_unsupported_file");
  return fileType;
}
type LibraryFtsWriter = Pick<typeof db, "run">;
async function syncLibraryChunksFts(documentId: string, writer: LibraryFtsWriter = db) {
  try {
    await writer.run(sql`DELETE FROM library_chunks_fts WHERE document_id = ${documentId}`);
    await writer.run(sql`
      INSERT INTO library_chunks_fts(document_id, chunk_index, heading, text)
      SELECT document_id, chunk_index, coalesce(heading, ''), text
      FROM library_chunks
      WHERE document_id = ${documentId}
    `);
  } catch {
    // Older databases may not have the derived table until their next bootstrap.
  }
}
async function deleteLibraryChunksFts(documentId: string, writer: LibraryFtsWriter = db) {
  try {
    await writer.run(sql`DELETE FROM library_chunks_fts WHERE document_id = ${documentId}`);
  } catch {
    // The derived index can be rebuilt from library_chunks during bootstrap.
  }
}
export async function insertLibraryOriginal(
  tx: Writer,
  userId: string,
  scope: LibraryScope,
  fileName: string,
  bytes: Buffer,
  preferredId = generateId(),
  archivedMetadata?: LibraryDocumentMetadata,
  folderId?: string | null,
): Promise<{ document: LibraryDocument; reused: boolean }> {
  await validateLibraryScope(tx, userId, scope);
  const fileType = validateLibraryFileName(fileName);
  if (!bytes.length || bytes.length > LIBRARY_LIMITS.fileBytes)
    throw new LibraryError("library_file_limit", 413);
  const scopeKey = libraryScopeKey(scope),
    sha256 = hash(bytes);
  if (folderId !== undefined && folderId !== null)
    await validateFolder(tx, userId, scopeKey, folderId);
  const [previous] = await tx
    .select(metadata)
    .from(libraryDocuments)
    .where(
      and(
        eq(libraryDocuments.userId, userId),
        eq(libraryDocuments.scopeKey, scopeKey),
        eq(libraryDocuments.fileName, fileName),
        eq(libraryDocuments.sha256, sha256),
      ),
    )
    .limit(1);
  const now = new Date();
  if (previous) {
    if (!previous.isCurrent && !archivedMetadata) {
      const current = await tx
        .update(libraryDocuments)
        .set({ isCurrent: false, revision: sql`${libraryDocuments.revision} + 1`, updatedAt: now })
        .where(
          and(
            eq(libraryDocuments.userId, userId),
            eq(libraryDocuments.scopeKey, scopeKey),
            eq(libraryDocuments.fileName, fileName),
            eq(libraryDocuments.isCurrent, true),
          ),
        );
      if (current.rowsAffected > 1) throw new LibraryError("library_conflict", 409);
      const [promoted] = await tx
        .update(libraryDocuments)
        .set({ isCurrent: true, revision: previous.revision + 1, updatedAt: now })
        .where(
          and(
            eq(libraryDocuments.id, previous.id),
            eq(libraryDocuments.revision, previous.revision),
          ),
        )
        .returning(metadata);
      if (!promoted) throw new LibraryError("library_conflict", 409);
      return { document: documentItem(promoted), reused: true };
    }
    return { document: documentItem(previous), reused: true };
  }
  const [current] = await tx
    .select(metadata)
    .from(libraryDocuments)
    .where(
      and(
        eq(libraryDocuments.userId, userId),
        eq(libraryDocuments.scopeKey, scopeKey),
        eq(libraryDocuments.fileName, fileName),
        eq(libraryDocuments.isCurrent, true),
      ),
    )
    .orderBy(desc(libraryDocuments.version))
    .limit(1);
  const [quota] = await tx
    .select({
      count: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${libraryDocuments.fileSize}),0)`,
    })
    .from(libraryDocuments)
    .where(eq(libraryDocuments.userId, userId));
  if (
    Number(quota.count) >= LIBRARY_LIMITS.documents ||
    Number(quota.bytes) + bytes.length > LIBRARY_LIMITS.totalBytes
  )
    throw new LibraryError("library_storage_limit", 413);
  const versionGroupId = current?.versionGroupId ?? preferredId;
  const version = (current?.version ?? 0) + 1;
  if (current) {
    await tx
      .update(libraryDocuments)
      .set({ isCurrent: false, revision: sql`${libraryDocuments.revision} + 1`, updatedAt: now })
      .where(and(eq(libraryDocuments.id, current.id), eq(libraryDocuments.isCurrent, true)));
  }
  const [row] = await tx
    .insert(libraryDocuments)
    .values({
      id: preferredId,
      userId,
      projectId: scope.kind === "project" ? scope.projectId : null,
      scopeKey,
      folderId: current
        ? folderId === undefined
          ? current.folderId
          : folderId
        : (folderId ?? null),
      fileName,
      displayName: current?.displayName ?? archivedMetadata?.displayName ?? fileName,
      tags: current?.tags ?? JSON.stringify(archivedMetadata?.tags ?? []),
      isFavorite: current?.isFavorite ?? archivedMetadata?.isFavorite ?? false,
      versionGroupId,
      version,
      isCurrent: true,
      previousVersionId: current?.id ?? null,
      fileType,
      fileSize: bytes.length,
      sha256,
      originalBase64: bytes.toString("base64"),
      createdAt: now,
      updatedAt: now,
    })
    .returning(metadata);
  return { document: documentItem(row), reused: false };
}
export async function uploadLibraryDocument(
  userId: string,
  scope: LibraryScope,
  fileName: string,
  bytes: Buffer,
  folderId?: string | null,
) {
  const result = await libraryTransaction((tx) =>
    insertLibraryOriginal(tx, userId, scope, fileName, bytes, undefined, undefined, folderId),
  );
  if (result.document.status === "pending") {
    try {
      result.document = await indexLibraryDocument(userId, result.document.id);
    } catch (error) {
      if (!(error instanceof LibraryError) || error.code !== "library_index_busy") throw error;
      result.document = await getLibraryDocument(userId, result.document.id);
    }
  }
  return result;
}
export async function indexLibraryDocument(
  userId: string,
  id: string,
  parser: (
    bytes: Buffer,
    fileType: string,
    expectedPages?: number,
  ) => Promise<string | LibraryParsedDocument> = parseLibraryOriginalDetailed,
  options: { cloudOcr?: boolean } = {},
): Promise<LibraryDocument> {
  const token = `${options.cloudOcr ? "ocr:" : ""}${generateId()}`;
  const claimed = await libraryTransaction(async (tx) => {
    const [row] = await tx.select().from(libraryDocuments).where(ownedWhere(userId, id)).limit(1);
    if (!row) throw new LibraryError("library_not_found", 404);
    if (options.cloudOcr && row.status === "ready")
      throw new LibraryError("library_ocr_ready", 409);
    if (row.status === "indexing" && row.leaseUntil && row.leaseUntil.getTime() > Date.now())
      throw new LibraryError("library_index_busy", 409);
    let ocrPageCount: number | undefined;
    if (options.cloudOcr) {
      if (!row.fileSize || row.fileSize > LIBRARY_LIMITS.fileBytes)
        throw new LibraryError("library_file_limit", 413);
      const original = Buffer.from(row.originalBase64, "base64");
      if (original.length !== row.fileSize || hash(original) !== row.sha256)
        throw new LibraryError("library_ocr_format");
      try {
        ocrPageCount = await validateLibraryOcrOriginal(original, row.fileType);
      } catch (error) {
        if (error instanceof LibraryParseError) throw new LibraryError(error.code);
        throw error;
      }
      // Serialize paid operations per user, also across server processes sharing SQLite.
      const [active] = await tx
        .select({ id: libraryDocuments.id })
        .from(libraryDocuments)
        .where(
          and(
            eq(libraryDocuments.userId, userId),
            eq(libraryDocuments.status, "indexing"),
            gt(libraryDocuments.leaseUntil, new Date()),
            sql`${libraryDocuments.indexToken} like 'ocr:%'`,
          ),
        )
        .limit(1);
      if (active) throw new LibraryError("library_ocr_busy", 409);
      const [quota] = await tx
        .select({
          bytes: sql<number>`coalesce(sum(length(cast(${libraryDocuments.textContent} as blob))),0)`,
        })
        .from(libraryDocuments)
        .where(and(eq(libraryDocuments.userId, userId), sql`${libraryDocuments.id} <> ${id}`));
      if (Number(quota.bytes) >= LIBRARY_LIMITS.totalTextBytes)
        throw new LibraryError("library_text_limit", 413);
    }
    const [updated] = await tx
      .update(libraryDocuments)
      .set({
        status: "indexing",
        errorCode: null,
        indexToken: token,
        revision: row.revision + 1,
        leaseUntil: new Date(
          Date.now() + (options.cloudOcr ? LIBRARY_LIMITS.ocrLeaseMs : LIBRARY_LIMITS.leaseMs),
        ),
        updatedAt: new Date(),
      })
      .where(and(ownedWhere(userId, id), eq(libraryDocuments.revision, row.revision)))
      .returning();
    if (!updated) throw new LibraryError("library_conflict", 409);
    return { ...updated, ocrPageCount };
  });
  const guard = and(
    ownedWhere(userId, id),
    eq(libraryDocuments.revision, claimed.revision),
    eq(libraryDocuments.indexToken, token),
  );
  try {
    const parsed = await parser(
      Buffer.from(claimed.originalBase64, "base64"),
      claimed.fileType,
      claimed.ocrPageCount,
    );
    const text = typeof parsed === "string" ? parsed : parsed.text;
    const pages = typeof parsed === "string" ? undefined : parsed.pages;
    if (!text.trim()) throw new LibraryParseError("library_empty_text");
    if (utf8Bytes(text) > LIBRARY_LIMITS.textBytes)
      throw new LibraryParseError("library_text_limit");
    let pageOffset = 0;
    const pageRanges = pages?.map((page, index) => {
      const range = { page: index + 1, start: pageOffset, end: pageOffset + page.length };
      pageOffset = range.end + 2;
      return range;
    });
    let line = 1;
    const plainText = claimed.fileType === "text/plain";
    let nextBreak = plainText ? text.indexOf("\n") : -1;
    const chunks = chunkTextWithOffsets(text, claimed.fileName).map((chunk) => {
      const { startOffset, endOffset } = chunk;
      const matchingPages = pageRanges?.filter(
        (range) => range.end > range.start && endOffset > range.start && startOffset < range.end,
      );
      while (nextBreak >= 0 && nextBreak < startOffset) {
        line++;
        nextBreak = text.indexOf("\n", nextBreak + 1);
      }
      let lineEnd = line;
      for (let at = nextBreak; at >= 0 && at < endOffset; at = text.indexOf("\n", at + 1))
        lineEnd++;
      return {
        ...chunk,
        pageStart: matchingPages?.[0]?.page,
        pageEnd: matchingPages?.at(-1)?.page,
        lineStart: plainText ? line : undefined,
        lineEnd: plainText ? lineEnd : undefined,
      };
    });
    if (chunks.length > LIBRARY_LIMITS.chunks) throw new LibraryParseError("library_text_limit");
    await libraryTransaction(async (tx) => {
      // Evaluate the lease when committing, not when the claim or HTTP request starts.
      const commitGuard = and(guard, gt(libraryDocuments.leaseUntil, new Date()));
      const [active] = await tx
        .select({ id: libraryDocuments.id })
        .from(libraryDocuments)
        .where(commitGuard)
        .limit(1);
      if (!active) throw new LibraryError("library_conflict", 409);
      const [quota] = await tx
        .select({
          bytes: sql<number>`coalesce(sum(length(cast(${libraryDocuments.textContent} as blob))),0)`,
        })
        .from(libraryDocuments)
        .where(and(eq(libraryDocuments.userId, userId), sql`${libraryDocuments.id} <> ${id}`));
      if (Number(quota.bytes) + utf8Bytes(text) > LIBRARY_LIMITS.totalTextBytes)
        throw new LibraryParseError("library_text_limit");
      const updated = await tx
        .update(libraryDocuments)
        .set({
          status: "ready",
          textContent: text,
          chunkCount: chunks.length,
          errorCode: null,
          indexToken: null,
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(and(guard, gt(libraryDocuments.leaseUntil, new Date())));
      if (updated.rowsAffected !== 1) throw new LibraryError("library_conflict", 409);
      await tx.delete(libraryChunks).where(eq(libraryChunks.documentId, id));
      // Keep statements under SQLite's bound-variable limit.
      for (let offset = 0; offset < chunks.length; offset += 100)
        await tx.insert(libraryChunks).values(
          chunks.slice(offset, offset + 100).map((chunk) => ({
            id: generateId(),
            documentId: id,
            chunkIndex: chunk.index,
            text: chunk.text,
            heading: chunk.heading?.slice(0, 280),
            pageStart: chunk.pageStart ?? null,
            pageEnd: chunk.pageEnd ?? null,
            startOffset: chunk.startOffset ?? null,
            endOffset: chunk.endOffset ?? null,
            lineStart: chunk.lineStart ?? null,
            lineEnd: chunk.lineEnd ?? null,
          })),
        );
      await syncLibraryChunksFts(id, tx);
    });
  } catch (error) {
    if (error instanceof LibraryError) {
      if (options.cloudOcr && error.code === "library_conflict") {
        // An expired claim with no successor is a visible failure, never a successful late write.
        await libraryTransaction(async (tx) => {
          const failed = await tx
            .update(libraryDocuments)
            .set({
              status: "failed",
              errorCode: "library_ocr_lease_expired",
              textContent: "",
              chunkCount: 0,
              indexToken: null,
              leaseUntil: null,
              updatedAt: new Date(),
            })
            .where(and(guard, lte(libraryDocuments.leaseUntil, new Date())));
          if (failed.rowsAffected === 1)
            await tx.delete(libraryChunks).where(eq(libraryChunks.documentId, id));
          await deleteLibraryChunksFts(id, tx);
        });
      }
      throw error;
    }
    const code = error instanceof LibraryParseError ? error.code : "library_parse_failed";
    await libraryTransaction(async (tx) => {
      const result = await tx
        .update(libraryDocuments)
        .set({
          status: "failed",
          textContent: "",
          chunkCount: 0,
          errorCode: code,
          indexToken: null,
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(guard);
      if (result.rowsAffected !== 1) throw new LibraryError("library_conflict", 409);
      await tx.delete(libraryChunks).where(eq(libraryChunks.documentId, id));
      await deleteLibraryChunksFts(id, tx);
    });
  }
  return getLibraryDocument(userId, id);
}
export async function ocrLibraryDocument(
  userId: string,
  id: string,
  connectionToken?: string,
): Promise<LibraryDocument> {
  // Ownership is checked before credentials; the claim repeats all mutable eligibility checks.
  await getLibraryDocument(userId, id);
  const values = await getSettingValues(userId, ["tools.runtime", "tools.connection"]);
  const connection = readToolRuntime(values);
  if (!connection) throw new LibraryError("library_ocr_key_required");
  if (
    (connectionToken || values["tools.connection"] !== undefined) &&
    connectionToken !== toolConnectionFingerprint(connection)
  )
    throw new LibraryError("library_conflict", 409);
  return indexLibraryDocument(
    userId,
    id,
    async (bytes, fileType, expectedPages) => {
      // Fetch the immutable owned filename; a deletion here fails without an upstream request.
      const original = await getLibraryOriginal(userId, id);
      return requestLibraryToolParseDetailed(
        bytes,
        original.fileName,
        fileType,
        connection,
        expectedPages,
      );
    },
    { cloudOcr: true },
  );
}
export async function deleteLibraryDocument(userId: string, id: string, revision: number) {
  await libraryTransaction(async (tx) => {
    const [document] = await tx
      .select(metadata)
      .from(libraryDocuments)
      .where(and(ownedWhere(userId, id), eq(libraryDocuments.revision, revision)))
      .limit(1);
    if (!document) throw new LibraryError("library_conflict", 409);
    const result = await tx
      .delete(libraryDocuments)
      .where(and(ownedWhere(userId, id), eq(libraryDocuments.revision, revision)));
    if (result.rowsAffected !== 1) throw new LibraryError("library_conflict", 409);
    await deleteLibraryChunksFts(id, tx);
    if (document.isCurrent) {
      const [previous] = await tx
        .select(metadata)
        .from(libraryDocuments)
        .where(
          and(
            eq(libraryDocuments.userId, userId),
            eq(libraryDocuments.versionGroupId, document.versionGroupId),
          ),
        )
        .orderBy(desc(libraryDocuments.version), desc(libraryDocuments.updatedAt))
        .limit(1);
      if (previous) {
        await tx
          .update(libraryDocuments)
          .set({ isCurrent: true, revision: previous.revision + 1, updatedAt: new Date() })
          .where(and(eq(libraryDocuments.id, previous.id), eq(libraryDocuments.isCurrent, false)));
      }
    }
  });
  return true;
}
// SQLite lower() is ASCII-only. Match common full-width ASCII and Unicode case
// variants without rewriting stored originals or changing the existing schema.
function libraryTermGlob(word: string): string {
  return `*${Array.from(word, (char) => {
    const variants = libraryKeywordVariants(char);
    // A hyphen at the end of the bracket expression is a literal.
    variants.sort((left, right) => Number(left === "-") - Number(right === "-"));
    return variants.length === 1 ? variants[0] : `[${variants.join("")}]`;
  }).join("")}*`;
}
function libraryFtsQuery(words: string[]): string {
  return words
    .filter((word) => Array.from(word).length >= 3)
    .map((word) => `"${word.replaceAll('"', '""')}"`)
    .join(" OR ");
}
const questionSourceColumns = {
  documentId: libraryDocuments.id,
  fileName: libraryDocuments.fileName,
  chunkIndex: libraryChunks.chunkIndex,
  text: libraryChunks.text,
  heading: libraryChunks.heading,
  location: chunkLocationColumns,
};

function parseQuestionSource(value: unknown): LibraryQuestionSourceRef | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new LibraryError("library_invalid_question");
  const { documentId, chunkIndex, revision } = value as Record<string, unknown>;
  if (
    typeof documentId !== "string" ||
    !documentId ||
    documentId.length > 200 ||
    typeof chunkIndex !== "number" ||
    !Number.isSafeInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex >= LIBRARY_LIMITS.chunks ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    throw new LibraryError("library_invalid_question");
  return { documentId, chunkIndex, revision };
}

async function readQuestionSource(
  reader: Reader,
  userId: string,
  scope: LibraryScope,
  source: LibraryQuestionSourceRef,
): Promise<LibrarySource> {
  const [row] = await reader
    .select(questionSourceColumns)
    .from(libraryChunks)
    .innerJoin(libraryDocuments, eq(libraryChunks.documentId, libraryDocuments.id))
    .where(
      and(
        currentFilter(userId, scope),
        eq(libraryDocuments.status, "ready"),
        eq(libraryDocuments.id, source.documentId),
        eq(libraryDocuments.revision, source.revision),
        eq(libraryChunks.chunkIndex, source.chunkIndex),
      ),
    )
    .limit(1);
  if (!row) throw new LibraryError("library_source_changed", 409);
  const { heading, location, ...chunk } = row;
  return { ...chunk, ...(heading ? { heading } : {}), ...sourceLocation(location) };
}

export async function getSourceForLibraryConversation(
  userId: string,
  conversationId: string,
  input: unknown,
): Promise<LibrarySource> {
  const source = parseQuestionSource(input);
  if (!source) throw new LibraryError("library_invalid_question");
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ projectId: conversations.projectId, systemPrompt: conversations.systemPrompt })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
      .limit(1);
    if (!conversation?.systemPrompt?.trimStart().startsWith(LIBRARY_SYSTEM_TAG))
      throw new LibraryError("library_not_found", 404);
    const scope: LibraryScope = conversation.projectId
      ? { kind: "project", projectId: conversation.projectId }
      : { kind: "personal" };
    await validateLibraryScope(tx, userId, scope);
    return readQuestionSource(tx, userId, scope, source);
  });
}

async function searchQuestionSources(
  reader: Reader,
  userId: string,
  scope: LibraryFilter,
  query: string,
): Promise<LibrarySearchResult[]> {
  const words = libraryKeywords(query, true);
  if (!words.length) return [];
  const terms = words.map((word) => {
    const pattern = libraryTermGlob(word);
    return {
      body: sql`${libraryChunks.text} glob ${pattern}`,
      title: sql`${libraryDocuments.fileName} glob ${pattern}`,
    };
  });
  const score = sql<number>`(${sql.join(
    terms.map(
      ({ body, title }) =>
        sql`case when ${body} then 1 else 0 end + case when ${title} then 2 else 0 end`,
    ),
    sql` + `,
  )})`;
  const minimumMatches = words.length >= 4 ? 2 : 1;
  const relevant =
    minimumMatches === 1
      ? sql`${score} > 0`
      : sql`(${sql.join(
          terms.map(({ body, title }) => sql`case when ${body} or ${title} then 1 else 0 end`),
          sql` + `,
        )}) >= ${minimumMatches}`;
  const rows = await reader
    .select({ ...questionSourceColumns, score })
    .from(libraryChunks)
    .innerJoin(libraryDocuments, eq(libraryChunks.documentId, libraryDocuments.id))
    .where(and(currentFilter(userId, scope), eq(libraryDocuments.status, "ready"), relevant))
    .orderBy(desc(score), libraryDocuments.id, libraryChunks.chunkIndex)
    .limit(20);
  return rows.map(({ heading, location, ...row }) => ({
    ...row,
    ...(heading ? { heading } : {}),
    ...sourceLocation(location),
  }));
}
export async function searchLibrary(
  userId: string,
  scope: LibraryFilter,
  query: string,
  options: LibraryListOptions = {},
  match?: LibrarySearchMatchRequest,
): Promise<LibrarySearchResult[]> {
  if (typeof query !== "string" || query.length > LIBRARY_LIMITS.questionChars)
    throw new LibraryError("library_invalid_question");
  if (
    match &&
    (!match.documentId ||
      match.documentId.length > 200 ||
      !Number.isSafeInteger(match.index) ||
      match.index < 0 ||
      match.index >= LIBRARY_LIMITS.chunks ||
      !Number.isSafeInteger(match.revision) ||
      match.revision < 1)
  )
    throw new LibraryError("library_invalid_data");
  await validateLibraryScope(db, userId, scope);
  const words = libraryKeywords(query);
  if (!words.length) return [];
  const terms = words.map((word) => ({ word, pattern: libraryTermGlob(word) }));
  const countTerms = (condition: (term: (typeof terms)[number]) => ReturnType<typeof sql>) =>
    sql.join(
      terms.map((term) => sql`CASE WHEN ${condition(term)} THEN 1 ELSE 0 END`),
      sql` + `,
    );
  const titleScore = countTerms(
    ({ pattern }) => sql`
    ${libraryDocuments.fileName} GLOB ${pattern} OR ${libraryDocuments.displayName} GLOB ${pattern}
  `,
  );
  const unicodeChunkScore = countTerms(
    ({ pattern }) => sql`c.text GLOB ${pattern} OR c.heading GLOB ${pattern}`,
  );
  // SQLite's ASCII case-fold and literal substring search are cheaper on
  // ASCII-only chunks. Keep the width-aware matcher for all other chunks.
  const chunkScore = words.every((word) => /^[a-z0-9_-]+$/.test(word))
    ? sql`CASE WHEN length(CAST(c.text AS BLOB)) = length(c.text) THEN (${countTerms(
        ({ word, pattern }) => sql`instr(lower(c.text), ${word}) > 0 OR c.heading GLOB ${pattern}`,
      )}) ELSE (${unicodeChunkScore}) END`
    : unicodeChunkScore;
  const scopeWhere = and(
    visibleFilter(userId, scope, options),
    match ? eq(libraryDocuments.id, match.documentId) : undefined,
    match ? eq(libraryDocuments.revision, match.revision) : undefined,
  );
  const ftsQuery = libraryFtsQuery(words);
  type SearchRow = Partial<Record<keyof LibrarySourceLocation, number | null>> & {
    documentId: string;
    fileName: string;
    revision: number;
    chunkIndex: number | null;
    heading: string | null;
    text: string | null;
    score: number;
    matchCount: number;
  };
  // Count all matching chunks before selecting a representative for each document.
  // Only the chosen chunk needs to return its full text and location to the client.
  const read = (withFts: boolean) =>
    db.all<SearchRow>(sql`
    WITH scoped AS MATERIALIZED (
      SELECT id, file_name, status, revision, updated_at, (${titleScore}) AS title_score
      FROM library_documents WHERE ${scopeWhere}
    ),
    ${
      withFts
        ? sql`
      indexed AS MATERIALIZED (
        SELECT DISTINCT f.document_id, f.chunk_index
        FROM library_chunks_fts f JOIN scoped d ON d.id = f.document_id
        WHERE library_chunks_fts MATCH ${ftsQuery} AND d.status = 'ready'
      ),
    `
        : sql``
    }
    candidates AS MATERIALIZED (
      SELECT c.id, c.document_id, c.chunk_index, (${chunkScore}) AS chunk_score,
             ${withFts ? sql`i.document_id IS NOT NULL` : sql`0`} AS indexed_match
      FROM library_chunks c JOIN scoped d ON d.id = c.document_id AND d.status = 'ready'
      ${withFts ? sql`LEFT JOIN indexed i ON i.document_id = c.document_id AND i.chunk_index = c.chunk_index` : sql``}
    ),
    ranked AS (
      SELECT id, document_id, chunk_score, indexed_match,
             count(*) OVER (PARTITION BY document_id) AS match_count,
             row_number() OVER (PARTITION BY document_id
               ORDER BY chunk_score DESC, indexed_match DESC, chunk_index) AS position
      FROM candidates WHERE chunk_score > 0 OR indexed_match
    )
    SELECT d.id AS documentId, d.file_name AS fileName, d.revision,
           c.chunk_index AS chunkIndex, c.text, c.heading,
           c.page_start AS pageStart, c.page_end AS pageEnd,
           c.start_offset AS startOffset, c.end_offset AS endOffset,
           c.line_start AS lineStart, c.line_end AS lineEnd,
           coalesce(r.match_count, 0) AS matchCount,
           2 * d.title_score + coalesce(r.chunk_score, 0) AS score
    FROM scoped d LEFT JOIN ranked r ON r.document_id = d.id AND r.position = ${(match?.index ?? 0) + 1}
    LEFT JOIN library_chunks c ON c.id = r.id
    WHERE ${match ? sql`r.id IS NOT NULL` : sql`d.title_score > 0 OR r.id IS NOT NULL`}
    ORDER BY score DESC, coalesce(r.indexed_match, 0) DESC, d.updated_at DESC, d.id
  `);
  let rows: SearchRow[];
  try {
    rows = await read(Boolean(ftsQuery));
  } catch (error) {
    if (
      !ftsQuery ||
      !(error instanceof Error) ||
      !/no such (?:table: library_chunks_fts|module: fts5)/i.test(String(error.cause ?? error))
    )
      throw error;
    rows = await read(false);
  }
  if (match && !rows.length) throw new LibraryError("library_conflict", 409);
  return rows.map((row) => ({
    documentId: row.documentId,
    fileName: row.fileName,
    revision: Number(row.revision),
    score: Number(row.score),
    matchCount: Number(row.matchCount),
    matchIndex: match?.index ?? 0,
    chunkIndex: Number(row.chunkIndex ?? 0),
    text: row.text ?? "",
    ...(row.heading ? { heading: row.heading } : {}),
    ...sourceLocation(row),
  }));
}
async function questionItem(
  reader: Reader,
  userId: string,
  row: typeof libraryQuestions.$inferSelect,
): Promise<PreparedLibraryQuestion> {
  const [conversation] = row.conversationId
    ? await reader
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.userId, userId), eq(conversations.id, row.conversationId)))
        .limit(1)
    : [];
  const [project] = row.projectId
    ? await reader
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.userId, userId), eq(projects.id, row.projectId)))
        .limit(1)
    : [];
  const scopeAvailable = row.scopeKind === "personal" || !!project;
  const question: LibraryQuestion = {
    id: row.id,
    requestId: row.requestId,
    scope:
      row.scopeKind === "personal"
        ? { kind: "personal" }
        : { kind: "project", projectId: row.scopeProjectId ?? "unavailable" },
    scopeAvailable,
    conversationId: conversation?.id ?? null,
    channelId: row.channelId,
    modelId: row.modelId,
    question: row.question,
    sources: JSON.parse(row.sources),
    prompt: row.prompt,
    createdAt: row.createdAt.toISOString(),
  };
  return { question, replayable: !!conversation && scopeAvailable };
}
export async function listLibraryQuestions(userId: string): Promise<LibraryQuestion[]> {
  const rows = await db
    .select()
    .from(libraryQuestions)
    .where(eq(libraryQuestions.userId, userId))
    .orderBy(desc(libraryQuestions.createdAt), libraryQuestions.id);
  return Promise.all(rows.map(async (row) => (await questionItem(db, userId, row)).question));
}
export async function getLibraryQuestion(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(libraryQuestions)
    .where(and(eq(libraryQuestions.userId, userId), eq(libraryQuestions.id, id)))
    .limit(1);
  if (!row) throw new LibraryError("library_not_found", 404);
  return questionItem(db, userId, row);
}
export async function deleteLibraryQuestion(userId: string, id: string) {
  return (
    (
      await db
        .delete(libraryQuestions)
        .where(and(eq(libraryQuestions.userId, userId), eq(libraryQuestions.id, id)))
    ).rowsAffected === 1
  );
}
export async function prepareLibraryQuestion(
  userId: string,
  value: unknown,
): Promise<PreparedLibraryQuestion> {
  if (!value || typeof value !== "object") throw new LibraryError("library_invalid_question");
  const input = value as Record<string, unknown>;
  const scope = parseLibraryScope(input.scope) as LibraryScope;
  if (
    typeof input.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(input.requestId) ||
    typeof input.question !== "string" ||
    !input.question.trim() ||
    input.question.trim().length > LIBRARY_LIMITS.questionChars ||
    typeof input.channelId !== "string" ||
    typeof input.modelId !== "string"
  )
    throw new LibraryError("library_invalid_question");
  const question = input.question.trim(),
    requestId = input.requestId,
    channelId = input.channelId,
    requestedModel = input.modelId;
  const source = parseQuestionSource(input.source);
  const inputHash = hash(
    JSON.stringify({ scope, question, channelId, modelId: requestedModel, source }),
  );
  const reuse = async (reader: Reader) => {
    const [row] = await reader
      .select()
      .from(libraryQuestions)
      .where(and(eq(libraryQuestions.userId, userId), eq(libraryQuestions.requestId, requestId)))
      .limit(1);
    if (!row) return null;
    if (row.inputHash !== inputHash) throw new LibraryError("library_request_conflict", 409);
    return questionItem(reader, userId, row);
  };
  const previous = await reuse(db);
  if (previous) return previous;
  const [ownedChannel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.id, channelId)))
    .limit(1);
  if (!ownedChannel) throw new LibraryError("library_channel_unavailable");
  const channel = await getChannelById(userId, channelId);
  const modelId = channel ? resolveModelIdFromChannelItem(channel, requestedModel) : null;
  if (!channel?.enabled || !channel.hasApiKey || channel.protocol === "acp" || !modelId)
    throw new LibraryError("library_channel_unavailable");
  return libraryTransaction(async (tx) => {
    const existing = await reuse(tx);
    if (existing) return existing;
    await validateLibraryScope(tx, userId, scope);
    const [liveChannel] = await tx
      .select()
      .from(channels)
      .where(and(eq(channels.userId, userId), eq(channels.id, channelId)))
      .limit(1);
    if (!liveChannel?.enabled || liveChannel.protocol === "acp")
      throw new LibraryError("library_channel_unavailable");
    const [quota] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(libraryQuestions)
      .where(eq(libraryQuestions.userId, userId));
    if (Number(quota.count) >= LIBRARY_LIMITS.questions)
      throw new LibraryError("library_question_limit", 413);
    const candidates = source
      ? [await readQuestionSource(tx, userId, scope, source)]
      : (await searchQuestionSources(tx, userId, scope, question)).map(
          ({ score: _score, ...chunk }) => chunk,
        );
    const sources = packLibrarySources(question, candidates);
    if (!sources.length) throw new LibraryError("library_no_sources", 409);
    const now = new Date(),
      conversationId = generateId();
    await tx.insert(conversations).values({
      id: conversationId,
      userId,
      projectId: scope.kind === "project" ? scope.projectId : null,
      title: question.slice(0, 100),
      channelId,
      modelId,
      systemPrompt: LIBRARY_SYSTEM_PROMPT,
      contextLength: 32768,
      defaultMode: "chat",
      lastMode: "chat",
      forceWebSearch: false,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await tx
      .insert(libraryQuestions)
      .values({
        id: generateId(),
        userId,
        requestId,
        inputHash,
        scopeKind: scope.kind,
        scopeProjectId: scope.kind === "project" ? scope.projectId : null,
        projectId: scope.kind === "project" ? scope.projectId : null,
        conversationId,
        channelId,
        modelId,
        question,
        sources: JSON.stringify(sources),
        prompt: libraryQuestionPayload(question, sources),
        createdAt: now,
      })
      .returning();
    return questionItem(tx, userId, row);
  });
}
