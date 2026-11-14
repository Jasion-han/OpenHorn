import { createHash } from "node:crypto";
import {
  channels,
  conversations,
  libraryChunks,
  libraryDocuments,
  libraryQuestions,
  projects,
} from "db";
import { and, desc, eq, getTableColumns, gt, lte, sql } from "drizzle-orm";
import {
  LIBRARY_LIMITS,
  LIBRARY_SYSTEM_PROMPT,
  libraryFileType,
  libraryKeywords,
  libraryOcrFileType,
  libraryQuestionPayload,
  libraryScopeKey,
  packLibrarySources,
  utf8Bytes,
} from "shared/library";
import type {
  LibraryDocument,
  LibraryDocumentDetail,
  LibraryFilter,
  LibraryQuestion,
  LibraryScope,
  LibrarySearchResult,
  PreparedLibraryQuestion,
} from "shared/types";
import { db } from "../db";
import { generateId } from "../utils";
import { getChannelById, resolveModelIdFromChannelItem } from "./channelService";
import { chunkText } from "./chunkingService";
import { requestLibraryOcr } from "./libraryOcr";
import {
  LibraryParseError,
  parseLibraryOriginal,
  validateLibraryOcrOriginal,
} from "./libraryParser";
import { getSettingValues } from "./settingsService";

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
function documentItem(row: Omit<Row, "originalBase64" | "textContent">): LibraryDocument {
  return {
    id: row.id,
    projectId: row.projectId,
    fileName: row.fileName,
    fileType: row.fileType,
    fileSize: row.fileSize,
    status: row.status,
    errorCode: row.errorCode,
    chunkCount: row.chunkCount,
    revision: row.revision,
    canIndex:
      row.status !== "indexing" || !row.leaseUntil || row.leaseUntil.getTime() <= Date.now(),
    canOcr:
      libraryOcrFileType(row.fileType) &&
      row.status !== "ready" &&
      (row.status !== "indexing" || !row.leaseUntil || row.leaseUntil.getTime() <= Date.now()),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function listLibraryDocuments(
  userId: string,
  scope: LibraryFilter,
): Promise<LibraryDocument[]> {
  await validateLibraryScope(db, userId, scope);
  return (
    await db
      .select(metadata)
      .from(libraryDocuments)
      .where(filter(userId, scope))
      .orderBy(desc(libraryDocuments.updatedAt), libraryDocuments.id)
  ).map(documentItem);
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
export function validateLibraryFileName(fileName: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: filenames must not contain header/path control characters
  if (!fileName || fileName.length > 200 || /[\x00-\x1f\x7f/\\]/.test(fileName))
    throw new LibraryError("library_invalid_file");
  const fileType = libraryFileType(fileName);
  if (!fileType) throw new LibraryError("library_unsupported_file");
  return fileType;
}
export async function insertLibraryOriginal(
  tx: Writer,
  userId: string,
  scope: LibraryScope,
  fileName: string,
  bytes: Buffer,
  preferredId = generateId(),
): Promise<{ document: LibraryDocument; reused: boolean }> {
  await validateLibraryScope(tx, userId, scope);
  const fileType = validateLibraryFileName(fileName);
  if (!bytes.length || bytes.length > LIBRARY_LIMITS.fileBytes)
    throw new LibraryError("library_file_limit", 413);
  const scopeKey = libraryScopeKey(scope),
    sha256 = hash(bytes);
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
  if (previous) return { document: documentItem(previous), reused: true };
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
  const now = new Date();
  const [row] = await tx
    .insert(libraryDocuments)
    .values({
      id: preferredId,
      userId,
      projectId: scope.kind === "project" ? scope.projectId : null,
      scopeKey,
      fileName,
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
) {
  const result = await libraryTransaction((tx) =>
    insertLibraryOriginal(tx, userId, scope, fileName, bytes),
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
  ) => Promise<string> = parseLibraryOriginal,
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
    const text = await parser(
      Buffer.from(claimed.originalBase64, "base64"),
      claimed.fileType,
      claimed.ocrPageCount,
    );
    if (!text.trim()) throw new LibraryParseError("library_empty_text");
    if (utf8Bytes(text) > LIBRARY_LIMITS.textBytes)
      throw new LibraryParseError("library_text_limit");
    const chunks = chunkText(text, claimed.fileName);
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
          })),
        );
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
    });
  }
  return getLibraryDocument(userId, id);
}
export async function ocrLibraryDocument(userId: string, id: string): Promise<LibraryDocument> {
  // Ownership is checked before credentials; the claim repeats all mutable eligibility checks.
  await getLibraryDocument(userId, id);
  const values = await getSettingValues(userId, ["deepseek.toolsApiKey"]);
  const apiKey = values["deepseek.toolsApiKey"]?.trim();
  if (!apiKey) throw new LibraryError("library_ocr_key_required");
  return indexLibraryDocument(
    userId,
    id,
    async (bytes, fileType, expectedPages) => {
      // Fetch the immutable owned filename; a deletion here fails without an upstream request.
      const original = await getLibraryOriginal(userId, id);
      return requestLibraryOcr(bytes, original.fileName, fileType, apiKey, expectedPages);
    },
    { cloudOcr: true },
  );
}
export async function deleteLibraryDocument(userId: string, id: string, revision: number) {
  const result = await db
    .delete(libraryDocuments)
    .where(and(ownedWhere(userId, id), eq(libraryDocuments.revision, revision)));
  if (result.rowsAffected !== 1) throw new LibraryError("library_conflict", 409);
  return true;
}
// SQLite lower() is ASCII-only. Match common full-width ASCII and Unicode case
// variants without rewriting stored originals or changing the existing schema.
function libraryTermGlob(word: string): string {
  return `*${Array.from(word, (char) => {
    const code = char.charCodeAt(0);
    const variants = [
      ...new Set([
        char,
        char.toUpperCase(),
        char.toLowerCase(),
        ...(code >= 0x61 && code <= 0x7a
          ? [String.fromCharCode(code + 0xfee0), String.fromCharCode(code - 32 + 0xfee0)]
          : code >= 0x30 && code <= 0x39
            ? [String.fromCharCode(code + 0xfee0)]
            : char === "_" || char === "-"
              ? [String.fromCharCode(code + 0xfee0)]
              : []),
      ]),
    ].filter((variant) => Array.from(variant).length === 1);
    // A hyphen at the end of the bracket expression is a literal.
    variants.sort((left, right) => Number(left === "-") - Number(right === "-"));
    return variants.length === 1 ? variants[0] : `[${variants.join("")}]`;
  }).join("")}*`;
}
async function searchIn(
  reader: Reader,
  userId: string,
  scope: LibraryFilter,
  query: string,
  forQuestion = false,
): Promise<LibrarySearchResult[]> {
  const words = libraryKeywords(query, forQuestion);
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
  const minimumMatches = forQuestion && words.length >= 4 ? 2 : 1;
  const relevant =
    minimumMatches === 1
      ? sql`${score} > 0`
      : sql`(${sql.join(
          terms.map(({ body, title }) => sql`case when ${body} or ${title} then 1 else 0 end`),
          sql` + `,
        )}) >= ${minimumMatches}`;
  const rows = await reader
    .select({
      documentId: libraryDocuments.id,
      fileName: libraryDocuments.fileName,
      chunkIndex: libraryChunks.chunkIndex,
      text: libraryChunks.text,
      heading: libraryChunks.heading,
      score,
    })
    .from(libraryChunks)
    .innerJoin(libraryDocuments, eq(libraryChunks.documentId, libraryDocuments.id))
    .where(and(filter(userId, scope), eq(libraryDocuments.status, "ready"), relevant))
    .orderBy(desc(score), libraryDocuments.id, libraryChunks.chunkIndex)
    .limit(20);
  return rows.map(({ heading, ...row }) => ({ ...row, ...(heading ? { heading } : {}) }));
}
export async function searchLibrary(userId: string, scope: LibraryFilter, query: string) {
  if (typeof query !== "string" || query.length > LIBRARY_LIMITS.questionChars)
    throw new LibraryError("library_invalid_question");
  await validateLibraryScope(db, userId, scope);
  return searchIn(db, userId, scope, query);
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
  const inputHash = hash(JSON.stringify({ scope, question, channelId, modelId: requestedModel }));
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
    const candidates = (await searchIn(tx, userId, scope, question, true)).map(
      ({ score: _score, ...source }) => source,
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
