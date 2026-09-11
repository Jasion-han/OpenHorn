/**
 * Import history — one row per import run, regardless of where the import
 * happened (server-side scan/backup, or a desktop-side MCP/skill/credential
 * import reported back through `POST /import/records`).
 *
 * Deleting a record only removes the history entry; the imported rows keep
 * their `imported_from` / `imported_at` markers.
 */
import { importRecords } from "db";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { IMPORT_PART_ITEMS_LIMIT } from "shared/constants";
import type {
  CreateImportRecordInput,
  ImportKind,
  ImportPart,
  ImportPartItem,
  ImportPartLinkKind,
  ImportPartType,
  ImportRecord,
  ImportRecordListResult,
  ImportSource,
} from "shared/types";
import { db } from "../db";
import { generateId } from "../utils";

type ImportRecordRow = typeof importRecords.$inferSelect;

const IMPORT_SOURCES: ReadonlySet<string> = new Set<ImportSource>([
  "claude-code",
  "codex",
  "gemini",
  "cc-switch",
  "opencode",
  "cursor",
  "vscode",
  "claude-desktop",
  "continue",
  "file",
]);

const IMPORT_KINDS: ReadonlySet<string> = new Set<ImportKind>([
  "local",
  "backup",
  "chatgpt",
  "claude-export",
]);

const IMPORT_PART_TYPES: ReadonlySet<string> = new Set<ImportPartType>([
  "conversations",
  "mcp",
  "skills",
  "instructions",
  "prompts",
  "credentials",
  "channels",
  "projects",
  "scheduledTasks",
  "settings",
  "attachments",
]);

const IMPORT_PART_LINK_KINDS: ReadonlySet<string> = new Set<ImportPartLinkKind>([
  "conversation",
  "mcp",
  "skill",
  "channel",
  "project",
  "settings-tab",
  "prompt",
]);

function isImportPartLinkKind(value: unknown): value is ImportPartLinkKind {
  return typeof value === "string" && IMPORT_PART_LINK_KINDS.has(value);
}

export function isImportSource(value: unknown): value is ImportSource {
  return typeof value === "string" && IMPORT_SOURCES.has(value);
}

export function isImportKind(value: unknown): value is ImportKind {
  return typeof value === "string" && IMPORT_KINDS.has(value);
}

// ---------------------------------------------------------------------------
// User-facing detail / note text written into import records. `status` is a
// separate field, so these never restate "imported" / "skipped"; they only add
// what the status alone does not say. Every server-side importer reads from
// this table — no inline copy elsewhere.
// ---------------------------------------------------------------------------

export const IMPORT_DETAIL = {
  /** `{count}` = message count. */
  messageCount: (count: number) => `${count} 条消息`,
  /** Conversation part note: total messages written across imported conversations. */
  messagesNote: (count: number) => `共 ${count} 条消息`,
  /** Prefix on a conversation that already existed and was re-imported from a newer source file. */
  updated: "已更新",
  unchanged: "已导入且无变化",
  noImportableMessages: "无可导入消息（空会话、子代理或 OpenHorn 自产）",
  alreadyExists: "已存在",
  mcpSameName: "同名 MCP 已存在",
  mcpVerifyBeforeEnable: "启用前请确认命令与环境变量",
  channelKeyMissing: "缺少 API Key，需补填",
  projectFolderMissing: (rootPath: string) => `目录不存在：${rootPath}`,
  attachmentMissing: "备份中缺少该文件",
  scheduledTaskDisabled: "已导入，默认禁用",
  fileNotFound: "文件不存在",
  fileEmpty: "文件为空",
  instructionsReplaced: "已替换此前导入的段落",
  instructionsAppended: "已追加到系统提示词",
  promptEmptyBody: "正文为空",
  promptUpdated: "已更新此前导入的模板",
} as const;

// ---------------------------------------------------------------------------
// Part builder — shared by every importer so counters and the ≤200 item cap
// are applied the same way everywhere.
// ---------------------------------------------------------------------------

export function createPart(type: ImportPartType, note?: string): ImportPart {
  return { type, imported: 0, skipped: 0, needsAction: 0, ...(note ? { note } : {}), items: [] };
}

/** Bumps the matching counter and appends the item unless the cap is reached. */
export function addPartItem(part: ImportPart, item: ImportPartItem): void {
  if (item.status === "imported") part.imported++;
  else if (item.status === "skipped") part.skipped++;
  else part.needsAction++;
  if (part.items.length < IMPORT_PART_ITEMS_LIMIT) part.items.push(item);
}

function sumParts(parts: ImportPart[]): { totalImported: number; totalNeedsAction: number } {
  let totalImported = 0;
  let totalNeedsAction = 0;
  for (const part of parts) {
    totalImported += part.imported;
    totalNeedsAction += part.needsAction;
  }
  return { totalImported, totalNeedsAction };
}

// ---------------------------------------------------------------------------
// Validation of client-supplied parts (POST /import/records)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function sanitizeItem(raw: unknown): ImportPartItem | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.label !== "string" || !raw.label) return null;
  const status = raw.status;
  if (status !== "imported" && status !== "skipped" && status !== "needsAction") return null;
  const item: ImportPartItem = { label: raw.label, status };
  if (typeof raw.detail === "string" && raw.detail) item.detail = raw.detail;
  if (isRecord(raw.link) && isImportPartLinkKind(raw.link.kind)) {
    item.link = { kind: raw.link.kind };
    if (typeof raw.link.id === "string") item.link.id = raw.link.id;
  }
  return item;
}

export function sanitizeParts(raw: unknown): ImportPart[] {
  if (!Array.isArray(raw)) return [];
  const parts: ImportPart[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    if (typeof entry.type !== "string" || !IMPORT_PART_TYPES.has(entry.type)) continue;
    const part = createPart(entry.type as ImportPartType);
    if (typeof entry.note === "string" && entry.note) part.note = entry.note;
    part.imported = toNonNegativeInt(entry.imported);
    part.skipped = toNonNegativeInt(entry.skipped);
    part.needsAction = toNonNegativeInt(entry.needsAction);
    if (Array.isArray(entry.items)) {
      for (const rawItem of entry.items.slice(0, IMPORT_PART_ITEMS_LIMIT)) {
        const item = sanitizeItem(rawItem);
        if (item) part.items.push(item);
      }
    }
    parts.push(part);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toRecord(row: ImportRecordRow): ImportRecord {
  // Part types can be retired (e.g. the former `messages` part). Rows written
  // before that keep such parts in JSON; drop them on read and re-derive the
  // totals the same way createImportRecord does, so old rows count like new ones.
  const parts = parseJsonArray<ImportPart>(row.parts).filter(
    (part) => isRecord(part) && typeof part.type === "string" && IMPORT_PART_TYPES.has(part.type),
  );
  const totals = sumParts(parts);
  return {
    id: row.id,
    userId: row.userId,
    source: row.source as ImportSource,
    kind: row.kind as ImportKind,
    parts,
    errors: parseJsonArray<string>(row.errors),
    totalImported: totals.totalImported,
    totalNeedsAction: totals.totalNeedsAction,
    createdAt: row.createdAt,
  };
}

export async function createImportRecord(
  userId: string,
  input: CreateImportRecordInput,
): Promise<ImportRecord> {
  if (!isImportSource(input.source)) throw new Error("invalid import source");
  if (!isImportKind(input.kind)) throw new Error("invalid import kind");

  const parts = input.parts;
  const errors = Array.isArray(input.errors)
    ? input.errors.filter((e): e is string => typeof e === "string")
    : [];
  const totals = sumParts(parts);
  const row: ImportRecordRow = {
    id: generateId(),
    userId,
    source: input.source,
    kind: input.kind,
    parts: JSON.stringify(parts),
    errors: JSON.stringify(errors),
    totalImported: totals.totalImported,
    totalNeedsAction: totals.totalNeedsAction,
    createdAt: new Date(),
  };
  await db.insert(importRecords).values(row);
  return toRecord(row);
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Cursor = `<createdAtMs>:<id>` of the last record on the previous page. */
function encodeCursor(record: ImportRecord): string {
  return `${record.createdAt.getTime()}:${record.id}`;
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.indexOf(":");
  if (idx <= 0) return null;
  const ms = Number(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (!Number.isFinite(ms) || !id) return null;
  return { createdAt: new Date(ms), id };
}

export async function listImportRecords(
  userId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<ImportRecordListResult> {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT),
  );
  const cursor = decodeCursor(options.cursor);

  const where = cursor
    ? and(
        eq(importRecords.userId, userId),
        or(
          lt(importRecords.createdAt, cursor.createdAt),
          and(eq(importRecords.createdAt, cursor.createdAt), lt(importRecords.id, cursor.id)),
        ),
      )
    : eq(importRecords.userId, userId);

  const rows = await db
    .select()
    .from(importRecords)
    .where(where)
    .orderBy(desc(importRecords.createdAt), desc(importRecords.id))
    .limit(limit + 1);

  const records = rows.slice(0, limit).map(toRecord);
  const result: ImportRecordListResult = { records };
  if (rows.length > limit && records.length > 0) {
    result.nextCursor = encodeCursor(records[records.length - 1]);
  }
  return result;
}

export async function getImportRecord(
  userId: string,
  recordId: string,
): Promise<ImportRecord | null> {
  const rows = await db
    .select()
    .from(importRecords)
    .where(and(eq(importRecords.id, recordId), eq(importRecords.userId, userId)))
    .limit(1);
  return rows.length > 0 ? toRecord(rows[0]) : null;
}

export async function deleteImportRecord(userId: string, recordId: string): Promise<boolean> {
  const existing = await getImportRecord(userId, recordId);
  if (!existing) return false;
  await db
    .delete(importRecords)
    .where(and(eq(importRecords.id, recordId), eq(importRecords.userId, userId)));
  return true;
}
