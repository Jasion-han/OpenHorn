import { channels, conversations, messages, reviewWorkspaces } from "db";
import { and, desc, eq, sql } from "drizzle-orm";
import { JEV_RESOLVED_MODEL } from "shared/decisions";
import { assistantMessageContent } from "shared/message-text";
import {
  buildReviewNoteRequest,
  REVIEW_NOTE_POLICY,
  requestModelForNoteVerification,
} from "shared/review-note";
import {
  applyReviewResults,
  buildReviewPrompt,
  createReviewData,
  parseReviewResults,
  REVIEW_JSON_SYSTEM_TAG,
  REVIEW_LIMITS,
  ReviewValidationError,
  reviewBatchChars,
  validateReviewData,
  validateReviewResult,
} from "shared/reviews";
import type {
  PreparedReviewRun,
  ReviewData,
  ReviewNoteVerificationResult,
  ReviewRun,
  ReviewWorkspace,
  ReviewWorkspaceSummary,
} from "shared/types";
import { db } from "../db";
import { generateId } from "../utils";
import { getChannelById, resolveModelIdFromChannelItem } from "./channelService";
import { getJevApiKey } from "./decisionUsageService";
import { evaluateReviewNote, ReviewNoteVerificationError } from "./reviewNoteVerification";

export class ReviewWorkspaceError extends Error {
  constructor(
    readonly code:
      | "review_not_found"
      | "review_conflict"
      | "review_source_not_ready"
      | "review_channel_unavailable"
      | "review_invalid_data",
    readonly status: 400 | 404 | 409,
  ) {
    super(code);
  }
}
type Row = typeof reviewWorkspaces.$inferSelect;
type Reader = Pick<typeof db, "select">;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewWorkspaceError("review_invalid_data", 400);
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  )
    throw new ReviewWorkspaceError("review_invalid_data", 400);
  return value;
}
function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200)
    throw new ReviewWorkspaceError("review_invalid_data", 400);
  return value.trim();
}
function item(row: Row): ReviewWorkspace {
  const data = validateReviewData(JSON.parse(row.data));
  return {
    id: row.id,
    title: row.title,
    revision: row.revision,
    data,
    rowCount: data.rows.length,
    annotatedCount: data.rows.filter((row) => row.annotation).length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
async function owned(reader: Reader, userId: string, id: string) {
  const [row] = await reader
    .select()
    .from(reviewWorkspaces)
    .where(and(eq(reviewWorkspaces.id, id), eq(reviewWorkspaces.userId, userId)))
    .limit(1);
  if (!row) throw new ReviewWorkspaceError("review_not_found", 404);
  return row;
}
const writes = new Map<string, Promise<void>>();
async function serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = writes.get(id);
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  writes.set(id, pending);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (writes.get(id) === pending) writes.delete(id);
  }
}
function current(row: Row, revision: unknown) {
  if (row.revision !== positive(revision)) throw new ReviewWorkspaceError("review_conflict", 409);
}
type Writer = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function save(tx: Writer, row: Row, data: ReviewData): Promise<ReviewWorkspace> {
  const validated = validateReviewData(data);
  const updatedAt = new Date();
  const result = await tx
    .update(reviewWorkspaces)
    .set({ data: JSON.stringify(validated), revision: row.revision + 1, updatedAt })
    .where(
      and(
        eq(reviewWorkspaces.id, row.id),
        eq(reviewWorkspaces.userId, row.userId),
        eq(reviewWorkspaces.revision, row.revision),
      ),
    );
  if (result.rowsAffected !== 1) throw new ReviewWorkspaceError("review_conflict", 409);
  return item({ ...row, data: JSON.stringify(validated), revision: row.revision + 1, updatedAt });
}
export async function listReviewWorkspaces(userId: string): Promise<ReviewWorkspaceSummary[]> {
  const rows = await db
    .select()
    .from(reviewWorkspaces)
    .where(eq(reviewWorkspaces.userId, userId))
    .orderBy(desc(reviewWorkspaces.updatedAt), desc(reviewWorkspaces.id));
  return rows.map((row) => {
    const { data: _data, ...summary } = item(row);
    return summary;
  });
}
export async function getReviewWorkspace(userId: string, id: string): Promise<ReviewWorkspace> {
  return item(await owned(db, userId, id));
}
export async function createReviewWorkspace(
  userId: string,
  value: unknown,
): Promise<ReviewWorkspace> {
  const input = object(value),
    now = new Date();
  // CSV bytes can expand substantially when source/records are JSON-escaped.
  // Validate the complete document before INSERT so a rejected import leaves no unreadable row.
  const data = validateReviewData(createReviewData(input));
  const row: Row = {
    id: generateId(),
    userId,
    title: title(input.title),
    revision: 1,
    data: JSON.stringify(data),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(reviewWorkspaces).values(row);
  return item(row);
}
export async function deleteReviewWorkspace(
  userId: string,
  id: string,
  expectedRevision: unknown,
): Promise<boolean> {
  return serialized(id, () =>
    db.transaction(async (tx) => {
      const row = await owned(tx, userId, id);
      current(row, expectedRevision);
      const result = await tx
        .delete(reviewWorkspaces)
        .where(
          and(
            eq(reviewWorkspaces.id, id),
            eq(reviewWorkspaces.userId, userId),
            eq(reviewWorkspaces.revision, row.revision),
          ),
        );
      if (result.rowsAffected !== 1) throw new ReviewWorkspaceError("review_conflict", 409);
      return true;
    }),
  );
}
export async function updateReviewAnnotation(
  userId: string,
  id: string,
  rowId: string,
  value: unknown,
): Promise<ReviewWorkspace> {
  const input = object(value);
  return serialized(id, () =>
    db.transaction(async (tx) => {
      const row = await owned(tx, userId, id);
      current(row, input.expectedRevision);
      const data = item(row).data,
        record = data.rows.find((entry) => entry.id === rowId);
      if (!record) throw new ReviewWorkspaceError("review_not_found", 404);
      const { id: _id, ...annotation } = validateReviewResult(
        { ...object(input.annotation), id: rowId },
        record.text,
      );
      record.annotation = { ...annotation, source: "manual", runId: null };
      record.annotationRevision++;
      delete record.noteVerification;
      return save(tx, row, data);
    }),
  );
}
export async function prepareReviewRun(
  userId: string,
  id: string,
  value: unknown,
): Promise<PreparedReviewRun> {
  const input = object(value);
  // A retry after a lost ACK must not create a second conversation, even with the old revision.
  return serialized(id, async () => {
    const existing = item(await owned(db, userId, id));
    if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(input.requestId))
      throw new ReviewWorkspaceError("review_invalid_data", 400);
    const previous = existing.data.runs.find((run) => run.requestId === input.requestId);
    if (previous)
      return { workspace: existing, run: previous, prompt: buildReviewPrompt(previous) };
    current(await owned(db, userId, id), input.expectedRevision);
    if (typeof input.channelId !== "string" || typeof input.modelId !== "string")
      throw new ReviewWorkspaceError("review_channel_unavailable", 400);
    const [ownedChannel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.userId, userId)))
      .limit(1);
    if (!ownedChannel) throw new ReviewWorkspaceError("review_channel_unavailable", 400);
    const channel = await getChannelById(userId, input.channelId);
    const modelId = channel ? resolveModelIdFromChannelItem(channel, input.modelId) : null;
    if (!channel?.enabled || !channel.hasApiKey || channel.protocol === "acp" || !modelId)
      throw new ReviewWorkspaceError("review_channel_unavailable", 400);
    if (
      !Array.isArray(input.rowIds) ||
      !input.rowIds.length ||
      input.rowIds.length > REVIEW_LIMITS.batchRows ||
      new Set(input.rowIds).size !== input.rowIds.length ||
      typeof input.instructions !== "string" ||
      !input.instructions.trim() ||
      input.instructions.length > 6000
    )
      throw new ReviewWorkspaceError("review_invalid_data", 400);
    if (existing.data.runs.length >= REVIEW_LIMITS.runs)
      throw new ReviewWorkspaceError("review_invalid_data", 400);
    const instructions = input.instructions;
    const inputs = input.rowIds.map((rowId) => {
      const row = existing.data.rows.find((entry) => entry.id === rowId);
      if (!row) throw new ReviewWorkspaceError("review_invalid_data", 400);
      return { id: row.id, text: row.text, rating: row.rating, revision: row.annotationRevision };
    });
    if (reviewBatchChars(inputs) > REVIEW_LIMITS.batchChars)
      throw new ReviewWorkspaceError("review_invalid_data", 400);
    const conversationId = generateId(),
      now = new Date();
    const run: ReviewRun = {
      id: generateId(),
      requestId: input.requestId,
      conversationId,
      sourceMessageId: null,
      createdAt: now.toISOString(),
      importedAt: null,
      inputs,
      instructions,
      results: null,
      applied: 0,
      skipped: 0,
    };
    return db.transaction(async (tx) => {
      const row = await owned(tx, userId, id);
      current(row, input.expectedRevision);
      const data = item(row).data;
      data.runs.push(run);
      // Do not call createConversation(): it uses the global DB, outside this transaction.
      await tx.insert(conversations).values({
        id: conversationId,
        userId,
        title: existing.title,
        channelId: channel.id,
        modelId,
        systemPrompt: `${REVIEW_JSON_SYSTEM_TAG}\n${instructions}`,
        contextLength: 32768,
        defaultMode: "chat",
        lastMode: "chat",
        forceWebSearch: false,
        createdAt: now,
        updatedAt: now,
      });
      const workspace = await save(tx, row, data);
      return { workspace, run, prompt: buildReviewPrompt(run) };
    });
  });
}
export async function importReviewRun(
  userId: string,
  id: string,
  runId: string,
  expectedRevision: unknown,
): Promise<ReviewWorkspace> {
  return serialized(id, () =>
    db.transaction(async (tx) => {
      const row = await owned(tx, userId, id),
        workspace = item(row);
      const run = workspace.data.runs.find((run) => run.id === runId);
      if (!run) throw new ReviewWorkspaceError("review_not_found", 404);
      if (run.results) return workspace;
      current(row, expectedRevision);
      if (!run.conversationId) throw new ReviewWorkspaceError("review_source_not_ready", 409);
      const [source] = await tx
        .select({ message: messages })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            eq(conversations.userId, userId),
            eq(conversations.id, run.conversationId),
            eq(messages.role, "assistant"),
          ),
        )
        .orderBy(desc(messages.createdAt), sql`messages.rowid DESC`)
        .limit(1);
      if (!source || source.message.finishReason)
        throw new ReviewWorkspaceError("review_source_not_ready", 409);
      if (source.message.agentRun) {
        let status: unknown;
        try {
          status = JSON.parse(source.message.agentRun)?.status;
        } catch {
          /* reject below */
        }
        if (status !== "completed") throw new ReviewWorkspaceError("review_source_not_ready", 409);
      }
      const content = assistantMessageContent(source.message.content, source.message.agentRun);
      if (!content.trim()) throw new ReviewWorkspaceError("review_source_not_ready", 409);
      const results = parseReviewResults(content, run);
      return save(
        tx,
        row,
        applyReviewResults(
          workspace.data,
          runId,
          results,
          source.message.id,
          new Date().toISOString(),
        ),
      );
    }),
  );
}

/** Successful cache avoids duplicate calls; unknown/failed outcomes are never retried automatically. */
export async function verifyReviewNote(
  userId: string,
  id: string,
  rowId: string,
  value: unknown,
  evaluate: typeof evaluateReviewNote = evaluateReviewNote,
): Promise<ReviewNoteVerificationResult> {
  const input = object(value);
  positive(input.expectedRevision);
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(input.requestId))
    throw new ReviewWorkspaceError("review_invalid_data", 400);
  const requestId = input.requestId;
  return serialized(id, async () => {
    const row = await owned(db, userId, id),
      workspace = item(row);
    const record = workspace.data.rows.find((entry) => entry.id === rowId);
    if (!record) throw new ReviewWorkspaceError("review_not_found", 404);
    if (!record.annotation?.note.trim())
      throw new ReviewNoteVerificationError("review_verification_empty", 400);
    const cached = record.noteVerification;
    if (
      cached &&
      cached.annotationRevision === record.annotationRevision &&
      cached.model === (getJevApiKey() ? JEV_RESOLVED_MODEL : REVIEW_NOTE_POLICY.model) &&
      cached.questionVersion === REVIEW_NOTE_POLICY.questionVersion &&
      (row.revision === input.expectedRevision || cached.requestId === requestId)
    ) {
      return {
        workspace,
        verification: cached,
        request: buildReviewNoteRequest(record.text, record.annotation.note, {
          model: requestModelForNoteVerification(cached.model),
        }),
        cached: true,
      };
    }
    current(row, input.expectedRevision);
    // Fixed-shape verification metadata is under 1 KiB, including maximum IDs and numeric fields.
    // Reserve this before the paid call; save still validates the actual document and SQL CAS.
    if (Buffer.byteLength(row.data, "utf8") + 1024 > REVIEW_LIMITS.documentBytes)
      throw new ReviewValidationError("review_limit");
    const evaluation = await evaluate(record.text, record.annotation.note, { userId });
    const verification = {
      requestId,
      annotationRevision: record.annotationRevision,
      model: evaluation.model,
      questionVersion: REVIEW_NOTE_POLICY.questionVersion,
      checkedAt: new Date().toISOString(),
      probability: evaluation.probability,
      ...(evaluation.hasClaimsProbability !== undefined
        ? { hasClaimsProbability: evaluation.hasClaimsProbability }
        : {}),
      verdict: evaluation.verdict,
      usage: evaluation.usage,
      latencyMs: evaluation.latencyMs,
    };
    // Network waits hold no SQL transaction. Another process can legitimately change this workspace.
    return db.transaction(async (tx) => {
      const latest = await owned(tx, userId, id);
      current(latest, row.revision);
      const data = item(latest).data,
        target = data.rows.find((entry) => entry.id === rowId);
      if (
        !target ||
        target.annotationRevision !== record.annotationRevision ||
        target.text !== record.text ||
        target.annotation?.note !== record.annotation?.note
      )
        throw new ReviewWorkspaceError("review_conflict", 409);
      target.noteVerification = verification;
      const saved = await save(tx, latest, data);
      return { workspace: saved, verification, request: evaluation.request, cached: false };
    });
  });
}
