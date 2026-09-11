/**
 * Data import service — restores from .openhorn-backup.zip or imports
 * conversations from ChatGPT / Claude.ai export files.
 *
 * Merge strategy (backup): rows are matched by id / natural key and existing
 * rows are always kept — an incoming row with the same key is skipped, never
 * merged or replaced. Conversations dedupe on id (their messages/attachments
 * only come along with a newly inserted conversation); channels on
 * (name, provider) and are inserted without an apiKey; projects on rootPath;
 * MCP servers on name; settings on key. Scheduled tasks are inserted disabled.
 *
 * Every import writes an `import_records` row (source `file`) and stamps the
 * conversations / MCP servers it created with `imported_from` / `imported_at`.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  attachments,
  channelModels,
  channels,
  conversations,
  mcpServers,
  messages,
  projects,
  scheduledTasks,
  settings,
} from "db";
import { and, eq } from "drizzle-orm";
import type { ImportKind, ImportPart } from "shared/types";
import yauzl from "yauzl";
import { db } from "../db";
import type { ExportManifest } from "./exportService";
import { addPartItem, createImportRecord, createPart, IMPORT_DETAIL } from "./importRecordsService";

const FILE_IMPORT_SOURCE = "file";

export interface ImportResult {
  format: "openhorn" | "chatgpt" | "claude";
  conversations: { imported: number; skipped: number };
  messages: { imported: number };
  attachments: { imported: number; missing: number };
  channels: { imported: number; skipped: number; needsKey: number };
  projects: { imported: number; needsRebind: number };
  mcpServers: { imported: number; skipped: number; needsConfirm: number };
  scheduledTasks: { imported: number };
  errors: string[];
  /** Id of the `import_records` row written for this run (absent when nothing could be parsed). */
  recordId?: string;
}

function emptyResult(format: ImportResult["format"]): ImportResult {
  return {
    format,
    conversations: { imported: 0, skipped: 0 },
    messages: { imported: 0 },
    attachments: { imported: 0, missing: 0 },
    channels: { imported: 0, skipped: 0, needsKey: 0 },
    projects: { imported: 0, needsRebind: 0 },
    mcpServers: { imported: 0, skipped: 0, needsConfirm: 0 },
    scheduledTasks: { imported: 0 },
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Import history — per-item detail collected while importing, then written as
// one `import_records` row. Kept on a small collector so the counters in
// ImportResult (the shape the existing UI dialog reads) stay untouched.
// ---------------------------------------------------------------------------

const IMPORT_KIND_BY_FORMAT: Record<ImportResult["format"], ImportKind> = {
  openhorn: "backup",
  chatgpt: "chatgpt",
  claude: "claude-export",
};

class PartCollector {
  private readonly parts = new Map<ImportPart["type"], ImportPart>();

  part(type: ImportPart["type"]): ImportPart {
    let part = this.parts.get(type);
    if (!part) {
      part = createPart(type);
      this.parts.set(type, part);
    }
    return part;
  }

  add(type: ImportPart["type"], item: Parameters<typeof addPartItem>[1]): void {
    addPartItem(this.part(type), item);
  }

  /** Count-only bump for parts that have no meaningful per-item label (attachments). */
  count(type: ImportPart["type"], field: "imported" | "skipped" | "needsAction", n = 1): void {
    this.part(type)[field] += n;
  }

  /** Messages are not a part: their total rides on the conversations part as a note. */
  noteMessages(count: number): void {
    if (count > 0) this.part("conversations").note = IMPORT_DETAIL.messagesNote(count);
  }

  list(): ImportPart[] {
    return Array.from(this.parts.values());
  }
}

async function finishImport(
  userId: string,
  result: ImportResult,
  collector: PartCollector,
): Promise<ImportResult> {
  const parts = collector.list();
  if (parts.length === 0 && result.errors.length === 0) return result;
  try {
    const record = await createImportRecord(userId, {
      source: FILE_IMPORT_SOURCE,
      kind: IMPORT_KIND_BY_FORMAT[result.format],
      parts,
      errors: result.errors,
    });
    result.recordId = record.id;
  } catch (error) {
    result.errors.push(
      `import record not written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Backup rows come out of JSON with ISO-string timestamps; Drizzle's
// `integer({ mode: "timestamp" })` columns need Date instances (it calls
// `.getTime()`), so every row is revived before insert.
// ---------------------------------------------------------------------------

const TIMESTAMP_FIELDS = [
  "createdAt",
  "updatedAt",
  "lastSummarizedAt",
  "lastRunAt",
  "nextRunAt",
  "importedAt",
] as const;

function reviveDates<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const field of TIMESTAMP_FIELDS) {
    const value = out[field];
    if (value === undefined || value === null || value instanceof Date) continue;
    const parsed = typeof value === "number" ? new Date(value) : new Date(String(value));
    out[field] = Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// ZIP extraction helpers
// ---------------------------------------------------------------------------

async function extractZipEntries(zipPath: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err || new Error("Failed to open zip"));
      const entries = new Map<string, Buffer>();
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            zipfile.readEntry();
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.on("error", reject);
    });
  });
}

function parseJsonEntry<T>(entries: Map<string, Buffer>, name: string): T | null {
  const buf = entries.get(name);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export type DetectedFormat = "openhorn" | "chatgpt" | "claude" | "unknown";

export async function detectFormat(filePath: string): Promise<DetectedFormat> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".zip") {
    const entries = await extractZipEntries(filePath);
    if (entries.has("manifest.json")) return "openhorn";
    if (entries.has("conversations.json")) {
      const raw = entries.get("conversations.json")?.toString("utf8").trim() ?? "";
      if (!raw) return "unknown";
      if (raw.startsWith("[")) {
        const first = JSON.parse(raw)[0];
        if (first?.mapping) return "chatgpt";
        if (first?.chat_messages) return "claude";
      }
    }
    return "unknown";
  }

  if (ext === ".json") {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : null;
    if (!arr || arr.length === 0) return "unknown";
    if (arr[0]?.mapping) return "chatgpt";
    if (arr[0]?.chat_messages) return "claude";
    return "unknown";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// OpenHorn backup import
// ---------------------------------------------------------------------------

export async function importOpenHornBackup(userId: string, zipPath: string): Promise<ImportResult> {
  const result = emptyResult("openhorn");
  const collector = new PartCollector();
  const importedAt = new Date();
  const entries = await extractZipEntries(zipPath);

  const manifest = parseJsonEntry<ExportManifest>(entries, "manifest.json");
  if (!manifest) {
    result.errors.push("manifest.json 缺失或解析失败");
    return result;
  }

  // --- Conversations ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const convRows = parseJsonEntry<any[]>(entries, "conversations.json") ?? [];
  const existingConvIds = new Set(
    (
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.userId, userId))
    ).map((r) => r.id),
  );

  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const msgRows = parseJsonEntry<any[]>(entries, "messages.json") ?? [];
  const messageCountByConv = new Map<string, number>();
  for (const msg of msgRows) {
    const convId = String(msg.conversationId);
    messageCountByConv.set(convId, (messageCountByConv.get(convId) ?? 0) + 1);
  }

  for (const conv of convRows) {
    if (existingConvIds.has(conv.id)) {
      result.conversations.skipped++;
      collector.add("conversations", {
        label: String(conv.title ?? conv.id),
        detail: IMPORT_DETAIL.alreadyExists,
        status: "skipped",
        link: { kind: "conversation", id: String(conv.id) },
      });
      continue;
    }
    await db
      .insert(conversations)
      .values({ ...reviveDates(conv), userId, importedFrom: FILE_IMPORT_SOURCE, importedAt });
    result.conversations.imported++;
    collector.add("conversations", {
      label: String(conv.title ?? conv.id),
      detail: IMPORT_DETAIL.messageCount(messageCountByConv.get(String(conv.id)) ?? 0),
      status: "imported",
      link: { kind: "conversation", id: String(conv.id) },
    });
  }

  // --- Messages ---
  const importedConvIds = new Set(
    convRows
      .filter((c: { id: string }) => !existingConvIds.has(c.id))
      .map((c: { id: string }) => c.id),
  );
  for (const msg of msgRows) {
    if (!importedConvIds.has(msg.conversationId)) continue;
    await db.insert(messages).values(reviveDates(msg));
    result.messages.imported++;
  }
  collector.noteMessages(result.messages.imported);

  // --- Attachments ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const attRows = parseJsonEntry<any[]>(entries, "attachments.json") ?? [];
  const uploadsDir = path.join(process.cwd(), "data", "uploads");
  await mkdir(uploadsDir, { recursive: true });

  for (const att of attRows) {
    if (!importedConvIds.has(att.conversationId)) continue;
    const ext = path.extname(att.fileName || "") || "";
    const zipEntryName = `attachments/${att.id}${ext}`;
    const fileData = entries.get(zipEntryName);
    if (fileData) {
      const localName = `imported-${att.id}${ext}`;
      const localPath = path.join(uploadsDir, localName);
      await writeFile(localPath, fileData);
      await db
        .insert(attachments)
        .values({ ...reviveDates(att), userId, filePath: `uploaded:${localName}` });
      result.attachments.imported++;
      collector.count("attachments", "imported");
    } else {
      result.attachments.missing++;
      collector.add("attachments", {
        label: String(att.fileName ?? att.id),
        detail: IMPORT_DETAIL.attachmentMissing,
        status: "skipped",
      });
    }
  }

  // --- Channels (no apiKey) ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const channelRows = parseJsonEntry<any[]>(entries, "channels.json") ?? [];
  for (const ch of channelRows) {
    const existing = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.userId, userId),
          eq(channels.name, ch.name),
          eq(channels.provider, ch.provider),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      result.channels.skipped++;
      collector.add("channels", {
        label: String(ch.name),
        detail: IMPORT_DETAIL.alreadyExists,
        status: "skipped",
        link: { kind: "channel", id: existing[0].id },
      });
      continue;
    }
    await db.insert(channels).values({ ...reviveDates(ch), userId, apiKey: "" });
    result.channels.imported++;
    result.channels.needsKey++;
    collector.add("channels", {
      label: String(ch.name),
      detail: IMPORT_DETAIL.channelKeyMissing,
      status: "needsAction",
      link: { kind: "channel", id: String(ch.id) },
    });
  }

  // --- Channel Models ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const modelRows = parseJsonEntry<any[]>(entries, "channel-models.json") ?? [];
  for (const m of modelRows) {
    try {
      await db.insert(channelModels).values(reviveDates(m));
    } catch {
      // skip if channel doesn't exist or duplicate
    }
  }

  // --- Projects ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const projectRows = parseJsonEntry<any[]>(entries, "projects.json") ?? [];
  for (const p of projectRows) {
    const existing = await db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), eq(projects.rootPath, p.rootPath)))
      .limit(1);
    if (existing.length > 0) {
      result.projects.imported++;
      collector.add("projects", {
        label: String(p.name ?? p.rootPath),
        detail: IMPORT_DETAIL.alreadyExists,
        status: "skipped",
        link: { kind: "project", id: existing[0].id },
      });
      continue;
    }
    let pathExists = false;
    try {
      await stat(p.rootPath);
      pathExists = true;
    } catch {
      // path doesn't exist on this machine
    }
    await db.insert(projects).values({ ...reviveDates(p), userId });
    result.projects.imported++;
    if (!pathExists) result.projects.needsRebind++;
    collector.add("projects", {
      label: String(p.name ?? p.rootPath),
      detail: pathExists
        ? String(p.rootPath)
        : IMPORT_DETAIL.projectFolderMissing(String(p.rootPath)),
      status: pathExists ? "imported" : "needsAction",
      link: { kind: "project", id: String(p.id) },
    });
  }

  // --- MCP Servers ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const mcpRows = parseJsonEntry<any[]>(entries, "mcp-servers.json") ?? [];
  for (const m of mcpRows) {
    const existing = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(eq(mcpServers.userId, userId), eq(mcpServers.name, String(m.name))))
      .limit(1);
    if (existing.length > 0) {
      result.mcpServers.skipped++;
      collector.add("mcp", {
        label: String(m.name),
        detail: IMPORT_DETAIL.mcpSameName,
        status: "skipped",
        link: { kind: "mcp", id: existing[0].id },
      });
      continue;
    }
    await db
      .insert(mcpServers)
      .values({ ...reviveDates(m), userId, importedFrom: FILE_IMPORT_SOURCE, importedAt });
    result.mcpServers.imported++;
    result.mcpServers.needsConfirm++;
    collector.add("mcp", {
      label: String(m.name),
      detail: IMPORT_DETAIL.mcpVerifyBeforeEnable,
      status: "needsAction",
      link: { kind: "mcp", id: String(m.id) },
    });
  }

  // --- Scheduled Tasks ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const taskRows = parseJsonEntry<any[]>(entries, "scheduled-tasks.json") ?? [];
  for (const t of taskRows) {
    await db.insert(scheduledTasks).values({ ...reviveDates(t), userId, enabled: false });
    result.scheduledTasks.imported++;
    collector.add("scheduledTasks", {
      label: String(t.title ?? t.id),
      detail: IMPORT_DETAIL.scheduledTaskDisabled,
      status: "imported",
    });
  }

  // --- Settings ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const settingRows = parseJsonEntry<any[]>(entries, "settings.json") ?? [];
  for (const s of settingRows) {
    const existing = await db
      .select()
      .from(settings)
      .where(and(eq(settings.userId, userId), eq(settings.key, s.key)))
      .limit(1);
    if (existing.length > 0) {
      collector.add("settings", { label: String(s.key), status: "skipped" });
      continue;
    }
    await db.insert(settings).values({ ...reviveDates(s), userId });
    collector.add("settings", { label: String(s.key), status: "imported" });
  }

  return finishImport(userId, result, collector);
}

// ---------------------------------------------------------------------------
// ChatGPT import
// ---------------------------------------------------------------------------

interface ChatGPTConversation {
  title?: string;
  create_time?: number;
  update_time?: number;
  mapping?: Record<
    string,
    {
      id: string;
      parent?: string | null;
      children?: string[];
      message?: {
        id: string;
        author: { role: string };
        // biome-ignore lint/suspicious/noExplicitAny: ChatGPT export parts can be string or object
        content: { content_type: string; parts?: any[] };
        metadata?: { model_slug?: string };
        create_time?: number;
      } | null;
    }
  >;
  current_node?: string;
}

function linearizeChatGPT(
  conv: ChatGPTConversation,
): { role: string; content: string; model: string | null; createdAt: Date }[] {
  if (!conv.mapping || !conv.current_node) return [];

  const chain: string[] = [];
  let nodeId: string | null | undefined = conv.current_node;
  while (nodeId && conv.mapping[nodeId]) {
    chain.unshift(nodeId);
    nodeId = conv.mapping[nodeId].parent;
  }

  const result: { role: string; content: string; model: string | null; createdAt: Date }[] = [];
  for (const id of chain) {
    const node = conv.mapping[id];
    const msg = node?.message;
    if (!msg || !msg.author) continue;
    const role = msg.author.role;
    if (role !== "user" && role !== "assistant") continue;

    let content = "";
    if (msg.content?.parts) {
      content = msg.content.parts.filter((p: unknown) => typeof p === "string").join("\n");
    }
    if (!content.trim()) continue;

    result.push({
      role,
      content,
      model: msg.metadata?.model_slug ?? null,
      createdAt: new Date((msg.create_time ?? conv.create_time ?? Date.now() / 1000) * 1000),
    });
  }
  return result;
}

export async function importChatGPT(userId: string, filePath: string): Promise<ImportResult> {
  const result = emptyResult("chatgpt");
  const collector = new PartCollector();
  const importedAt = new Date();

  let convs: ChatGPTConversation[];
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".zip") {
    const entries = await extractZipEntries(filePath);
    const raw = entries.get("conversations.json");
    if (!raw) {
      result.errors.push("ZIP 中未找到 conversations.json");
      return result;
    }
    convs = JSON.parse(raw.toString("utf8"));
  } else {
    convs = JSON.parse(await readFile(filePath, "utf8"));
  }

  for (const conv of convs) {
    const linearMessages = linearizeChatGPT(conv);
    if (linearMessages.length === 0) continue;

    const convId = crypto.randomUUID();
    const convCreatedAt = new Date((conv.create_time ?? Date.now() / 1000) * 1000);

    const title = conv.title || "ChatGPT 导入";
    await db.insert(conversations).values({
      id: convId,
      userId,
      title,
      contextLength: 4096,
      defaultMode: "chat",
      lastMode: "chat",
      isPinned: false,
      importedFrom: FILE_IMPORT_SOURCE,
      importedAt,
      createdAt: convCreatedAt,
      updatedAt: new Date((conv.update_time ?? conv.create_time ?? Date.now() / 1000) * 1000),
    });
    result.conversations.imported++;
    collector.add("conversations", {
      label: title,
      detail: IMPORT_DETAIL.messageCount(linearMessages.length),
      status: "imported",
      link: { kind: "conversation", id: convId },
    });

    for (const msg of linearMessages) {
      await db.insert(messages).values({
        id: crypto.randomUUID(),
        conversationId: convId,
        role: msg.role,
        content: msg.content,
        model: msg.model,
        createdAt: msg.createdAt,
      });
      result.messages.imported++;
    }
  }
  collector.noteMessages(result.messages.imported);

  return finishImport(userId, result, collector);
}

// ---------------------------------------------------------------------------
// Claude import
// ---------------------------------------------------------------------------

interface ClaudeConversation {
  uuid?: string;
  name?: string;
  model?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: {
    uuid?: string;
    text?: string;
    sender?: string;
    content?: { type: string; text?: string }[];
    created_at?: string;
  }[];
}

export async function importClaude(userId: string, filePath: string): Promise<ImportResult> {
  const result = emptyResult("claude");
  const collector = new PartCollector();
  const importedAt = new Date();

  let convs: ClaudeConversation[];
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".zip") {
    const entries = await extractZipEntries(filePath);
    const raw = entries.get("conversations.json");
    if (!raw) {
      result.errors.push("ZIP 中未找到 conversations.json");
      return result;
    }
    convs = JSON.parse(raw.toString("utf8"));
  } else {
    convs = JSON.parse(await readFile(filePath, "utf8"));
  }

  for (const conv of convs) {
    const chatMessages = conv.chat_messages ?? [];
    if (chatMessages.length === 0) continue;

    const convId = crypto.randomUUID();
    const now = new Date();

    const title = conv.name || "Claude 导入";
    await db.insert(conversations).values({
      id: convId,
      userId,
      title,
      contextLength: 4096,
      defaultMode: "chat",
      lastMode: "chat",
      isPinned: false,
      importedFrom: FILE_IMPORT_SOURCE,
      importedAt,
      createdAt: conv.created_at ? new Date(conv.created_at) : now,
      updatedAt: conv.updated_at ? new Date(conv.updated_at) : now,
    });
    result.conversations.imported++;
    let importedMessages = 0;

    for (const msg of chatMessages) {
      const role =
        msg.sender === "human" ? "user" : msg.sender === "assistant" ? "assistant" : null;
      if (!role) continue;

      let content = msg.text ?? "";
      if (!content && msg.content) {
        content = msg.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n");
      }
      if (!content.trim()) continue;

      await db.insert(messages).values({
        id: crypto.randomUUID(),
        conversationId: convId,
        role,
        content,
        model: conv.model ?? null,
        createdAt: msg.created_at ? new Date(msg.created_at) : now,
      });
      result.messages.imported++;
      importedMessages++;
    }
    collector.add("conversations", {
      label: title,
      detail: IMPORT_DETAIL.messageCount(importedMessages),
      status: "imported",
      link: { kind: "conversation", id: convId },
    });
  }
  collector.noteMessages(result.messages.imported);

  return finishImport(userId, result, collector);
}
